import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  DurableMemoryEntry,
  KnowledgeDocumentIndexEntry,
  LoggerLike,
  RawMessage,
  SummaryEntry,
} from "../types";
import { ContextPlannerResult } from "../engines/ContextPlanner";

const nodeRequire = createRequire(__filename);

type SQLiteValue = string | number | bigint | null;

interface SQLiteStatementLike {
  run(...params: SQLiteValue[]): unknown;
  get(...params: SQLiteValue[]): Record<string, unknown> | undefined;
  all(...params: SQLiteValue[]): Array<Record<string, unknown>>;
}

interface SQLiteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatementLike;
  close(): void;
}

type SQLiteDatabaseCtor = new (location: string) => SQLiteDatabaseLike;

interface RuntimeStoreOptions {
  dbPath: string;
  agentId: string;
  knowledgeBaseDir: string;
  logger: LoggerLike;
}

export interface RuntimeContextRunRecord {
  id: string;
  sessionId: string;
  agentId: string;
  createdAt: string;
  intent: string;
  totalBudget: number;
  selectedTokens: number;
  selectedCount: number;
  rejectedCount: number;
  metadata?: Record<string, unknown>;
}

export interface OmsGrepHit {
  message: RawMessage;
  before: RawMessage[];
  after: RawMessage[];
  score: number;
}

export interface OmsTraceEdge {
  sourceKind: string;
  sourceId: string;
  relation: string;
  targetKind: string;
  targetId: string;
  metadata: Record<string, unknown>;
}

export interface OmsExpandResult {
  target: Record<string, unknown> | null;
  messages: RawMessage[];
  summaries: SummaryEntry[];
  edges: OmsTraceEdge[];
}

interface RuntimeDatabaseModule {
  DatabaseSync?: SQLiteDatabaseCtor;
}

export class SQLiteRuntimeStore {
  private db: SQLiteDatabaseLike | null = null;
  private initPromise: Promise<void> | null = null;
  private enabled = false;
  private schemaReady = false;
  private ftsReady = false;

  constructor(private readonly options: RuntimeStoreOptions) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  getPath(): string {
    return this.options.dbPath;
  }

  async init(): Promise<void> {
    if (this.initPromise) {
      return await this.initPromise;
    }
    this.initPromise = this.initOnce();
    return await this.initPromise;
  }

  async mirror(args: {
    messages: RawMessage[];
    summaries: SummaryEntry[];
    memories: DurableMemoryEntry[];
  }): Promise<void> {
    await this.init();
    if (!this.openDatabase()) {
      return;
    }
    try {
      for (const message of args.messages) {
        this.upsertMessage(message);
      }
      for (const summary of args.summaries) {
        this.upsertSummary(summary);
      }
      for (const memory of args.memories) {
        this.upsertMemory(memory);
      }
      await this.mirrorAssetsFromMarkdownIndex();
      this.rebuildSourceEdges(args.summaries, args.memories);
    } finally {
      this.closeDatabase();
    }
  }

  recordContextPlan(args: {
    sessionId: string;
    agentId: string;
    totalBudget: number;
    intent: string;
    plan: ContextPlannerResult;
  }): void {
    if (!this.openDatabase()) {
      return;
    }
    try {
      this.db?.prepare(`
      INSERT INTO context_runs (
        id, session_id, agent_id, created_at, intent, total_budget,
        selected_tokens, selected_count, rejected_count, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        selected_tokens=excluded.selected_tokens,
        selected_count=excluded.selected_count,
        rejected_count=excluded.rejected_count,
        metadata_json=excluded.metadata_json
      `).run(
      args.plan.runId,
      args.sessionId,
      args.agentId,
      args.plan.createdAt,
      args.intent,
      args.totalBudget,
      args.plan.selectedTokens,
      args.plan.selected.length,
      args.plan.rejected.length,
      this.stringify({ candidateCount: args.plan.candidateCount, budget: args.plan.budget }),
      );

      this.db?.prepare("DELETE FROM retrieval_candidates WHERE context_run_id = ?").run(args.plan.runId);
      const insert = this.db?.prepare(`
      INSERT INTO retrieval_candidates (
        id, context_run_id, source, authority, target_kind, target_id,
        status, score, token_count, reasons_json, rejected_reason, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let index = 0;
      for (const selected of args.plan.selected) {
        index += 1;
        insert?.run(
        `${args.plan.runId}:selected:${index}:${this.hash(selected.id).slice(0, 8)}`,
        args.plan.runId,
        selected.source,
        selected.authority,
        this.itemTargetKind(selected.item),
        this.itemTargetId(selected.item),
        "selected",
        selected.score,
        selected.item.tokenCount,
        this.stringify(selected.reasons),
        null,
        this.stringify({ contentPreview: selected.item.content.slice(0, 240), metadata: selected.item.metadata ?? {} }),
        );
      }
      for (const rejected of args.plan.rejected) {
        index += 1;
        insert?.run(
        `${args.plan.runId}:rejected:${index}:${this.hash(rejected.id).slice(0, 8)}`,
        args.plan.runId,
        rejected.source,
        rejected.authority,
        "context_item",
        rejected.id,
        "rejected",
        rejected.score,
        rejected.tokenCount,
        this.stringify(rejected.reasons),
        rejected.rejectedReason,
        this.stringify({}),
        );
      }
    } finally {
      this.closeDatabase();
    }
  }

  grepMessages(query: string, options: { sessionId?: string; limit?: number; contextTurns?: number } = {}): OmsGrepHit[] {
    if (!query.trim() || !this.openDatabase()) {
      return [];
    }
    try {
      const limit = Math.max(Math.min(options.limit ?? 10, 50), 1);
      const contextTurns = Math.max(Math.min(options.contextTurns ?? 1, 5), 0);
      const terms = this.queryTerms(query);
      if (terms.length === 0) {
        return [];
      }

      const ftsScored = this.searchMessagesFts(query, terms, options.sessionId, limit * 2);
      const rows = ftsScored.length >= limit
        ? []
        : this.db?.prepare(`
      SELECT * FROM messages
      WHERE (? IS NULL OR session_id = ?)
      ORDER BY sequence ASC, turn_number ASC, created_at ASC
      `).all(options.sessionId ?? null, options.sessionId ?? null) ?? [];
      const scanScored = rows
        .map((row) => ({ message: this.rowToMessage(row), score: this.scoreText(String(row.content ?? ""), terms) }))
        .filter((item) => item.score > 0);
      const byId = new Map<string, { message: RawMessage; score: number }>();
      for (const item of [...ftsScored, ...scanScored]) {
        const existing = byId.get(item.message.id);
        if (!existing || item.score > existing.score) {
          byId.set(item.message.id, item);
        }
      }
      const scored = [...byId.values()]
        .sort((left, right) => right.score - left.score || (left.message.sequence ?? 0) - (right.message.sequence ?? 0))
        .slice(0, limit);

      return scored.map((item) => ({
        message: item.message,
        score: item.score,
        before: this.getMessagesByTurnWindow(item.message.sessionId, item.message.turnNumber - contextTurns, item.message.turnNumber - 1),
        after: this.getMessagesByTurnWindow(item.message.sessionId, item.message.turnNumber + 1, item.message.turnNumber + contextTurns),
      }));
    } finally {
      this.closeDatabase();
    }
  }

  private searchMessagesFts(
    query: string,
    terms: string[],
    sessionId: string | undefined,
    limit: number,
  ): Array<{ message: RawMessage; score: number }> {
    if (!this.db) {
      return [];
    }
    try {
      this.ensureFtsSchema();
      this.populateMessagesFtsIfEmpty();
      const matchQuery = this.toFtsMatchQuery(query, terms);
      if (!matchQuery) {
        return [];
      }
      return this.db.prepare(`
        SELECT m.*, bm25(messages_fts) AS fts_score
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.id
        WHERE messages_fts MATCH ?
          AND (? IS NULL OR m.session_id = ?)
        ORDER BY fts_score ASC, m.sequence ASC, m.turn_number ASC
        LIMIT ?
      `).all(matchQuery, sessionId ?? null, sessionId ?? null, limit)
        .map((row) => {
          const message = this.rowToMessage(row);
          const lexical = this.scoreText(message.content, terms);
          const bm25 = Number(row.fts_score ?? 0);
          return {
            message,
            score: lexical + Math.max(0, Math.round(12 - bm25)),
          };
        });
    } catch (error) {
      this.options.logger.debug?.("sqlite_runtime_fts_query_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  replay(options: { sessionId?: string; startTurn?: number; endTurn?: number; limit?: number } = {}): RawMessage[] {
    if (!this.openDatabase()) {
      return [];
    }
    try {
      const limit = Math.max(Math.min(options.limit ?? 200, 1000), 1);
      return this.db?.prepare(`
      SELECT * FROM messages
      WHERE (? IS NULL OR session_id = ?)
        AND (? IS NULL OR turn_number >= ?)
        AND (? IS NULL OR turn_number <= ?)
      ORDER BY turn_number ASC, sequence ASC, created_at ASC
      LIMIT ?
      `).all(
        options.sessionId ?? null,
        options.sessionId ?? null,
        options.startTurn ?? null,
        options.startTurn ?? null,
        options.endTurn ?? null,
        options.endTurn ?? null,
        limit,
      ).map((row) => this.rowToMessage(row)) ?? [];
    } finally {
      this.closeDatabase();
    }
  }

  expand(kind: string, id: string): OmsExpandResult {
    if (!this.openDatabase()) {
      return { target: null, messages: [], summaries: [], edges: [] };
    }
    try {
      const normalizedKind = this.normalizeKind(kind, id);
      const target = this.lookupTarget(normalizedKind, id);
      const edges = this.traceEdges(normalizedKind, id);
      const messageIds = new Set<string>();
      const summaryIds = new Set<string>();

      if (normalizedKind === "message") {
        messageIds.add(id);
      }
      for (const edge of edges) {
        if (edge.targetKind === "message") {
          messageIds.add(edge.targetId);
        }
        if (edge.targetKind === "summary") {
          summaryIds.add(edge.targetId);
          for (const nested of this.traceEdges("summary", edge.targetId)) {
            if (nested.targetKind === "message") {
              messageIds.add(nested.targetId);
            }
            if (nested.targetKind === "summary") {
              summaryIds.add(nested.targetId);
            }
          }
        }
      }

      return {
        target,
        messages: this.getMessagesByIds([...messageIds]),
        summaries: this.getSummariesByIds([...summaryIds]),
        edges,
      };
    } finally {
      this.closeDatabase();
    }
  }

  trace(kind: string, id: string): OmsTraceEdge[] {
    if (!this.openDatabase()) {
      return [];
    }
    try {
      const normalizedKind = this.normalizeKind(kind, id);
      return this.traceEdges(normalizedKind, id);
    } finally {
      this.closeDatabase();
    }
  }

  private traceEdges(kind: string, id: string): OmsTraceEdge[] {
    return this.db?.prepare(`
      SELECT * FROM source_edges
      WHERE source_kind = ? AND source_id = ?
      ORDER BY relation ASC, target_kind ASC, target_id ASC
    `).all(kind, id).map((row) => ({
      sourceKind: String(row.source_kind ?? ""),
      sourceId: String(row.source_id ?? ""),
      relation: String(row.relation ?? ""),
      targetKind: String(row.target_kind ?? ""),
      targetId: String(row.target_id ?? ""),
      metadata: this.parseObject(row.metadata_json),
    })) ?? [];
  }

  getLatestContextRuns(limit = 5): RuntimeContextRunRecord[] {
    if (!this.openDatabase()) {
      return [];
    }
    try {
      return this.db?.prepare(`
      SELECT * FROM context_runs
      ORDER BY created_at DESC
      LIMIT ?
      `).all(Math.max(Math.min(limit, 50), 1)).map((row) => ({
        id: String(row.id ?? ""),
        sessionId: String(row.session_id ?? ""),
        agentId: String(row.agent_id ?? ""),
        createdAt: String(row.created_at ?? ""),
        intent: String(row.intent ?? ""),
        totalBudget: Number(row.total_budget ?? 0),
        selectedTokens: Number(row.selected_tokens ?? 0),
        selectedCount: Number(row.selected_count ?? 0),
        rejectedCount: Number(row.rejected_count ?? 0),
        metadata: this.parseObject(row.metadata_json),
      })) ?? [];
    } finally {
      this.closeDatabase();
    }
  }

  private async initOnce(): Promise<void> {
    const DatabaseSync = this.loadSQLite();
    if (!DatabaseSync) {
      this.options.logger.warn("sqlite_runtime_disabled", {
        reason: "node_sqlite_unavailable",
      });
      return;
    }

    await mkdir(path.dirname(this.options.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.options.dbPath);
    this.enabled = true;
    this.configureDatabase();
    this.createSchema();
    this.schemaReady = true;
    this.closeDatabase();
  }

  private openDatabase(): boolean {
    if (this.db) {
      return true;
    }
    const DatabaseSync = this.loadSQLite();
    if (!DatabaseSync) {
      return false;
    }
    this.db = new DatabaseSync(this.options.dbPath);
    this.enabled = true;
    this.configureDatabase();
    if (!this.schemaReady) {
      this.createSchema();
      this.schemaReady = true;
    }
    return true;
  }

  private closeDatabase(): void {
    if (!this.db) {
      return;
    }
    try {
      this.db.close();
    } finally {
      this.db = null;
    }
  }

  private loadSQLite(): SQLiteDatabaseCtor | null {
    try {
      const sqlite = nodeRequire("node:sqlite") as RuntimeDatabaseModule;
      return sqlite.DatabaseSync ?? null;
    } catch {
      return null;
    }
  }

  private configureDatabase(): void {
    if (!this.db) {
      return;
    }
    try {
      this.db.exec("PRAGMA journal_mode = DELETE;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
    } catch (error) {
      this.options.logger.warn("sqlite_runtime_pragma_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private createSchema(): void {
    if (!this.db) {
      return;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        sequence INTEGER,
        created_at TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        compacted INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_turn ON messages(session_id, turn_number, sequence);
      CREATE INDEX IF NOT EXISTS idx_messages_agent_session ON messages(agent_id, session_id);

      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        project_id TEXT,
        topic_id TEXT,
        record_status TEXT,
        summary TEXT NOT NULL,
        keywords_json TEXT NOT NULL DEFAULT '[]',
        start_turn INTEGER NOT NULL,
        end_turn INTEGER NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        source_hash TEXT,
        source_message_count INTEGER,
        source_binding_json TEXT NOT NULL DEFAULT '{}',
        parent_summary_ids_json TEXT NOT NULL DEFAULT '[]',
        child_summary_ids_json TEXT NOT NULL DEFAULT '[]',
        source_summary_ids_json TEXT NOT NULL DEFAULT '[]',
        summary_level INTEGER,
        node_kind TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_session_turn ON summaries(session_id, start_turn, end_turn);
      CREATE INDEX IF NOT EXISTS idx_summaries_project ON summaries(project_id, record_status);

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        project_id TEXT,
        topic_id TEXT,
        kind TEXT NOT NULL,
        record_status TEXT,
        text TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_project_status ON memories(project_id, record_status);

      CREATE TABLE IF NOT EXISTS assets (
        doc_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        bucket TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        origin TEXT NOT NULL,
        status TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        linked_summary_ids_json TEXT NOT NULL DEFAULT '[]',
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        latest_file TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status, bucket);

      CREATE TABLE IF NOT EXISTS source_edges (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        session_id TEXT,
        agent_id TEXT,
        project_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_source_edges_source ON source_edges(source_kind, source_id);
      CREATE INDEX IF NOT EXISTS idx_source_edges_target ON source_edges(target_kind, target_id);

      CREATE TABLE IF NOT EXISTS context_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        intent TEXT NOT NULL,
        total_budget INTEGER NOT NULL,
        selected_tokens INTEGER NOT NULL,
        selected_count INTEGER NOT NULL,
        rejected_count INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_context_runs_session_created ON context_runs(session_id, created_at);

      CREATE TABLE IF NOT EXISTS retrieval_candidates (
        id TEXT PRIMARY KEY,
        context_run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        authority TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT,
        status TEXT NOT NULL,
        score REAL NOT NULL,
        token_count INTEGER NOT NULL,
        reasons_json TEXT NOT NULL DEFAULT '[]',
        rejected_reason TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_run ON retrieval_candidates(context_run_id, status);
    `);

    // FTS is deliberately lazy. Exact/LIKE search remains canonical today, so
    // boot and normal mirroring should not pay virtual-table setup or refresh
    // costs until a future semantic/FTS path explicitly enables it.
  }

  private createFtsTable(tableName: string, columns: string): void {
    try {
      this.db?.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING fts5(${columns});`);
    } catch (error) {
      this.options.logger.warn("sqlite_runtime_fts_unavailable", {
        tableName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private upsertMessage(message: RawMessage): void {
    this.db?.prepare(`
      INSERT INTO messages (
        id, session_id, agent_id, role, content, turn_number, sequence,
        created_at, token_count, compacted, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id=excluded.session_id,
        agent_id=excluded.agent_id,
        role=excluded.role,
        content=excluded.content,
        turn_number=excluded.turn_number,
        sequence=excluded.sequence,
        created_at=excluded.created_at,
        token_count=excluded.token_count,
        compacted=excluded.compacted,
        metadata_json=excluded.metadata_json
    `).run(
      message.id,
      message.sessionId,
      message.agentId ?? null,
      message.role,
      message.content,
      message.turnNumber,
      Number.isFinite(message.sequence) ? message.sequence as number : null,
      message.createdAt,
      message.tokenCount,
      message.compacted ? 1 : 0,
      this.stringify(message.metadata ?? {}),
    );
    this.refreshFts("messages_fts", "id", message.id, [message.content]);
  }

  private ensureFtsSchema(): void {
    if (this.ftsReady) {
      return;
    }
    this.createFtsTable("messages_fts", "id UNINDEXED, content");
    this.createFtsTable("memories_fts", "id UNINDEXED, text");
    this.createFtsTable("assets_fts", "doc_id UNINDEXED, title, summary");
    this.ftsReady = true;
  }

  private populateMessagesFtsIfEmpty(): void {
    if (!this.db) {
      return;
    }
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS count FROM messages_fts").get();
      if (Number(row?.count ?? 0) > 0) {
        return;
      }
      this.db.prepare("INSERT INTO messages_fts (id, content) SELECT id, content FROM messages").run();
    } catch (error) {
      this.options.logger.debug?.("sqlite_runtime_fts_populate_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private toFtsMatchQuery(query: string, terms: string[]): string {
    const ftsTerms = terms
      .map((term) => term.toLowerCase().replace(/[^a-z0-9]+/g, ""))
      .filter((term) => term.length >= 2)
      .slice(0, 8);
    if (ftsTerms.length === 0) {
      return "";
    }
    const phrase = query
      .toLowerCase()
      .replace(/^history\s+recall\s*:\s*/i, "")
      .replace(/"/g, " ")
      .trim()
      .split(/\s+/)
      .filter((term) => /^[a-z0-9]+$/.test(term))
      .slice(0, 6)
      .join(" ");
    const disjunction = ftsTerms.map((term) => `${term}*`).join(" OR ");
    return phrase.length >= 6
      ? `"${phrase}" OR ${disjunction}`
      : disjunction;
  }

  private upsertSummary(summary: SummaryEntry): void {
    this.db?.prepare(`
      INSERT INTO summaries (
        id, session_id, agent_id, project_id, topic_id, record_status,
        summary, keywords_json, start_turn, end_turn, token_count, created_at,
        source_hash, source_message_count, source_binding_json,
        parent_summary_ids_json, child_summary_ids_json, source_summary_ids_json,
        summary_level, node_kind, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id=excluded.session_id,
        agent_id=excluded.agent_id,
        project_id=excluded.project_id,
        topic_id=excluded.topic_id,
        record_status=excluded.record_status,
        summary=excluded.summary,
        keywords_json=excluded.keywords_json,
        start_turn=excluded.start_turn,
        end_turn=excluded.end_turn,
        token_count=excluded.token_count,
        created_at=excluded.created_at,
        source_hash=excluded.source_hash,
        source_message_count=excluded.source_message_count,
        source_binding_json=excluded.source_binding_json,
        parent_summary_ids_json=excluded.parent_summary_ids_json,
        child_summary_ids_json=excluded.child_summary_ids_json,
        source_summary_ids_json=excluded.source_summary_ids_json,
        summary_level=excluded.summary_level,
        node_kind=excluded.node_kind,
        payload_json=excluded.payload_json
    `).run(
      summary.id,
      summary.sessionId,
      summary.agentId ?? null,
      summary.projectId ?? null,
      summary.topicId ?? null,
      summary.recordStatus ?? "active",
      summary.summary,
      this.stringify(summary.keywords ?? []),
      summary.startTurn,
      summary.endTurn,
      summary.tokenCount,
      summary.createdAt,
      summary.sourceHash ?? null,
      typeof summary.sourceMessageCount === "number" ? summary.sourceMessageCount : null,
      this.stringify(summary.sourceBinding ?? {}),
      this.stringify(summary.parentSummaryIds ?? (summary.parentSummaryId ? [summary.parentSummaryId] : [])),
      this.stringify(summary.childSummaryIds ?? []),
      this.stringify(summary.sourceSummaryIds ?? []),
      summary.summaryLevel ?? 1,
      summary.nodeKind ?? "leaf",
      this.stringify(summary),
    );
  }

  private upsertMemory(memory: DurableMemoryEntry): void {
    this.db?.prepare(`
      INSERT INTO memories (
        id, session_id, agent_id, project_id, topic_id, kind, record_status,
        text, tags_json, source_ids_json, created_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id=excluded.session_id,
        agent_id=excluded.agent_id,
        project_id=excluded.project_id,
        topic_id=excluded.topic_id,
        kind=excluded.kind,
        record_status=excluded.record_status,
        text=excluded.text,
        tags_json=excluded.tags_json,
        source_ids_json=excluded.source_ids_json,
        created_at=excluded.created_at,
        payload_json=excluded.payload_json
    `).run(
      memory.id,
      memory.sessionId,
      memory.agentId ?? null,
      memory.projectId ?? null,
      memory.topicId ?? null,
      memory.kind,
      memory.recordStatus ?? "active",
      memory.text,
      this.stringify(memory.tags ?? []),
      this.stringify(memory.sourceIds ?? []),
      memory.createdAt,
      this.stringify(memory),
    );
    this.refreshFts("memories_fts", "id", memory.id, [memory.text, memory.tags.join(" ")]);
  }

  private async mirrorAssetsFromMarkdownIndex(): Promise<void> {
    if (!this.db) {
      return;
    }
    const indexPath = path.join(this.options.knowledgeBaseDir, "indexes", "document-index.json");
    try {
      const parsed = JSON.parse(await readFile(indexPath, "utf8")) as { documents?: KnowledgeDocumentIndexEntry[] } | KnowledgeDocumentIndexEntry[];
      const documents = Array.isArray(parsed) ? parsed : parsed.documents;
      if (!Array.isArray(documents)) {
        return;
      }
      for (const document of documents) {
        this.upsertAsset(document);
      }
    } catch {
      // Markdown assets may not exist yet; runtime mirror remains usable for raw/summary/memory.
    }
  }

  private upsertAsset(asset: KnowledgeDocumentIndexEntry): void {
    this.db?.prepare(`
      INSERT INTO assets (
        doc_id, slug, bucket, title, summary, canonical_key, origin, status,
        tags_json, linked_summary_ids_json, source_refs_json, latest_file,
        updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET
        slug=excluded.slug,
        bucket=excluded.bucket,
        title=excluded.title,
        summary=excluded.summary,
        canonical_key=excluded.canonical_key,
        origin=excluded.origin,
        status=excluded.status,
        tags_json=excluded.tags_json,
        linked_summary_ids_json=excluded.linked_summary_ids_json,
        source_refs_json=excluded.source_refs_json,
        latest_file=excluded.latest_file,
        updated_at=excluded.updated_at,
        payload_json=excluded.payload_json
    `).run(
      asset.docId,
      asset.slug,
      asset.bucket,
      asset.title,
      asset.summary,
      asset.canonicalKey,
      asset.origin,
      asset.status,
      this.stringify(asset.tags ?? []),
      this.stringify(asset.linkedSummaryIds ?? []),
      this.stringify(asset.sourceRefs ?? []),
      asset.latestFile,
      asset.updatedAt,
      this.stringify(asset),
    );
    this.refreshFts("assets_fts", "doc_id", asset.docId, [asset.title, asset.summary, asset.tags.join(" ")]);
  }

  private rebuildSourceEdges(summaries: SummaryEntry[], memories: DurableMemoryEntry[]): void {
    if (!this.db) {
      return;
    }
    this.db.prepare("DELETE FROM source_edges").run();
    for (const summary of summaries) {
      const messageIds = [
        ...(summary.sourceBinding?.messageIds ?? []),
        ...(summary.sourceMessageIds ?? []),
      ];
      for (const messageId of [...new Set(messageIds)]) {
        this.insertEdge("summary", summary.id, "derived_from", "message", messageId, {
          sessionId: summary.sessionId,
          agentId: summary.agentId,
          projectId: summary.projectId,
          sourceHash: summary.sourceHash,
        });
      }
      for (const sourceSummaryId of [...new Set(summary.sourceSummaryIds ?? [])]) {
        this.insertEdge("summary", summary.id, "derived_from", "summary", sourceSummaryId, {
          sessionId: summary.sessionId,
          agentId: summary.agentId,
          projectId: summary.projectId,
        });
      }
      for (const childSummaryId of [...new Set(summary.childSummaryIds ?? [])]) {
        this.insertEdge("summary", summary.id, "has_child", "summary", childSummaryId, {
          sessionId: summary.sessionId,
          agentId: summary.agentId,
          projectId: summary.projectId,
        });
      }
    }

    for (const memory of memories) {
      for (const sourceId of [...new Set(memory.sourceIds ?? [])]) {
        this.insertEdge("memory", memory.id, "derived_from", this.targetKindForSourceId(sourceId), sourceId, {
          sessionId: memory.sessionId,
          agentId: memory.agentId,
          projectId: memory.projectId,
          sourceType: memory.sourceType,
        });
      }
    }

    const assetRows = this.db.prepare("SELECT payload_json FROM assets").all();
    for (const row of assetRows) {
      const asset = this.parseObject(row.payload_json) as unknown as KnowledgeDocumentIndexEntry;
      if (!asset.docId) {
        continue;
      }
      for (const summaryId of asset.linkedSummaryIds ?? []) {
        this.insertEdge("asset", asset.docId, "derived_from", "summary", summaryId, {
          bucket: asset.bucket,
        });
      }
      for (const ref of asset.sourceRefs ?? []) {
        this.insertEdge("asset", asset.docId, "has_source_ref", "source_ref", ref, {
          bucket: asset.bucket,
          origin: asset.origin,
        });
      }
    }
  }

  private insertEdge(
    sourceKind: string,
    sourceId: string,
    relation: string,
    targetKind: string,
    targetId: string,
    metadata: { sessionId?: string; agentId?: string; projectId?: string | null; [key: string]: unknown },
  ): void {
    if (!targetId) {
      return;
    }
    const id = this.hash(`${sourceKind}:${sourceId}:${relation}:${targetKind}:${targetId}`);
    this.db?.prepare(`
      INSERT INTO source_edges (
        id, source_kind, source_id, relation, target_kind, target_id,
        session_id, agent_id, project_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json
    `).run(
      id,
      sourceKind,
      sourceId,
      relation,
      targetKind,
      targetId,
      typeof metadata.sessionId === "string" ? metadata.sessionId : null,
      typeof metadata.agentId === "string" ? metadata.agentId : null,
      typeof metadata.projectId === "string" ? metadata.projectId : null,
      this.stringify(metadata),
    );
  }

  private refreshFts(tableName: string, idColumn: string, id: string, fields: string[]): void {
    if (!this.ftsReady) {
      return;
    }
    try {
      this.ensureFtsSchema();
      this.db?.prepare(`DELETE FROM ${tableName} WHERE ${idColumn} = ?`).run(id);
      if (tableName === "assets_fts") {
        this.db?.prepare("INSERT INTO assets_fts (doc_id, title, summary) VALUES (?, ?, ?)")
          .run(id, fields[0] ?? "", fields.slice(1).join(" "));
      } else if (tableName === "memories_fts") {
        this.db?.prepare("INSERT INTO memories_fts (id, text) VALUES (?, ?)")
          .run(id, fields.join(" "));
      } else {
        this.db?.prepare("INSERT INTO messages_fts (id, content) VALUES (?, ?)")
          .run(id, fields.join(" "));
      }
    } catch {
      // FTS is an optimization only; LIKE-based runtime search remains canonical.
    }
  }

  private getMessagesByTurnWindow(sessionId: string, startTurn: number, endTurn: number): RawMessage[] {
    if (!this.db || endTurn < startTurn) {
      return [];
    }
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND turn_number >= ? AND turn_number <= ?
      ORDER BY turn_number ASC, sequence ASC, created_at ASC
    `).all(sessionId, startTurn, endTurn).map((row) => this.rowToMessage(row));
  }

  private getMessagesByIds(ids: string[]): RawMessage[] {
    if (!this.db || ids.length === 0) {
      return [];
    }
    const wanted = new Set(ids);
    return this.db.prepare("SELECT * FROM messages ORDER BY turn_number ASC, sequence ASC, created_at ASC")
      .all()
      .map((row) => this.rowToMessage(row))
      .filter((message) => wanted.has(message.id));
  }

  private getSummariesByIds(ids: string[]): SummaryEntry[] {
    if (!this.db || ids.length === 0) {
      return [];
    }
    const wanted = new Set(ids);
    return this.db.prepare("SELECT payload_json FROM summaries ORDER BY start_turn ASC, end_turn ASC")
      .all()
      .map((row) => this.parseObject(row.payload_json) as unknown as SummaryEntry)
      .filter((summary) => wanted.has(summary.id));
  }

  private lookupTarget(kind: string, id: string): Record<string, unknown> | null {
    if (!this.db) {
      return null;
    }
    switch (kind) {
      case "message": {
        const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
        return row ? this.rowToMessage(row) as unknown as Record<string, unknown> : null;
      }
      case "summary": {
        const row = this.db.prepare("SELECT payload_json FROM summaries WHERE id = ?").get(id);
        return row ? this.parseObject(row.payload_json) : null;
      }
      case "memory": {
        const row = this.db.prepare("SELECT payload_json FROM memories WHERE id = ?").get(id);
        return row ? this.parseObject(row.payload_json) : null;
      }
      case "asset": {
        const row = this.db.prepare("SELECT payload_json FROM assets WHERE doc_id = ?").get(id);
        return row ? this.parseObject(row.payload_json) : null;
      }
      default:
        return null;
    }
  }

  private rowToMessage(row: Record<string, unknown>): RawMessage {
    return {
      id: String(row.id ?? ""),
      sessionId: String(row.session_id ?? ""),
      agentId: typeof row.agent_id === "string" ? row.agent_id : undefined,
      role: this.normalizeRole(row.role),
      content: String(row.content ?? ""),
      turnNumber: Number(row.turn_number ?? 0),
      sequence: Number.isFinite(Number(row.sequence)) ? Number(row.sequence) : undefined,
      createdAt: String(row.created_at ?? ""),
      tokenCount: Number(row.token_count ?? 0),
      compacted: Number(row.compacted ?? 0) === 1,
      metadata: this.parseObject(row.metadata_json),
    };
  }

  private normalizeKind(kind: string, id: string): string {
    const normalized = kind.trim().toLowerCase();
    if (["message", "summary", "memory", "asset"].includes(normalized)) {
      return normalized;
    }
    if (id.startsWith("memory-")) {
      return "memory";
    }
    if (id.includes("summary") || id.startsWith("s-")) {
      return "summary";
    }
    return "message";
  }

  private normalizeRole(value: unknown): RawMessage["role"] {
    return value === "system" || value === "user" || value === "assistant" || value === "tool"
      ? value
      : "user";
  }

  private targetKindForSourceId(sourceId: string): string {
    if (sourceId.startsWith("memory-")) {
      return "memory";
    }
    if (sourceId.startsWith("summary") || sourceId.includes("summary")) {
      return "summary";
    }
    if (sourceId.startsWith("observation")) {
      return "observation";
    }
    return "message";
  }

  private itemTargetKind(item: ContextPlannerResult["selected"][number]["item"]): string {
    if (item.kind === "message") {
      return "message";
    }
    if (item.summaryId) {
      return "summary";
    }
    if (typeof item.metadata?.memoryId === "string") {
      return "memory";
    }
    if (typeof item.metadata?.docId === "string") {
      return "asset";
    }
    return "context_item";
  }

  private itemTargetId(item: ContextPlannerResult["selected"][number]["item"]): string | null {
    if (item.summaryId) {
      return item.summaryId;
    }
    if (typeof item.metadata?.messageId === "string") {
      return item.metadata.messageId;
    }
    if (typeof item.metadata?.memoryId === "string") {
      return item.metadata.memoryId;
    }
    if (typeof item.metadata?.docId === "string") {
      return item.metadata.docId;
    }
    return null;
  }

  private queryTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
  }

  private scoreText(text: string, terms: string[]): number {
    const haystack = text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += term.length >= 6 ? 3 : 2;
      }
    }
    if (terms.length > 0 && terms.every((term) => haystack.includes(term))) {
      score += 4;
    }
    return score;
  }

  private stringify(value: unknown): string {
    return JSON.stringify(value ?? null);
  }

  private parseObject(value: unknown): Record<string, unknown> {
    if (typeof value !== "string" || !value.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}
