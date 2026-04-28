import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  MemoryItemDraftEntry,
  EvidenceAtomEntry,
  KnowledgeDocumentIndexEntry,
  KnowledgeRawEntry,
  LoggerLike,
  MemoryItemEntry,
  MemoryItemKind,
  MemoryItemScope,
  MemoryItemStability,
  RawMessage,
  SourceSpanRef,
  SummaryEntry,
} from "../types";
import { ContextPlannerResult } from "../engines/ContextPlanner";

const nodeRequire = createRequire(__filename);

const SQLITE_RUNTIME_STOP_WORDS = new Set([
  "a", "about", "again", "an", "and", "answer", "any", "are", "as", "at",
  "before", "between", "both", "by", "can", "could", "current", "did", "do",
  "does", "earlier", "exact", "for", "from", "had", "has", "have", "he",
  "her", "hers", "him", "his", "history", "how", "i", "in", "is", "it",
  "latest", "many", "me", "memory", "my", "near", "of", "on", "or",
  "previous", "question", "recall", "recent", "recently", "she", "source",
  "status", "that", "the", "their", "them", "there", "these", "they", "this",
  "to", "was", "were", "what", "when", "where", "which", "who", "whom",
  "whose", "why", "with", "would", "you", "your",
]);

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
  journalMode?: "delete" | "wal";
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

export interface RuntimeTableCounts {
  messages: number;
  summaries: number;
  evidenceAtoms: number;
  memories: number;
  memoryItems: number;
  runtimeRecords: number;
  assets: number;
  sourceEdges: number;
  traceEdges: number;
  runtimeAnnotations: number;
  contextRuns: number;
  retrievalCandidates: number;
}

export interface RuntimeStoreStatus {
  enabled: boolean;
  dbPath: string;
  ftsReady: boolean;
  ftsStatus: "unavailable" | "lazy_not_initialized" | "ready";
  adapter: "node:sqlite" | "unavailable";
  experimentalAdapter: boolean;
  journalMode: "delete" | "wal";
  counts: RuntimeTableCounts;
}

export interface RuntimeRecordEntry<T extends Record<string, unknown> = Record<string, unknown>> {
  kind: string;
  id: string;
  sessionId?: string;
  agentId?: string;
  createdAt: string;
  updatedAt: string;
  payload: T;
}

export interface RuntimeIntegrityReport extends RuntimeStoreStatus {
  ok: boolean;
  errors: string[];
  warnings: string[];
  orphanEdges: number;
  summariesWithoutSource: number;
  selectedCandidatesWithoutTarget: number;
}

export interface RuntimeCandidateRecord {
  id: string;
  contextRunId: string;
  source: string;
  authority: string;
  targetKind: string;
  targetId: string | null;
  status: "selected" | "rejected";
  score: number;
  tokenCount: number;
  reasons: string[];
  rejectedReason: string | null;
  payload: Record<string, unknown>;
}

export interface RuntimeContextRunInspection {
  run: RuntimeContextRunRecord | null;
  selected: RuntimeCandidateRecord[];
  rejected: RuntimeCandidateRecord[];
}

export interface RuntimeWhyRecalledReport {
  query: string | null;
  targetId: string | null;
  inspectedRunId: string | null;
  matches: RuntimeCandidateRecord[];
  latestRun: RuntimeContextRunRecord | null;
  explanation: string;
}

export interface RuntimeKnowledgeGovernanceReport {
  totalAssets: number;
  activeAssets: number;
  draftAssets: number;
  supersededAssets: number;
  duplicateCanonicalKeys: Array<{ canonicalKey: string; count: number; docIds: string[] }>;
  assetsWithoutProvenance: Array<{ docId: string; title: string; status: string }>;
  warnings: string[];
}

export interface RuntimeAssetSyncReport {
  ok: boolean;
  mode: "sync" | "reindex";
  indexedAssets: number;
  sqliteAssetsBefore: number;
  sqliteAssetsAfter: number;
  pruned: number;
  warnings: string[];
}

export interface RuntimePurgeReport {
  ok: boolean;
  scope: "session" | "agent";
  target: string;
  deleted: Record<string, number>;
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

export interface RuntimeAssemblyReader {
  getSummaryCount(sessionId?: string): number;
  getActiveMemoryItems(limit?: number): MemoryItemEntry[];
  getSummaries(budget: number, sessionId?: string): SummaryEntry[];
  getRecentTailByTokens(tokenBudget: number, maxTurns: number, sessionId?: string): RawMessage[];
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
  private readonly statementCache = new Map<string, SQLiteStatementLike>();

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
    memories: MemoryItemDraftEntry[];
    atoms?: EvidenceAtomEntry[];
  }): Promise<void> {
    await this.init();
    if (!this.openDatabase()) {
      return;
    }
    let transactionStarted = false;
    try {
      this.db?.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      for (const message of args.messages) {
        this.upsertMessage(message);
      }
      for (const summary of args.summaries) {
        this.upsertSummary(summary);
      }
      this.deleteMemoryItemsFromSourceTables(["memory_item_drafts", "summary_evidence_drafts"]);
      for (const memory of args.memories) {
        this.upsertMemoryItem(this.memoryItemFromDraft(memory));
      }
      for (const atom of args.atoms ?? []) {
        this.upsertMemoryItem(this.memoryItemFromEvidenceAtom(atom));
      }
      await this.mirrorAssetsFromMarkdownIndex();
      this.rebuildSourceEdges(args.summaries, args.memories, args.atoms ?? []);
      this.db?.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.db?.exec("ROLLBACK");
        } catch {
          // Preserve the original mirror failure.
        }
      }
      throw error;
    } finally {
      this.closeDatabase();
    }
  }

  async recordRawMessage(message: RawMessage): Promise<boolean> {
    await this.init();
    if (!this.openDatabase()) {
      return false;
    }
    try {
      this.upsertMessage(message);
      return true;
    } finally {
      this.closeDatabase();
    }
  }

  async recordRawMessages(messages: RawMessage[]): Promise<boolean> {
    if (messages.length === 0) {
      return true;
    }
    await this.init();
    if (!this.openDatabase()) {
      return false;
    }
    let transactionStarted = false;
    try {
      this.db?.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      for (const message of messages) {
        this.upsertMessage(message);
      }
      this.db?.exec("COMMIT");
      transactionStarted = false;
      return true;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.db?.exec("ROLLBACK");
        } catch {
          // Preserve the original write failure.
        }
      }
      throw error;
    } finally {
      this.closeDatabase();
    }
  }

  async recordSummaries(summaries: SummaryEntry[]): Promise<boolean> {
    if (summaries.length === 0) {
      return true;
    }
    await this.init();
    if (!this.openDatabase()) {
      return false;
    }
    let transactionStarted = false;
    try {
      this.db?.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      for (const summary of summaries) {
        this.upsertSummary(summary);
        this.upsertSummarySourceEdges(summary);
      }
      this.db?.exec("COMMIT");
      transactionStarted = false;
      return true;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.db?.exec("ROLLBACK");
        } catch {
          // Preserve the original write failure.
        }
      }
      throw error;
    } finally {
      this.closeDatabase();
    }
  }

  async recordMemories(memories: MemoryItemDraftEntry[]): Promise<boolean> {
    if (memories.length === 0) {
      return true;
    }
    await this.init();
    if (!this.openDatabase()) {
      return false;
    }
    let transactionStarted = false;
    try {
      this.db?.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      for (const memory of memories) {
        const memoryItem = this.memoryItemFromDraft(memory);
        this.upsertMemoryItem(memoryItem);
        this.upsertMemoryItemSourceEdges(memoryItem);
      }
      this.db?.exec("COMMIT");
      transactionStarted = false;
      return true;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.db?.exec("ROLLBACK");
        } catch {
          // Preserve the original write failure.
        }
      }
      throw error;
    } finally {
      this.closeDatabase();
    }
  }


  withAssemblyRead<T>(reader: (runtime: RuntimeAssemblyReader) => T): T | null {
    if (!this.openDatabase()) {
      return null;
    }
    try {
      return reader({
        getSummaryCount: (sessionId) => this.readAssemblySummaryCount(sessionId),
        getActiveMemoryItems: (limit) => this.readAssemblyActiveMemoryItems(limit),
        getSummaries: (budget, sessionId) => this.readAssemblySummaries(budget, sessionId),
        getRecentTailByTokens: (tokenBudget, maxTurns, sessionId) =>
          this.readAssemblyRecentTailByTokens(tokenBudget, maxTurns, sessionId),
      });
    } finally {
      this.closeDatabase();
    }
  }

  getAssemblySummaryCount(sessionId?: string): number {
    return this.withAssemblyRead((runtime) => runtime.getSummaryCount(sessionId)) ?? 0;
  }

  getAssemblyActiveMemoryItems(limit = 8): MemoryItemEntry[] {
    return this.withAssemblyRead((runtime) => runtime.getActiveMemoryItems(limit)) ?? [];
  }

  getAssemblySummaries(budget: number, sessionId?: string): SummaryEntry[] {
    return this.withAssemblyRead((runtime) => runtime.getSummaries(budget, sessionId)) ?? [];
  }

  getAssemblyRecentTailByTokens(tokenBudget: number, maxTurns: number, sessionId?: string): RawMessage[] {
    return this.withAssemblyRead((runtime) =>
      runtime.getRecentTailByTokens(tokenBudget, maxTurns, sessionId)) ?? [];
  }

  private readAssemblySummaryCount(sessionId?: string): number {
    if (!this.db) {
      return 0;
    }
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM summaries
      WHERE (? IS NULL OR session_id = ?)
    `).get(sessionId ?? null, sessionId ?? null)?.count ?? 0);
  }

  private readAssemblyActiveMemoryItems(limit = 8): MemoryItemEntry[] {
    if (!this.db) {
      return [];
    }
    return this.db.prepare(`
      SELECT payload_json FROM memory_items
      WHERE status = 'active'
        AND context_policy != 'never'
      ORDER BY priority ASC, updated_at DESC, created_at DESC
      LIMIT ?
    `).all(Math.max(Math.min(limit, 50), 1))
      .map((row) => this.normalizeMemoryItemEntry(this.parseObject(row.payload_json) as unknown as MemoryItemEntry));
  }

  private readAssemblySummaries(budget: number, sessionId?: string): SummaryEntry[] {
    if (budget <= 0 || !this.db) {
      return [];
    }
    const allActive = this.db.prepare(`
      SELECT payload_json FROM summaries
      WHERE record_status = 'active'
        AND (? IS NULL OR session_id = ?)
      ORDER BY end_turn DESC, start_turn DESC
    `).all(sessionId ?? null, sessionId ?? null)
      .map((row) => this.parseObject(row.payload_json) as unknown as SummaryEntry);
    const roots = allActive.filter((entry) => (
      !entry.parentSummaryId &&
      (!Array.isArray(entry.parentSummaryIds) || entry.parentSummaryIds.length === 0)
    ));
    const branchRoots = roots.filter((entry) => entry.nodeKind === "branch" || (entry.summaryLevel ?? 1) > 1);
    const source = branchRoots;
    const selected: SummaryEntry[] = [];
    let consumed = 0;
    for (const summary of source) {
      const tokenCount = Math.max(summary.tokenCount, 0);
      if (consumed + tokenCount > budget) {
        break;
      }
      consumed += tokenCount;
      selected.unshift(summary);
    }
    return selected;
  }

  private readAssemblyRecentTailByTokens(tokenBudget: number, maxTurns: number, sessionId?: string): RawMessage[] {
    if (tokenBudget <= 0 || maxTurns <= 0 || !this.db) {
      return [];
    }
    const turnRows = this.db.prepare(`
      SELECT DISTINCT turn_number FROM messages
      WHERE (? IS NULL OR session_id = ?)
      ORDER BY turn_number DESC
      LIMIT ?
    `).all(sessionId ?? null, sessionId ?? null, Math.max(maxTurns, 1));
    const turnNumbersDesc = turnRows.map((row) => Number(row.turn_number)).filter((value) => Number.isFinite(value));
    if (turnNumbersDesc.length === 0) {
      return [];
    }
    const turnNumbers = [...turnNumbersDesc].reverse();
    const messages = this.getMessagesByTurns(turnNumbers, sessionId);
    const selectedTurns: number[] = [];
    let consumed = 0;
    for (let index = turnNumbers.length - 1; index >= 0; index -= 1) {
      const turnNumber = turnNumbers[index];
      const turnTokens = messages
        .filter((message) => message.turnNumber === turnNumber)
        .reduce((sum, message) => sum + message.tokenCount, 0);
      if (selectedTurns.length > 0 && consumed + turnTokens > tokenBudget) {
        break;
      }
      selectedTurns.unshift(turnNumber);
      consumed += turnTokens;
      if (selectedTurns.length >= maxTurns) {
        break;
      }
    }
    const selected = new Set(selectedTurns);
    return messages.filter((message) => selected.has(message.turnNumber));
  }

  recordContextPlan(args: {
    sessionId: string;
    agentId: string;
    totalBudget: number;
    intent: string;
    plan: ContextPlannerResult;
    metadata?: Record<string, unknown>;
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
      this.stringify({
        candidateCount: args.plan.candidateCount,
        budget: args.plan.budget,
        ...(args.metadata ?? {}),
      }),
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
        this.itemTargetId(selected.item, selected.id),
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
      for (const step of this.readProgressivePlannerSteps(args.metadata)) {
        index += 1;
        insert?.run(
          `${args.plan.runId}:planner-step:${index}:${String(step.stepIndex ?? index)}`,
          args.plan.runId,
          "llm_planner",
          "scheduler",
          "planner_step",
          typeof step.plannerRunId === "string"
            ? `${step.plannerRunId}:step:${String(step.stepIndex ?? index)}`
            : `${args.plan.runId}:step:${String(step.stepIndex ?? index)}`,
          step.stopTriggered === true ? "selected" : "rejected",
          Number.isFinite(Number(step.candidatesFound)) ? Number(step.candidatesFound) : 0,
          Number.isFinite(Number(step.budgetTokens)) ? Number(step.budgetTokens) : 0,
          this.stringify([
            `planner_layer:${String(step.layer ?? "")}`,
            `planner_action:${String(step.action ?? "")}`,
            String(step.reason ?? ""),
            ...(Array.isArray(step.rejectedReasons)
              ? step.rejectedReasons.filter((item): item is string => typeof item === "string")
              : []),
          ].filter(Boolean)),
          step.stopTriggered === true ? null : String(step.stopReason ?? "progressive_step_not_terminal"),
          this.stringify(step),
        );
      }
    } finally {
      this.closeDatabase();
    }
  }

  private readProgressivePlannerSteps(metadata?: Record<string, unknown>): Array<Record<string, unknown>> {
    const steps = metadata?.progressiveRetrievalSteps;
    return Array.isArray(steps)
      ? steps.filter((step): step is Record<string, unknown> =>
        Boolean(step) && typeof step === "object" && !Array.isArray(step))
      : [];
  }

  grepMessages(query: string, options: { sessionId?: string; limit?: number; contextTurns?: number } = {}): OmsGrepHit[] {
    if (!query.trim() || !this.openDatabase()) {
      return [];
    }
    try {
      const limit = Math.max(Math.min(options.limit ?? 10, 200), 1);
      const contextTurns = Math.max(Math.min(options.contextTurns ?? 1, 5), 0);
      const terms = this.queryTerms(query);
      if (terms.length === 0) {
        return [];
      }

      const ftsScored = this.searchMessagesFts(query, terms, options.sessionId, limit * 2);
      // FTS is only an anchor accelerator. It must never become a hard recall gate:
      // long histories often contain many generic FTS hits that can crowd out the
      // exact source turn. Always merge a deterministic term scan so raw recall
      // keeps lossless behavior even when BM25 is noisy.
      const rows = this.db?.prepare(`
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
      const matchQueries = this.toFtsMatchQueries(query, terms);
      if (matchQueries.length === 0) {
        return [];
      }
      const statement = this.db.prepare(`
        SELECT m.*, bm25(messages_fts) AS fts_score
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.id
        WHERE messages_fts MATCH ?
          AND (? IS NULL OR m.session_id = ?)
        ORDER BY fts_score ASC, m.sequence ASC, m.turn_number ASC
        LIMIT ?
      `);
      const byId = new Map<string, { message: RawMessage; score: number }>();
      for (const matchQuery of matchQueries) {
        const rows = statement.all(matchQuery, sessionId ?? null, sessionId ?? null, limit);
        for (const row of rows) {
          const message = this.rowToMessage(row);
          const lexical = this.scoreText(message.content, terms);
          const bm25 = Number(row.fts_score ?? 0);
          const scored = {
            message,
            score: lexical + Math.max(0, Math.round(12 - bm25)),
          };
          const existing = byId.get(message.id);
          if (!existing || scored.score > existing.score) {
            byId.set(message.id, scored);
          }
        }
        if (byId.size >= limit) {
          break;
        }
      }
      return [...byId.values()]
        .sort((left, right) => right.score - left.score || (left.message.sequence ?? 0) - (right.message.sequence ?? 0))
        .slice(0, limit);
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
      const normalizedId = this.normalizeTargetId(normalizedKind, id);
      const target = this.lookupTarget(normalizedKind, normalizedId);
      const edges = this.traceEdgesRecursive(normalizedKind, normalizedId, 5);
      const messageIds = new Set<string>();
      const summaryIds = new Set<string>();

      if (normalizedKind === "message") {
        messageIds.add(normalizedId);
      }
      for (const edge of edges) {
        if (edge.targetKind === "message") {
          messageIds.add(edge.targetId);
        }
        if (edge.targetKind === "summary") {
          summaryIds.add(edge.targetId);
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
      return this.traceEdgesRecursive(normalizedKind, this.normalizeTargetId(normalizedKind, id), 5);
    } finally {
      this.closeDatabase();
    }
  }

  private traceEdges(kind: string, id: string): OmsTraceEdge[] {
    return this.db?.prepare(`
      SELECT * FROM source_edges
      WHERE source_kind = ? AND source_id = ?
      ORDER BY relation ASC, target_kind ASC, target_id ASC
    `).all(kind, id).map((row) => this.rowToTraceEdge(row)) ?? [];
  }

  private traceEdgesRecursive(kind: string, id: string, maxDepth: number): OmsTraceEdge[] {
    const edges: OmsTraceEdge[] = [];
    const seenEdges = new Set<string>();
    const seenNodes = new Set<string>([`${kind}:${id}`]);
    const queue: Array<{ kind: string; id: string; depth: number }> = [{ kind, id, depth: 0 }];
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || next.depth >= maxDepth) {
        continue;
      }
      for (const edge of this.traceEdges(next.kind, next.id)) {
        const edgeKey = `${edge.sourceKind}:${edge.sourceId}->${edge.relation}->${edge.targetKind}:${edge.targetId}`;
        if (seenEdges.has(edgeKey)) {
          continue;
        }
        seenEdges.add(edgeKey);
        edges.push(edge);
        const nodeKey = `${edge.targetKind}:${edge.targetId}`;
        if (!seenNodes.has(nodeKey) && (edge.targetKind === "summary" || edge.targetKind === "memory_item" || edge.targetKind === "asset")) {
          seenNodes.add(nodeKey);
          queue.push({ kind: edge.targetKind, id: edge.targetId, depth: next.depth + 1 });
        }
      }
    }
    return edges;
  }

  private rowToTraceEdge(row: Record<string, unknown>): OmsTraceEdge {
    return {
      sourceKind: String(row.source_kind ?? ""),
      sourceId: String(row.source_id ?? ""),
      relation: String(row.relation ?? ""),
      targetKind: String(row.target_kind ?? ""),
      targetId: String(row.target_id ?? ""),
      metadata: this.parseObject(row.metadata_json),
    };
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

  getStatus(): RuntimeStoreStatus {
    if (!this.openDatabase()) {
      return {
        enabled: false,
        dbPath: this.options.dbPath,
        ftsReady: false,
        ftsStatus: "unavailable",
        adapter: "unavailable",
        experimentalAdapter: false,
        journalMode: this.resolveJournalMode(),
        counts: this.emptyCounts(),
      };
    }
    try {
      return {
        enabled: this.enabled,
        dbPath: this.options.dbPath,
        ftsReady: this.ftsReady,
        ftsStatus: this.ftsRuntimeStatus(),
        adapter: "node:sqlite",
        experimentalAdapter: true,
        journalMode: this.resolveJournalMode(),
        counts: this.collectCounts(),
      };
    } finally {
      this.closeDatabase();
    }
  }

  verifyIntegrity(): RuntimeIntegrityReport {
    if (!this.openDatabase()) {
      return {
        enabled: false,
        dbPath: this.options.dbPath,
        ftsReady: false,
        ftsStatus: "unavailable",
        adapter: "unavailable",
        experimentalAdapter: false,
        journalMode: this.resolveJournalMode(),
        counts: this.emptyCounts(),
        ok: false,
        errors: ["SQLite runtime is unavailable in this Node runtime."],
        warnings: [],
        orphanEdges: 0,
        summariesWithoutSource: 0,
        selectedCandidatesWithoutTarget: 0,
      };
    }
    try {
      const counts = this.collectCounts();
      const orphanEdges = Number(this.db?.prepare(`
        SELECT COUNT(*) AS count
        FROM source_edges edge
        WHERE edge.target_kind NOT IN ('source_ref', 'observation')
          AND NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE edge.target_kind = 'message' AND m.id = edge.target_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM summaries s
            WHERE edge.target_kind = 'summary' AND s.id = edge.target_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM assets a
            WHERE edge.target_kind = 'asset' AND a.doc_id = edge.target_id
          )
      `).get()?.count ?? 0);
      const summariesWithoutSource = Number(this.db?.prepare(`
        SELECT COUNT(*) AS count
        FROM summaries s
        WHERE COALESCE(s.source_message_count, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM source_edges edge
            WHERE edge.source_kind = 'summary'
              AND edge.source_id = s.id
              AND edge.relation = 'derived_from'
          )
      `).get()?.count ?? 0);
      const selectedCandidatesWithoutTarget = Number(this.db?.prepare(`
        SELECT COUNT(*) AS count
        FROM retrieval_candidates
        WHERE status = 'selected'
          AND (target_id IS NULL OR target_id = '')
      `).get()?.count ?? 0);
      const warnings = [
        ...(summariesWithoutSource > 0
          ? [`${summariesWithoutSource} summaries have no explicit source edge/source count.`]
          : []),
        ...(selectedCandidatesWithoutTarget > 0
          ? [`${selectedCandidatesWithoutTarget} selected context candidates have no target id for why/trace.`]
          : []),
      ];
      const errors = orphanEdges > 0
        ? [`${orphanEdges} source_edges point to missing runtime records.`]
        : [];
      return {
        enabled: this.enabled,
        dbPath: this.options.dbPath,
        ftsReady: this.ftsReady,
        ftsStatus: this.ftsRuntimeStatus(),
        adapter: "node:sqlite",
        experimentalAdapter: true,
        journalMode: this.resolveJournalMode(),
        counts,
        ok: errors.length === 0,
        errors,
        warnings,
        orphanEdges,
        summariesWithoutSource,
        selectedCandidatesWithoutTarget,
      };
    } finally {
      this.closeDatabase();
    }
  }

  inspectContextRun(runId?: string): RuntimeContextRunInspection {
    if (!this.openDatabase()) {
      return { run: null, selected: [], rejected: [] };
    }
    try {
      const runRow = runId
        ? this.db?.prepare("SELECT * FROM context_runs WHERE id = ?").get(runId)
        : this.db?.prepare("SELECT * FROM context_runs ORDER BY created_at DESC LIMIT 1").get();
      if (!runRow) {
        return { run: null, selected: [], rejected: [] };
      }
      const run = this.rowToContextRun(runRow);
      const candidates = this.getCandidatesForRun(run.id);
      return {
        run,
        selected: candidates.filter((candidate) => candidate.status === "selected"),
        rejected: candidates.filter((candidate) => candidate.status === "rejected"),
      };
    } finally {
      this.closeDatabase();
    }
  }

  whyRecalled(args: { targetId?: string; query?: string; runId?: string; limit?: number } = {}): RuntimeWhyRecalledReport {
    if (!this.openDatabase()) {
      return {
        query: args.query ?? null,
        targetId: args.targetId ?? null,
        inspectedRunId: args.runId ?? null,
        matches: [],
        latestRun: null,
        explanation: "SQLite runtime is unavailable, so no context run audit trail can be inspected.",
      };
    }
    try {
      const latestRunRow = args.runId
        ? this.db?.prepare("SELECT * FROM context_runs WHERE id = ?").get(args.runId)
        : this.db?.prepare("SELECT * FROM context_runs ORDER BY created_at DESC LIMIT 1").get();
      const latestRun = latestRunRow ? this.rowToContextRun(latestRunRow) : null;
      const limit = Math.max(Math.min(args.limit ?? 10, 50), 1);
      const query = args.query?.trim().toLowerCase();
      const targetId = args.targetId?.trim();
      const rows = this.db?.prepare(`
        SELECT c.*
        FROM retrieval_candidates c
        JOIN context_runs r ON r.id = c.context_run_id
        WHERE (? IS NULL OR c.target_id = ? OR c.id = ?)
          AND (? IS NULL OR lower(c.payload_json) LIKE ? OR lower(c.reasons_json) LIKE ?)
          AND (? IS NULL OR c.context_run_id = ?)
        ORDER BY r.created_at DESC, c.status DESC, c.score DESC
        LIMIT ?
      `).all(
        targetId ?? null,
        targetId ?? null,
        targetId ?? null,
        query ?? null,
        query ? `%${query}%` : null,
        query ? `%${query}%` : null,
        args.runId ?? null,
        args.runId ?? null,
        limit,
      ) ?? [];
      const matches = rows.map((row) => this.rowToCandidate(row));
      return {
        query: args.query ?? null,
        targetId: targetId ?? null,
        inspectedRunId: args.runId ?? latestRun?.id ?? null,
        matches,
        latestRun,
        explanation: matches.length > 0
          ? "These rows are the ContextPlanner audit trail: source/authority/score show why the item was selected or rejected."
          : "No matching retrieval candidate was recorded. Run assemble/memory_retrieve first, or inspect the latest context run.",
      };
    } finally {
      this.closeDatabase();
    }
  }

  inspectKnowledgeGovernance(): RuntimeKnowledgeGovernanceReport {
    if (!this.openDatabase()) {
      return {
        totalAssets: 0,
        activeAssets: 0,
        draftAssets: 0,
        supersededAssets: 0,
        duplicateCanonicalKeys: [],
        assetsWithoutProvenance: [],
        warnings: ["SQLite runtime is unavailable; knowledge asset governance cannot inspect the indexed asset layer."],
      };
    }
    try {
      const rows = this.db?.prepare(`
        SELECT doc_id, title, canonical_key, status, linked_summary_ids_json, source_refs_json
        FROM assets
        ORDER BY canonical_key ASC, updated_at DESC
      `).all() ?? [];
      const byCanonicalKey = new Map<string, Array<Record<string, unknown>>>();
      for (const row of rows) {
        const key = String(row.canonical_key ?? "").trim() || `doc:${String(row.doc_id ?? "")}`;
        byCanonicalKey.set(key, [...(byCanonicalKey.get(key) ?? []), row]);
      }
      const duplicateCanonicalKeys = [...byCanonicalKey.entries()]
        .filter(([, group]) => group.length > 1)
        .map(([canonicalKey, group]) => ({
          canonicalKey,
          count: group.length,
          docIds: group.map((row) => String(row.doc_id ?? "")),
        }));
      const assetsWithoutProvenance = rows
        .filter((row) =>
          this.parseStringArray(row.linked_summary_ids_json).length === 0 &&
          this.parseStringArray(row.source_refs_json).length === 0)
        .map((row) => ({
          docId: String(row.doc_id ?? ""),
          title: String(row.title ?? ""),
          status: String(row.status ?? ""),
        }));
      const activeAssets = rows.filter((row) => row.status === "active").length;
      const draftAssets = rows.filter((row) => row.status === "draft").length;
      const supersededAssets = rows.filter((row) => row.status === "superseded").length;
      const warnings = [
        ...(duplicateCanonicalKeys.length > 0 ? [`${duplicateCanonicalKeys.length} canonical keys have duplicate indexed assets.`] : []),
        ...(assetsWithoutProvenance.length > 0 ? [`${assetsWithoutProvenance.length} assets have no source refs or linked summaries.`] : []),
      ];
      return {
        totalAssets: rows.length,
        activeAssets,
        draftAssets,
        supersededAssets,
        duplicateCanonicalKeys,
        assetsWithoutProvenance,
        warnings,
      };
    } finally {
      this.closeDatabase();
    }
  }

  async syncAssetsFromMarkdownIndex(mode: "sync" | "reindex" = "sync"): Promise<RuntimeAssetSyncReport> {
    await this.init();
    const documents = await this.loadMarkdownAssetIndex();
    if (!this.openDatabase()) {
      return {
        ok: false,
        mode,
        indexedAssets: documents.length,
        sqliteAssetsBefore: 0,
        sqliteAssetsAfter: 0,
        pruned: 0,
        warnings: ["SQLite runtime is unavailable; Markdown assets could not be indexed into runtime storage."],
      };
    }
    let transactionStarted = false;
    try {
      const before = this.countTable("assets");
      this.db?.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      if (mode === "reindex") {
        this.db?.prepare("DELETE FROM source_edges WHERE source_kind = 'asset'").run();
        this.db?.prepare("DELETE FROM trace_edges WHERE source_kind = 'asset'").run();
        this.db?.prepare("DELETE FROM assets").run();
      }
      for (const document of documents) {
        this.upsertAsset(document);
        this.upsertAssetSourceEdges(document);
      }
      const documentIds = new Set(documents.map((document) => document.docId));
      let pruned = 0;
      if (mode === "reindex") {
        pruned = Math.max(before - documents.length, 0);
      } else {
        const rows = this.db?.prepare("SELECT doc_id FROM assets").all() ?? [];
        for (const row of rows) {
          const docId = String(row.doc_id ?? "");
          if (!documentIds.has(docId)) {
            this.db?.prepare("DELETE FROM source_edges WHERE source_kind = 'asset' AND source_id = ?").run(docId);
            this.db?.prepare("DELETE FROM trace_edges WHERE source_kind = 'asset' AND source_id = ?").run(docId);
            this.db?.prepare("DELETE FROM assets WHERE doc_id = ?").run(docId);
            pruned += 1;
          }
        }
      }
      this.db?.exec("COMMIT");
      transactionStarted = false;
      const after = this.countTable("assets");
      return {
        ok: true,
        mode,
        indexedAssets: documents.length,
        sqliteAssetsBefore: before,
        sqliteAssetsAfter: after,
        pruned,
        warnings: [],
      };
    } catch (error) {
      if (transactionStarted) {
        try {
          this.db?.exec("ROLLBACK");
        } catch {
          // Preserve original sync failure.
        }
      }
      throw error;
    } finally {
      this.closeDatabase();
    }
  }

  searchKnowledgeAssets(query: string, limit = 6): KnowledgeDocumentIndexEntry[] {
    const terms = this.queryTerms(query);
    if (terms.length === 0 || !this.openDatabase()) {
      return [];
    }
    try {
      const rows = this.db?.prepare(`
        SELECT payload_json, title, summary, tags_json
        FROM assets
        WHERE status = 'active'
        ORDER BY updated_at DESC
      `).all() ?? [];
      return rows
        .map((row) => {
          const asset = this.parseObject(row.payload_json) as unknown as KnowledgeDocumentIndexEntry;
          const tags = this.parseStringArray(row.tags_json);
          const searchable = [
            String(row.title ?? ""),
            String(row.summary ?? ""),
            tags.join(" "),
            asset.canonicalKey,
            asset.slug,
          ].join(" ");
          return {
            asset,
            score: this.scoreText(searchable, terms),
          };
        })
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.asset.title.localeCompare(right.asset.title))
        .slice(0, Math.max(Math.min(limit, 50), 1))
        .map((item) => item.asset);
    } finally {
      this.closeDatabase();
    }
  }

  purgeSession(sessionId: string): RuntimePurgeReport {
    if (!sessionId.trim()) {
      return { ok: false, scope: "session", target: sessionId, deleted: {} };
    }
    this.openDatabase();
    if (!this.db) {
      return { ok: false, scope: "session", target: sessionId, deleted: {} };
    }
    const deleted = this.runPurgeTransaction({
      scope: "session",
      target: sessionId.trim(),
      whereColumn: "session_id",
    });
    return {
      ok: true,
      scope: "session",
      target: sessionId.trim(),
      deleted,
    };
  }

  purgeAgent(agentId: string): RuntimePurgeReport {
    if (!agentId.trim()) {
      return { ok: false, scope: "agent", target: agentId, deleted: {} };
    }
    this.openDatabase();
    if (!this.db) {
      return { ok: false, scope: "agent", target: agentId, deleted: {} };
    }
    const deleted = this.runPurgeTransaction({
      scope: "agent",
      target: agentId.trim(),
      whereColumn: "agent_id",
    });
    return {
      ok: true,
      scope: "agent",
      target: agentId.trim(),
      deleted,
    };
  }

  dispose(): void {
    this.closeDatabase();
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
      this.statementCache.clear();
    }
  }

  private runPurgeTransaction(args: {
    scope: "session" | "agent";
    target: string;
    whereColumn: "session_id" | "agent_id";
  }): Record<string, number> {
    const deleted: Record<string, number> = {};
    let transactionStarted = false;
    try {
      this.db?.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      deleted.retrieval_candidates = this.deleteBySql(
        `
          DELETE FROM retrieval_candidates
          WHERE context_run_id IN (
            SELECT id FROM context_runs WHERE ${args.whereColumn} = ?
          )
        `,
        args.target,
      );
      deleted.context_runs = this.deleteBySql(
        `DELETE FROM context_runs WHERE ${args.whereColumn} = ?`,
        args.target,
      );
      deleted.source_edges = this.deleteBySql(
        `DELETE FROM source_edges WHERE ${args.whereColumn} = ?`,
        args.target,
      );
      deleted.trace_edges = this.deleteBySql(
        `DELETE FROM trace_edges WHERE ${args.whereColumn} = ?`,
        args.target,
      );
      deleted.runtime_annotations = this.deleteBySql(
        `
          DELETE FROM runtime_annotations
          WHERE (target_kind = 'memory_item' AND target_id IN (
            SELECT id FROM memory_items WHERE ${args.whereColumn} = ?
          ))
          OR (target_kind = 'summary' AND target_id IN (
            SELECT id FROM summaries WHERE ${args.whereColumn} = ?
          ))
          OR (target_kind = 'message' AND target_id IN (
            SELECT id FROM messages WHERE ${args.whereColumn} = ?
          ))
          OR (target_kind = 'runtime_record' AND target_id IN (
            SELECT id FROM runtime_records WHERE ${args.whereColumn} = ?
          ))
        `,
        args.target,
        args.target,
        args.target,
        args.target,
      );
      deleted.messages = this.deleteBySql(
        `DELETE FROM messages WHERE ${args.whereColumn} = ?`,
        args.target,
      );
      deleted.summaries = this.deleteBySql(
        `DELETE FROM summaries WHERE ${args.whereColumn} = ?`,
        args.target,
      );
      deleted.memory_items = this.deleteBySql(
        `DELETE FROM memory_items WHERE ${args.whereColumn} = ?`,
        args.target,
      );
      deleted.runtime_records = this.deleteBySql(
        `DELETE FROM runtime_records WHERE ${args.whereColumn} = ?`,
        args.target,
      );
      this.db?.exec("COMMIT");
      transactionStarted = false;
      return deleted;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.db?.exec("ROLLBACK");
        } catch {
          // best effort
        }
      }
      throw error;
    }
  }

  private deleteBySql(sql: string, ...params: SQLiteValue[]): number {
    this.prepare(sql)?.run(...params);
    return this.getSingleNumber("SELECT changes() AS count");
  }

  private getSingleNumber(sql: string): number {
    const row = this.prepare(sql)?.get();
    const value = row?.count;
    return typeof value === "number" ? value : Number(value ?? 0) || 0;
  }

  private prepare(sql: string): SQLiteStatementLike | null {
    if (!this.db) {
      return null;
    }
    const cached = this.statementCache.get(sql);
    if (cached) {
      return cached;
    }
    const statement = this.db.prepare(sql);
    this.statementCache.set(sql, statement);
    return statement;
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
      this.db.exec(`PRAGMA journal_mode = ${this.resolveJournalMode().toUpperCase()};`);
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
    } catch (error) {
      this.options.logger.warn("sqlite_runtime_pragma_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveJournalMode(): "delete" | "wal" {
    return this.options.journalMode === "wal" ? "wal" : "delete";
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

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        project_id TEXT,
        topic_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        context_policy TEXT NOT NULL,
        text TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        stability TEXT NOT NULL DEFAULT 'medium',
        priority INTEGER NOT NULL DEFAULT 50,
        tags_json TEXT NOT NULL DEFAULT '[]',
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        inferred INTEGER NOT NULL DEFAULT 0,
        supersedes_json TEXT NOT NULL DEFAULT '[]',
        conflicts_with_json TEXT NOT NULL DEFAULT '[]',
        supports_json TEXT NOT NULL DEFAULT '[]',
        promotion_state TEXT NOT NULL DEFAULT 'none',
        valid_from TEXT,
        valid_until TEXT,
        valid_to TEXT,
        created_by_agent_id TEXT,
        updated_by_agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_items_agent_status ON memory_items(agent_id, status);
      CREATE INDEX IF NOT EXISTS idx_memory_items_source ON memory_items(source_table, source_id);
      CREATE INDEX IF NOT EXISTS idx_memory_items_project_status ON memory_items(project_id, status);

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

      CREATE TABLE IF NOT EXISTS trace_edges (
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
      CREATE INDEX IF NOT EXISTS idx_trace_edges_source ON trace_edges(source_kind, source_id);
      CREATE INDEX IF NOT EXISTS idx_trace_edges_target ON trace_edges(target_kind, target_id);

      CREATE TABLE IF NOT EXISTS runtime_annotations (
        id TEXT PRIMARY KEY,
        annotation_kind TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        provider TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_annotations_target ON runtime_annotations(target_kind, target_id, annotation_kind);

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

      CREATE TABLE IF NOT EXISTS runtime_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        session_id TEXT,
        agent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(kind, id)
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_records_kind_session ON runtime_records(kind, session_id);
      CREATE INDEX IF NOT EXISTS idx_runtime_records_kind_agent ON runtime_records(kind, agent_id);
    `);

    // FTS is deliberately lazy. Exact/LIKE search remains canonical today, so
    // boot and normal mirroring should not pay virtual-table setup or refresh
    // costs until a future semantic/FTS path explicitly enables it.
    this.ensureMemoryItemSchema();
    this.dropLegacyMemoryTables();
  }

  private dropLegacyMemoryTables(): void {
    if (!this.db) {
      return;
    }
    this.db.exec(`
      DELETE FROM source_edges
      WHERE source_kind IN ('memory', 'evidence_atom')
         OR target_kind IN ('memory', 'evidence_atom');
      DELETE FROM trace_edges
      WHERE source_kind IN ('memory', 'evidence_atom')
         OR target_kind IN ('memory', 'evidence_atom');
      DROP TABLE IF EXISTS memories;
      DROP TABLE IF EXISTS evidence_atoms;
      DROP TABLE IF EXISTS memories_fts;
    `);
  }

  private ensureMemoryItemSchema(): void {
    if (!this.db) {
      return;
    }
    const rows = this.db.prepare("PRAGMA table_info(memory_items)").all();
    const columns = new Set(rows.map((row) => String(row.name)));
    const addColumn = (name: string, ddl: string): void => {
      if (columns.has(name)) {
        return;
      }
      this.db?.exec(`ALTER TABLE memory_items ADD COLUMN ${name} ${ddl};`);
      columns.add(name);
    };

    // The final architecture document names MemoryItem as the canonical layer.
    // The document-facing fields below are first-class columns; operational
    // row ids and payload snapshots exist only to keep writes atomic and
    // traceable inside SQLite.
    addColumn("memory_id", "TEXT");
    addColumn("scope_type", "TEXT");
    addColumn("scope_id", "TEXT");
    addColumn("content", "TEXT");
    addColumn("confidence", "REAL NOT NULL DEFAULT 0.5");
    addColumn("stability", "TEXT NOT NULL DEFAULT 'medium'");
    addColumn("priority", "INTEGER NOT NULL DEFAULT 50");
    addColumn("valid_to", "TEXT");
    addColumn("created_by_agent_id", "TEXT");
    addColumn("updated_by_agent_id", "TEXT");
    addColumn("metadata_json", "TEXT NOT NULL DEFAULT '{}'");

    this.db.exec(`
      UPDATE memory_items
      SET
        memory_id = COALESCE(NULLIF(memory_id, ''), id),
        scope_type = COALESCE(NULLIF(scope_type, ''), scope),
        scope_id = COALESCE(NULLIF(scope_id, ''), project_id, agent_id, session_id, 'global'),
        content = COALESCE(NULLIF(content, ''), text),
        valid_to = COALESCE(valid_to, valid_until),
        created_by_agent_id = COALESCE(created_by_agent_id, agent_id),
        updated_by_agent_id = COALESCE(updated_by_agent_id, agent_id),
        metadata_json = COALESCE(NULLIF(metadata_json, ''), '{}')
      WHERE memory_id IS NULL
        OR scope_type IS NULL
        OR scope_id IS NULL
        OR content IS NULL
        OR valid_to IS NULL
        OR created_by_agent_id IS NULL
        OR updated_by_agent_id IS NULL
        OR metadata_json IS NULL
        OR metadata_json = '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_items_memory_id ON memory_items(memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_items_scope ON memory_items(scope_type, scope_id, status);
    `);
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
    this.prepare(`
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
    `)?.run(
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

  private toFtsMatchQueries(query: string, terms: string[]): string[] {
    const ftsTerms = this.distinctiveFtsTerms(terms).slice(0, 5);
    if (ftsTerms.length === 0) {
      return [];
    }
    const quotedPhrases = [...query.matchAll(/"([^"]{3,80})"/g)]
      .map((match) => match[1])
      .map((phrase) => phrase.toLowerCase().replace(/[^a-z0-9\s-]+/g, " ").trim().replace(/\s+/g, " "))
      .filter((phrase) => phrase.length >= 3)
      .slice(0, 2)
      .map((phrase) => `"${phrase}"`);
    const cleanedPhrase = query
      .toLowerCase()
      .replace(/^history\s+recall\s*:\s*/i, "")
      .replace(/"/g, " ")
      .trim()
      .split(/\s+/)
      .filter((term) => /^[a-z0-9]+$/.test(term))
      .filter((term) => !SQLITE_RUNTIME_STOP_WORDS.has(term))
      .slice(0, 4)
      .join(" ");
    const focusedAnd = ftsTerms.map((term) => `${term}*`).join(" ");
    const queries = [
      ...quotedPhrases,
      cleanedPhrase.length >= 6 ? `"${cleanedPhrase}"` : "",
      focusedAnd,
      ftsTerms.length > 2 ? ftsTerms.slice(0, 2).map((term) => `${term}*`).join(" ") : "",
      // Last-resort relaxed query keeps recall from going to zero, but only after
      // lossless-style implicit-AND queries have failed to produce enough anchors.
      ftsTerms.length > 1 ? ftsTerms.map((term) => `${term}*`).join(" OR ") : "",
    ].filter(Boolean);
    return [...new Set(queries)];
  }

  private upsertSummary(summary: SummaryEntry): void {
    this.prepare(`
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
    `)?.run(
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

  private upsertMemoryItem(item: MemoryItemEntry): void {
    const metadata = item.metadata ?? {};
    const content = item.content ?? item.text;
    this.prepare(`
      INSERT INTO memory_items (
        id, memory_id, source_table, source_id, session_id, agent_id, project_id,
        topic_id, kind, status, scope, scope_type, scope_id, evidence_level,
        context_policy, text, content, confidence, stability, priority,
        tags_json, source_ids_json, source_refs_json, inferred, supersedes_json,
        conflicts_with_json, supports_json, promotion_state, valid_from,
        valid_until, valid_to, created_by_agent_id, updated_by_agent_id,
        created_at, updated_at, metadata_json, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        memory_id=excluded.memory_id,
        session_id=excluded.session_id,
        agent_id=excluded.agent_id,
        project_id=excluded.project_id,
        topic_id=excluded.topic_id,
        kind=excluded.kind,
        status=excluded.status,
        scope=excluded.scope,
        scope_type=excluded.scope_type,
        scope_id=excluded.scope_id,
        evidence_level=excluded.evidence_level,
        context_policy=excluded.context_policy,
        text=excluded.text,
        content=excluded.content,
        confidence=excluded.confidence,
        stability=excluded.stability,
        priority=excluded.priority,
        tags_json=excluded.tags_json,
        source_ids_json=excluded.source_ids_json,
        source_refs_json=excluded.source_refs_json,
        inferred=excluded.inferred,
        supersedes_json=excluded.supersedes_json,
        conflicts_with_json=excluded.conflicts_with_json,
        supports_json=excluded.supports_json,
        promotion_state=excluded.promotion_state,
        valid_from=excluded.valid_from,
        valid_until=excluded.valid_until,
        valid_to=excluded.valid_to,
        created_by_agent_id=excluded.created_by_agent_id,
        updated_by_agent_id=excluded.updated_by_agent_id,
        updated_at=excluded.updated_at,
        metadata_json=excluded.metadata_json,
        payload_json=excluded.payload_json
    `)?.run(
      item.id,
      item.id,
      item.sourceTable,
      item.sourceId,
      item.sessionId,
      item.agentId ?? null,
      item.projectId ?? null,
      item.topicId ?? null,
      item.kind,
      item.status,
      item.scope,
      item.scopeType ?? item.scope,
      item.scopeId,
      item.evidenceLevel,
      item.contextPolicy,
      item.text,
      content,
      item.confidence,
      item.stability,
      item.priority,
      this.stringify(item.tags ?? []),
      this.stringify(item.sourceIds ?? []),
      this.stringify(item.sourceRefs ?? []),
      item.inferred ? 1 : 0,
      this.stringify(item.supersedes ?? []),
      this.stringify(item.conflictsWith ?? []),
      this.stringify(item.supports ?? []),
      item.promotionState,
      item.validFrom ?? null,
      item.validUntil ?? null,
      item.validUntil ?? null,
      item.createdByAgentId ?? item.agentId ?? null,
      item.updatedByAgentId ?? item.agentId ?? null,
      item.createdAt,
      item.updatedAt,
      this.stringify(metadata),
      this.stringify({
        ...item,
        content,
        scopeType: item.scopeType ?? item.scope,
      }),
    );
  }

  private memoryItemFromDraft(memory: MemoryItemDraftEntry): MemoryItemEntry {
    const kindByDraft: Record<MemoryItemDraftEntry["kind"], MemoryItemKind> = {
      user_fact: "preference",
      assistant_decision: "decision",
      project_state: "project_state",
      solution: "lesson",
      diagnostic: "diagnosis",
      constraint: "constraint",
    };
    const metadata = memory.metadata ?? {};
    const sourceIds = this.uniqueStrings(memory.sourceIds ?? []);
    const scope = this.memoryItemScope(memory);
    const sourceRefs = this.sourceRefsFromMessageIds(memory.sourceType === "raw_message" ? sourceIds : []);
    return {
      id: `memory-item:${memory.id}`,
      sourceTable: "memory_item_drafts",
      sourceId: memory.id,
      sessionId: memory.sessionId,
      agentId: memory.agentId,
      projectId: memory.projectId,
      topicId: memory.topicId,
      kind: kindByDraft[memory.kind] ?? "general",
      status: memory.recordStatus ?? "active",
      scope,
      scopeType: scope,
      scopeId: this.memoryItemScopeId(scope, memory),
      evidenceLevel: memory.sourceType === "raw_message" ? "source_verified" : memory.sourceType === "snapshot" ? "stated" : "inferred",
      contextPolicy: memory.projectId ? "project_active" : "default",
      text: memory.text,
      content: memory.text,
      confidence: this.numberFromUnknown(metadata.confidence, memory.sourceType === "raw_message" ? 0.8 : 0.5),
      stability: this.stabilityFromUnknown(metadata.stability),
      priority: this.numberFromUnknown(metadata.priority, memory.projectId ? 20 : 30),
      tags: memory.tags ?? [],
      sourceIds,
      sourceRefs,
      inferred: false,
      supersedes: this.stringArrayFromUnknown(metadata.supersedes),
      conflictsWith: this.stringArrayFromUnknown(metadata.conflictsWith ?? metadata.conflicts_with),
      supports: this.uniqueStrings([
        ...sourceIds,
        ...this.stringArrayFromUnknown(metadata.supports),
      ]),
      promotionState: "none",
      validFrom: memory.sourceStartTimestamp,
      validUntil: memory.sourceEndTimestamp,
      createdByAgentId: memory.agentId,
      updatedByAgentId: memory.agentId,
      createdAt: memory.createdAt,
      updatedAt: typeof metadata.updatedAt === "string" ? metadata.updatedAt : memory.createdAt,
      metadata: {
        ...metadata,
        draftKind: memory.kind,
        draftSourceType: memory.sourceType,
        supersededById: memory.supersededById,
        fingerprint: memory.fingerprint,
        sourceSequenceMin: memory.sourceSequenceMin,
        sourceSequenceMax: memory.sourceSequenceMax,
      },
    };
  }

  private memoryItemFromEvidenceAtom(atom: EvidenceAtomEntry): MemoryItemEntry {
    const type = String(atom.type);
    const kind: MemoryItemKind = type === "decision"
      ? "decision"
      : type === "constraint"
        ? "constraint"
        : type === "next_step"
          ? "procedure"
          : type === "blocker"
            ? "diagnosis"
            : "claim";
    const scope = this.memoryItemScope(atom);
    const sourceIds = this.uniqueStrings([
      atom.sourceSummaryId,
      ...(atom.sourceBinding?.messageIds ?? []),
      ...(atom.sourceMessageIds ?? []),
    ]);
    return {
      id: `memory-item:${atom.id}`,
      sourceTable: "summary_evidence_drafts",
      sourceId: atom.id,
      sessionId: atom.sessionId,
      agentId: atom.agentId,
      projectId: atom.projectId,
      topicId: atom.topicId,
      kind,
      status: atom.recordStatus ?? "active",
      scope,
      scopeType: scope,
      scopeId: this.memoryItemScopeId(scope, atom),
      evidenceLevel: atom.sourceTraceComplete ? "source_verified" : "stated",
      contextPolicy: "strict_only",
      text: atom.text,
      content: atom.text,
      confidence: atom.confidence,
      stability: this.memoryItemStabilityFromScore(atom.stability),
      priority: this.priorityFromEvidenceAtom(atom),
      tags: atom.tags ?? [],
      sourceIds,
      sourceRefs: this.sourceRefsFromMessageIds([
        ...(atom.sourceBinding?.messageIds ?? []),
        ...(atom.sourceMessageIds ?? []),
      ]),
      inferred: !atom.sourceTraceComplete,
      supersedes: [],
      conflictsWith: atom.conflictGroupId ? [atom.conflictGroupId] : [],
      supports: sourceIds,
      promotionState: "none",
      validFrom: atom.validFrom,
      validUntil: atom.validUntil,
      createdByAgentId: atom.agentId,
      updatedByAgentId: atom.agentId,
      createdAt: atom.createdAt,
      updatedAt: atom.createdAt,
      metadata: {
        evidenceDraftType: atom.type,
        confidence: atom.confidence,
        importance: atom.importance,
        stability: atom.stability,
        atomStatus: atom.atomStatus,
        sourceBinding: atom.sourceBinding,
        sourceHash: atom.sourceHash,
        sourceMessageCount: atom.sourceMessageCount,
        ...(atom.metadata ?? {}),
      },
    };
  }

  private stringArrayFromUnknown(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  }

  private uniqueStrings(values: string[]): string[] {
    return values
      .map((value) => value.trim())
      .filter((value, index, items) => value.length > 0 && items.indexOf(value) === index);
  }

  private memoryItemScope(entry: { agentId?: string; projectId?: string }): MemoryItemScope {
    if (entry.projectId) {
      return "project";
    }
    if (entry.agentId) {
      return "agent";
    }
    return "session";
  }

  private memoryItemScopeId(
    scope: MemoryItemScope,
    entry: { sessionId: string; agentId?: string; projectId?: string },
  ): string {
    if (scope === "project" && entry.projectId) {
      return entry.projectId;
    }
    if ((scope === "agent" || scope === "user_private_to_agent") && entry.agentId) {
      return entry.agentId;
    }
    if ((scope === "global" || scope === "global_principle") && entry.projectId) {
      return entry.projectId;
    }
    return entry.sessionId;
  }

  private numberFromUnknown(value: unknown, fallback: number): number {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private stabilityFromUnknown(value: unknown): MemoryItemStability {
    if (value === "low" || value === "medium" || value === "high") {
      return value;
    }
    return typeof value === "number" ? this.memoryItemStabilityFromScore(value) : "medium";
  }

  private memoryItemStabilityFromScore(value: number): MemoryItemStability {
    if (value >= 0.75) {
      return "high";
    }
    if (value <= 0.35) {
      return "low";
    }
    return "medium";
  }

  private priorityFromEvidenceAtom(atom: EvidenceAtomEntry): number {
    if (atom.type === "constraint" || atom.type === "decision") {
      return 20;
    }
    if (atom.type === "exact_fact") {
      return 30;
    }
    return Math.max(30, Math.min(80, Math.round(90 - atom.importance * 60)));
  }

  private sourceRefsFromMessageIds(messageIds: string[]): SourceSpanRef[] {
    return this.uniqueStrings(messageIds).map((messageId) => ({ messageId }));
  }

  private async mirrorAssetsFromMarkdownIndex(): Promise<void> {
    if (!this.db) {
      return;
    }
    const documents = await this.loadMarkdownAssetIndex();
    for (const document of documents) {
      this.upsertAsset(document);
      this.upsertAssetSourceEdges(document);
    }
  }

  private async loadMarkdownAssetIndex(): Promise<KnowledgeDocumentIndexEntry[]> {
    const indexPath = path.join(this.options.knowledgeBaseDir, "indexes", "document-index.json");
    try {
      const parsed = JSON.parse(await readFile(indexPath, "utf8")) as { documents?: KnowledgeDocumentIndexEntry[] } | KnowledgeDocumentIndexEntry[];
      const documents = Array.isArray(parsed) ? parsed : parsed.documents;
      if (!Array.isArray(documents)) {
        return [];
      }
      return documents;
    } catch {
      // Markdown assets may not exist yet; runtime mirror remains usable for raw/summary/memory.
      return [];
    }
  }

  private memoryItemFromKnowledgeRaw(entry: KnowledgeRawEntry): MemoryItemEntry {
    const summary = entry.sourceSummary;
    const promotionState = this.knowledgeRawPromotionState(entry.status);
    const rejected = entry.status === "rejected" || entry.status === "failed" || entry.status === "skipped";
    const settled = entry.status === "promoted" || entry.status === "duplicate";
    const sourceIds = [
      entry.sourceSummaryId,
      ...(summary.sourceMessageIds ?? []),
      ...(summary.sourceSummaryIds ?? []),
    ].filter((id): id is string => typeof id === "string" && id.length > 0);
    const scope = summary.projectId ? "project" : "agent";

    return {
      id: `memory-item:${entry.id}`,
      sourceTable: "knowledge_raw",
      sourceId: entry.id,
      sessionId: entry.sessionId || summary.sessionId,
      agentId: entry.agentId ?? summary.agentId,
      projectId: summary.projectId,
      topicId: summary.topicId,
      kind: "kb_candidate",
      status: rejected ? "rejected" : settled ? "active" : "candidate",
      scope,
      scopeType: scope,
      scopeId: this.memoryItemScopeId(scope, {
        sessionId: entry.sessionId || summary.sessionId,
        agentId: entry.agentId ?? summary.agentId,
        projectId: summary.projectId,
      }),
      evidenceLevel: summary.sourceHash || entry.sourceBinding || summary.sourceBinding ? "source_verified" : "inferred",
      contextPolicy: "never",
      text: entry.oneLineSummary?.trim() || summary.summary,
      content: entry.oneLineSummary?.trim() || summary.summary,
      confidence: this.numberFromUnknown(entry.score?.total, summary.quality?.confidence ?? 0.5),
      stability: "medium",
      priority: 80,
      tags: [
        "kb_candidate",
        entry.status,
        ...(summary.keywords ?? []),
      ].filter((tag, index, tags) => tag.length > 0 && tags.indexOf(tag) === index),
      sourceIds: this.uniqueStrings(sourceIds),
      sourceRefs: summary.sourceRefs ?? [],
      inferred: !(summary.sourceHash || entry.sourceBinding || summary.sourceBinding),
      supersedes: [],
      conflictsWith: [],
      supports: [entry.sourceSummaryId],
      promotionState,
      createdByAgentId: entry.agentId ?? summary.agentId,
      updatedByAgentId: entry.agentId ?? summary.agentId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      metadata: {
        intakeReason: entry.intakeReason,
        processReason: entry.processReason,
        review: entry.review,
        score: entry.score,
        linkedDocId: entry.linkedDocId,
        linkedSlug: entry.linkedSlug,
        linkedVersion: entry.linkedVersion,
        linkedFilePath: entry.linkedFilePath,
        sourceHash: summary.sourceHash,
        sourceMessageCount: summary.sourceMessageCount,
        sourceBinding: entry.sourceBinding ?? summary.sourceBinding,
      },
    };
  }

  private knowledgeRawPromotionState(status: KnowledgeRawEntry["status"]): MemoryItemEntry["promotionState"] {
    switch (status) {
      case "review_pending":
      case "processing":
        return "drafted";
      case "promoted":
      case "duplicate":
        return "exported";
      case "rejected":
      case "failed":
      case "skipped":
        return "rejected";
      default:
        return "candidate";
    }
  }

  private upsertAsset(asset: KnowledgeDocumentIndexEntry): void {
    this.prepare(`
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
    `)?.run(
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

  private rebuildSourceEdges(
    summaries: SummaryEntry[],
    memories: MemoryItemDraftEntry[],
    atoms: EvidenceAtomEntry[] = [],
  ): void {
    if (!this.db) {
      return;
    }
    this.db.prepare("DELETE FROM source_edges").run();
    this.db.prepare("DELETE FROM trace_edges").run();
    for (const summary of summaries) {
      this.upsertSummarySourceEdges(summary, { deleteExisting: false });
    }

    for (const memory of memories) {
      this.upsertMemoryItemSourceEdges(this.memoryItemFromDraft(memory), { deleteExisting: false });
    }

    for (const atom of atoms) {
      this.upsertMemoryItemSourceEdges(this.memoryItemFromEvidenceAtom(atom), { deleteExisting: false });
    }

    const assetRows = this.db.prepare("SELECT payload_json FROM assets").all();
    for (const row of assetRows) {
      const asset = this.parseObject(row.payload_json) as unknown as KnowledgeDocumentIndexEntry;
      if (!asset.docId) {
        continue;
      }
      this.upsertAssetSourceEdges(asset, { deleteExisting: false });
    }
  }

  private upsertAssetSourceEdges(
    asset: KnowledgeDocumentIndexEntry,
    options: { deleteExisting?: boolean } = {},
  ): void {
    if (!this.db || !asset.docId) {
      return;
    }
    if (options.deleteExisting !== false) {
      this.deleteEdgesForSource("asset", asset.docId);
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

  private upsertSummarySourceEdges(
    summary: SummaryEntry,
    options: { deleteExisting?: boolean } = {},
  ): void {
    if (!this.db) {
      return;
    }
    if (options.deleteExisting !== false) {
      this.deleteEdgesForSource("summary", summary.id);
    }
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

  private upsertMemoryItemSourceEdges(
    item: MemoryItemEntry,
    options: { deleteExisting?: boolean } = {},
  ): void {
    if (!this.db) {
      return;
    }
    if (options.deleteExisting !== false) {
      this.deleteEdgesForSource("memory_item", item.id);
    }
    for (const sourceId of [...new Set(item.sourceIds ?? [])]) {
      this.insertEdge("memory_item", item.id, "derived_from", this.targetKindForSourceId(sourceId), sourceId, {
        sessionId: item.sessionId,
        agentId: item.agentId,
        projectId: item.projectId,
        sourceTable: item.sourceTable,
        sourceId: item.sourceId,
        evidenceLevel: item.evidenceLevel,
        inferred: item.inferred,
      });
    }
    for (const supportedId of [...new Set(item.supports ?? [])]) {
      this.insertEdge("memory_item", item.id, "supports", this.targetKindForSourceId(supportedId), supportedId, {
        sessionId: item.sessionId,
        agentId: item.agentId,
        projectId: item.projectId,
        sourceTable: item.sourceTable,
        sourceId: item.sourceId,
      });
    }
    for (const supersededId of [...new Set(item.supersedes ?? [])]) {
      this.insertEdge("memory_item", item.id, "supersedes", "memory_item", this.normalizeMemoryItemTargetId(supersededId), {
        sessionId: item.sessionId,
        agentId: item.agentId,
        projectId: item.projectId,
        sourceTable: item.sourceTable,
        sourceId: item.sourceId,
      });
    }
    for (const conflictId of [...new Set(item.conflictsWith ?? [])]) {
      this.insertEdge(
        "memory_item",
        item.id,
        "conflicts_with",
        conflictId.startsWith("memory-item:") || conflictId.startsWith("memory-") ? "memory_item" : "conflict_group",
        conflictId.startsWith("memory-") ? this.normalizeMemoryItemTargetId(conflictId) : conflictId,
        {
          sessionId: item.sessionId,
          agentId: item.agentId,
          projectId: item.projectId,
          sourceTable: item.sourceTable,
          sourceId: item.sourceId,
        },
      );
    }
  }

  private normalizeMemoryItemTargetId(id: string): string {
    return id.startsWith("memory-item:") ? id : `memory-item:${id}`;
  }

  private deleteEdgesForSource(sourceKind: string, sourceId: string): void {
    this.prepare(`
      DELETE FROM source_edges
      WHERE source_kind = ? AND source_id = ?
    `)?.run(sourceKind, sourceId);
    this.prepare(`
      DELETE FROM trace_edges
      WHERE source_kind = ? AND source_id = ?
    `)?.run(sourceKind, sourceId);
  }

  private deleteMemoryItemsFromSourceTables(sourceTables: MemoryItemEntry["sourceTable"][]): void {
    if (!this.db || sourceTables.length === 0) {
      return;
    }
    const placeholders = sourceTables.map(() => "?").join(", ");
    this.prepare(`
      DELETE FROM source_edges
      WHERE source_kind = 'memory_item'
        AND source_id IN (
          SELECT id FROM memory_items WHERE source_table IN (${placeholders})
        )
    `)?.run(...sourceTables);
    this.prepare(`
      DELETE FROM trace_edges
      WHERE source_kind = 'memory_item'
        AND source_id IN (
          SELECT id FROM memory_items WHERE source_table IN (${placeholders})
        )
    `)?.run(...sourceTables);
    this.prepare(`DELETE FROM memory_items WHERE source_table IN (${placeholders})`)?.run(...sourceTables);
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
    this.prepare(`
      INSERT INTO source_edges (
        id, source_kind, source_id, relation, target_kind, target_id,
        session_id, agent_id, project_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json
    `)?.run(
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
    this.prepare(`
      INSERT INTO trace_edges (
        id, source_kind, source_id, relation, target_kind, target_id,
        session_id, agent_id, project_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json
    `)?.run(
      id,
      sourceKind,
      sourceId,
      relation,
      targetKind,
      targetId,
      typeof metadata.sessionId === "string" ? metadata.sessionId : null,
      typeof metadata.agentId === "string" ? metadata.agentId : null,
      typeof metadata.projectId === "string" ? metadata.projectId : null,
      this.stringify({
        ...metadata,
        mirrorOf: "source_edges",
      }),
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

  private getMessagesByTurns(turnNumbers: number[], sessionId?: string): RawMessage[] {
    if (!this.db || turnNumbers.length === 0) {
      return [];
    }
    const uniqueTurns = [...new Set(turnNumbers)].sort((left, right) => left - right);
    const placeholders = uniqueTurns.map(() => "?").join(", ");
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE turn_number IN (${placeholders})
        AND (? IS NULL OR session_id = ?)
      ORDER BY turn_number ASC, sequence ASC, created_at ASC
    `).all(...uniqueTurns, sessionId ?? null, sessionId ?? null).map((row) => this.rowToMessage(row));
  }

  private getMessagesByIds(ids: string[]): RawMessage[] {
    if (!this.db || ids.length === 0) {
      return [];
    }
    const uniqueIds = [...new Set(ids)];
    const rows = this.selectByIdChunks("messages", "*", uniqueIds, "turn_number ASC, sequence ASC, created_at ASC");
    return rows.map((row) => this.rowToMessage(row));
  }

  private getSummariesByIds(ids: string[]): SummaryEntry[] {
    if (!this.db || ids.length === 0) {
      return [];
    }
    const uniqueIds = [...new Set(ids)];
    const rows = this.selectByIdChunks("summaries", "payload_json", uniqueIds, "start_turn ASC, end_turn ASC");
    return rows.map((row) => this.parseObject(row.payload_json) as unknown as SummaryEntry);
  }

  private selectByIdChunks(
    table: "messages" | "summaries",
    projection: "*" | "payload_json",
    ids: string[],
    orderBy: string,
  ): Array<Record<string, unknown>> {
    if (!this.db) {
      return [];
    }
    const rows: Array<Record<string, unknown>> = [];
    for (let index = 0; index < ids.length; index += 250) {
      const chunk = ids.slice(index, index + 250);
      const placeholders = chunk.map(() => "?").join(", ");
      rows.push(...this.db.prepare(`
        SELECT ${projection} FROM ${table}
        WHERE id IN (${placeholders})
        ORDER BY ${orderBy}
      `).all(...chunk));
    }
    return rows;
  }

  private collectCounts(): RuntimeTableCounts {
    return {
      messages: this.countTable("messages"),
      summaries: this.countTable("summaries"),
      evidenceAtoms: this.countTable("summary_evidence_drafts"),
      memories: this.countTable("memory_item_drafts"),
      memoryItems: this.countTable("memory_items"),
      runtimeRecords: this.countTable("runtime_records"),
      assets: this.countTable("assets"),
      sourceEdges: this.countTable("source_edges"),
      traceEdges: this.countTable("trace_edges"),
      runtimeAnnotations: this.countTable("runtime_annotations"),
      contextRuns: this.countTable("context_runs"),
      retrievalCandidates: this.countTable("retrieval_candidates"),
    };
  }

  private emptyCounts(): RuntimeTableCounts {
    return {
      messages: 0,
      summaries: 0,
      evidenceAtoms: 0,
      memories: 0,
      memoryItems: 0,
      runtimeRecords: 0,
      assets: 0,
      sourceEdges: 0,
      traceEdges: 0,
      runtimeAnnotations: 0,
      contextRuns: 0,
      retrievalCandidates: 0,
    };
  }

  private countTable(tableName: string): number {
    try {
      return Number(this.db?.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count ?? 0);
    } catch {
      return 0;
    }
  }

  private getCandidatesForRun(runId: string): RuntimeCandidateRecord[] {
    return this.db?.prepare(`
      SELECT * FROM retrieval_candidates
      WHERE context_run_id = ?
      ORDER BY status DESC, score DESC, token_count ASC
    `).all(runId).map((row) => this.rowToCandidate(row)) ?? [];
  }

  private rowToContextRun(row: Record<string, unknown>): RuntimeContextRunRecord {
    return {
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
    };
  }

  private rowToCandidate(row: Record<string, unknown>): RuntimeCandidateRecord {
    return {
      id: String(row.id ?? ""),
      contextRunId: String(row.context_run_id ?? ""),
      source: String(row.source ?? ""),
      authority: String(row.authority ?? ""),
      targetKind: String(row.target_kind ?? ""),
      targetId: typeof row.target_id === "string" ? row.target_id : null,
      status: row.status === "selected" ? "selected" : "rejected",
      score: Number(row.score ?? 0),
      tokenCount: Number(row.token_count ?? 0),
      reasons: this.parseStringArray(row.reasons_json),
      rejectedReason: typeof row.rejected_reason === "string" ? row.rejected_reason : null,
      payload: this.parseObject(row.payload_json),
    };
  }

  private parseStringArray(value: unknown): string[] {
    if (typeof value !== "string" || !value.trim()) {
      return [];
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
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
      case "memory_item": {
        const row = this.db.prepare("SELECT payload_json FROM memory_items WHERE id = ?").get(id);
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
    if (["message", "summary", "memory_item", "asset"].includes(normalized)) {
      return normalized;
    }
    if (id.startsWith("memory-item:")) {
      return "memory_item";
    }
    if (normalized === "atom" || normalized === "memory" || normalized === "evidence_atom") {
      return normalized;
    }
    if (id.includes("summary") || id.startsWith("s-")) {
      return "summary";
    }
    return "message";
  }

  private normalizeTargetId(kind: string, id: string): string {
    if (kind === "memory_item" && !id.startsWith("memory-item:")) {
      return this.normalizeMemoryItemTargetId(id);
    }
    return id;
  }

  private normalizeRole(value: unknown): RawMessage["role"] {
    return value === "system" || value === "user" || value === "assistant" || value === "tool"
      ? value
      : "user";
  }

  private targetKindForSourceId(sourceId: string): string {
    if (sourceId.startsWith("memory-item:")) {
      return "memory_item";
    }
    if (sourceId.startsWith("atom-") || sourceId.startsWith("memory-")) {
      return "memory_item";
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
    if (typeof item.metadata?.memoryId === "string") {
      return "memory_item";
    }
    if (typeof item.metadata?.atomId === "string") {
      return "memory_item";
    }
    if (item.summaryId) {
      return "summary";
    }
    if (typeof item.metadata?.docId === "string") {
      return "asset";
    }
    return "context_item";
  }

  private itemTargetId(item: ContextPlannerResult["selected"][number]["item"], fallbackId?: string): string | null {
    if (item.summaryId) {
      return item.summaryId;
    }
    if (typeof item.metadata?.messageId === "string") {
      return item.metadata.messageId;
    }
    if (typeof item.metadata?.memoryId === "string") {
      return this.normalizeMemoryItemTargetId(item.metadata.memoryId);
    }
    if (typeof item.metadata?.atomId === "string") {
      return this.normalizeMemoryItemTargetId(item.metadata.atomId);
    }
    if (typeof item.metadata?.docId === "string") {
      return item.metadata.docId;
    }
    if (fallbackId?.trim()) {
      return fallbackId;
    }
    return null;
  }

  async recordEvidenceAtoms(atoms: EvidenceAtomEntry[]): Promise<boolean> {
    if (atoms.length === 0) {
      return true;
    }
    await this.init();
    if (!this.openDatabase()) {
      return false;
    }
    let transactionStarted = false;
    try {
      this.db?.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      for (const atom of atoms) {
        const memoryItem = this.memoryItemFromEvidenceAtom(atom);
        this.upsertMemoryItem(memoryItem);
        this.upsertMemoryItemSourceEdges(memoryItem);
      }
      this.db?.exec("COMMIT");
      transactionStarted = false;
      return true;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.db?.exec("ROLLBACK");
        } catch {
          // Preserve the original write failure.
        }
      }
      throw error;
    } finally {
      this.closeDatabase();
    }
  }

  listRawMessages(options: { sessionId?: string } = {}): RawMessage[] {
    if (!this.openDatabase()) {
      return [];
    }
    try {
      return this.db?.prepare(`
        SELECT * FROM messages
        WHERE (? IS NULL OR session_id = ?)
        ORDER BY sequence ASC, turn_number ASC, created_at ASC
      `).all(options.sessionId ?? null, options.sessionId ?? null)
        .map((row) => this.rowToMessage(row)) ?? [];
    } finally {
      this.closeDatabase();
    }
  }

  listSummaries(options: { sessionId?: string } = {}): SummaryEntry[] {
    if (!this.openDatabase()) {
      return [];
    }
    try {
      return this.db?.prepare(`
        SELECT payload_json FROM summaries
        WHERE (? IS NULL OR session_id = ?)
        ORDER BY summary_level ASC, start_turn ASC, end_turn ASC, created_at ASC
      `).all(options.sessionId ?? null, options.sessionId ?? null)
        .map((row) => this.parseObject(row.payload_json) as unknown as SummaryEntry) ?? [];
    } finally {
      this.closeDatabase();
    }
  }

  listMemories(options: { sessionId?: string } = {}): MemoryItemDraftEntry[] {
    if (!this.openDatabase()) {
      return [];
    }
    try {
      return this.db?.prepare(`
        SELECT payload_json FROM memory_items
        WHERE source_table = 'memory_item_drafts'
          AND (? IS NULL OR session_id = ?)
        ORDER BY created_at DESC
      `).all(options.sessionId ?? null, options.sessionId ?? null)
        .map((row) => this.draftFromMemoryItem(
          this.normalizeMemoryItemEntry(this.parseObject(row.payload_json) as unknown as MemoryItemEntry),
        )) ?? [];
    } finally {
      this.closeDatabase();
    }
  }

  async replaceMemories(memories: MemoryItemDraftEntry[]): Promise<boolean> {
    await this.init();
    if (!this.openDatabase()) {
      return false;
    }
    let transactionStarted = false;
    try {
      this.db?.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      this.deleteMemoryItemsFromSourceTables(["memory_item_drafts"]);
      for (const memory of memories) {
        const memoryItem = this.memoryItemFromDraft(memory);
        this.upsertMemoryItem(memoryItem);
        this.upsertMemoryItemSourceEdges(memoryItem);
      }
      this.db?.exec("COMMIT");
      transactionStarted = false;
      return true;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.db?.exec("ROLLBACK");
        } catch {
          // Preserve the original failure.
        }
      }
      throw error;
    } finally {
      this.closeDatabase();
    }
  }

  listEvidenceAtoms(options: { sessionId?: string } = {}): EvidenceAtomEntry[] {
    if (!this.openDatabase()) {
      return [];
    }
    try {
      return this.db?.prepare(`
        SELECT payload_json FROM memory_items
        WHERE source_table = 'summary_evidence_drafts'
          AND (? IS NULL OR session_id = ?)
        ORDER BY session_id ASC, created_at ASC, kind ASC, id ASC
      `).all(options.sessionId ?? null, options.sessionId ?? null)
        .map((row) => this.evidenceAtomFromMemoryItem(
          this.normalizeMemoryItemEntry(this.parseObject(row.payload_json) as unknown as MemoryItemEntry),
        )) ?? [];
    } finally {
      this.closeDatabase();
    }
  }

  private normalizeMemoryItemEntry(entry: MemoryItemEntry): MemoryItemEntry {
    const scope = this.normalizeMemoryItemScope(entry.scope ?? entry.scopeType);
    const contextPolicy = this.normalizeMemoryItemContextPolicy(entry.contextPolicy);
    const promotionState = this.normalizeMemoryItemPromotionState(entry.promotionState);
    const content = entry.content ?? entry.text;
    return {
      ...entry,
      kind: this.normalizeMemoryItemKind(entry.kind),
      status: this.normalizeMemoryItemStatus(entry.status),
      scope,
      scopeType: this.normalizeMemoryItemScope(entry.scopeType ?? scope),
      scopeId: entry.scopeId ?? this.memoryItemScopeId(scope, entry),
      evidenceLevel: this.normalizeMemoryItemEvidenceLevel(entry.evidenceLevel),
      contextPolicy,
      text: entry.text ?? content,
      content,
      confidence: this.numberFromUnknown(entry.confidence, 0.5),
      stability: this.stabilityFromUnknown(entry.stability),
      priority: this.numberFromUnknown(entry.priority, 50),
      promotionState,
      tags: entry.tags ?? [],
      sourceIds: entry.sourceIds ?? [],
      sourceRefs: entry.sourceRefs ?? [],
      supersedes: entry.supersedes ?? [],
      conflictsWith: entry.conflictsWith ?? [],
      supports: entry.supports ?? [],
      metadata: entry.metadata ?? {},
    };
  }

  private draftFromMemoryItem(item: MemoryItemEntry): MemoryItemDraftEntry {
    const metadata = item.metadata ?? {};
    const draftKind = typeof metadata.draftKind === "string" ? metadata.draftKind : "";
    const kind: MemoryItemDraftEntry["kind"] =
      draftKind === "user_fact" ||
      draftKind === "assistant_decision" ||
      draftKind === "project_state" ||
      draftKind === "solution" ||
      draftKind === "diagnostic" ||
      draftKind === "constraint"
        ? draftKind
        : item.kind === "decision"
          ? "assistant_decision"
          : item.kind === "project_state"
            ? "project_state"
            : item.kind === "lesson"
              ? "solution"
              : item.kind === "diagnosis"
                ? "diagnostic"
                : item.kind === "constraint"
                  ? "constraint"
                  : "user_fact";
    const draftSourceType = metadata.draftSourceType;
    const sourceType: MemoryItemDraftEntry["sourceType"] =
      draftSourceType === "observation" || draftSourceType === "snapshot" || draftSourceType === "raw_message"
        ? draftSourceType
        : "raw_message";
    return {
      id: item.sourceId || item.id.replace(/^memory-item:/, ""),
      eventId: typeof metadata.eventId === "string" ? metadata.eventId : undefined,
      sessionId: item.sessionId,
      agentId: item.agentId,
      projectId: item.projectId,
      topicId: item.topicId,
      kind,
      recordStatus: item.status === "candidate" || item.status === "rejected" || item.status === "expired" ? "archived" : item.status,
      supersededById: typeof metadata.supersededById === "string" ? metadata.supersededById : undefined,
      text: item.text,
      fingerprint: typeof metadata.fingerprint === "string" ? metadata.fingerprint : this.hash(`${item.kind}:${item.text}`),
      tags: item.tags,
      createdAt: item.createdAt,
      sourceType,
      sourceIds: item.sourceIds,
      sourceSequenceMin: typeof metadata.sourceSequenceMin === "number" ? metadata.sourceSequenceMin : undefined,
      sourceSequenceMax: typeof metadata.sourceSequenceMax === "number" ? metadata.sourceSequenceMax : undefined,
      sourceStartTimestamp: item.validFrom,
      sourceEndTimestamp: item.validUntil,
      metadata,
    };
  }

  private evidenceAtomFromMemoryItem(item: MemoryItemEntry): EvidenceAtomEntry {
    const metadata = item.metadata ?? {};
    const evidenceDraftType = metadata.evidenceDraftType;
    const type: EvidenceAtomEntry["type"] =
      evidenceDraftType === "constraint" ||
      evidenceDraftType === "decision" ||
      evidenceDraftType === "exact_fact" ||
      evidenceDraftType === "blocker" ||
      evidenceDraftType === "next_step" ||
      evidenceDraftType === "entity"
        ? evidenceDraftType
        : item.kind === "decision"
          ? "decision"
          : item.kind === "constraint"
            ? "constraint"
            : item.kind === "procedure"
              ? "next_step"
              : item.kind === "diagnosis"
                ? "blocker"
                : "exact_fact";
    const sourceBinding = metadata.sourceBinding && typeof metadata.sourceBinding === "object"
      ? metadata.sourceBinding as EvidenceAtomEntry["sourceBinding"]
      : undefined;
    const sourceMessageIds = item.sourceIds.filter((id) => this.targetKindForSourceId(id) === "message");
    const summaryId = item.sourceIds.find((id) => this.targetKindForSourceId(id) === "summary");
    return {
      id: item.sourceId || item.id.replace(/^memory-item:/, ""),
      eventId: typeof metadata.eventId === "string" ? metadata.eventId : undefined,
      sessionId: item.sessionId,
      agentId: item.agentId,
      projectId: item.projectId,
      topicId: item.topicId,
      recordStatus: item.status === "candidate" || item.status === "rejected" || item.status === "expired" ? "archived" : item.status,
      atomStatus: "accepted",
      type,
      text: item.text,
      retrievalText: item.text,
      tags: item.tags,
      confidence: item.confidence,
      importance: typeof metadata.importance === "number" ? metadata.importance : Math.max(0.1, Math.min(1, (100 - item.priority) / 100)),
      stability: typeof metadata.stability === "number" ? metadata.stability : item.stability === "high" ? 0.9 : item.stability === "low" ? 0.25 : 0.5,
      sourceTraceComplete: item.evidenceLevel === "source_verified" && !item.inferred,
      sourceSummaryId: summaryId ?? "",
      sourceBinding,
      sourceMessageIds,
      startTurn: 0,
      endTurn: 0,
      sourceHash: typeof metadata.sourceHash === "string" ? metadata.sourceHash : undefined,
      sourceMessageCount: typeof metadata.sourceMessageCount === "number" ? metadata.sourceMessageCount : sourceMessageIds.length || undefined,
      validFrom: item.validFrom,
      validUntil: item.validUntil,
      conflictGroupId: item.conflictsWith[0],
      createdAt: item.createdAt,
      metadata,
    };
  }

  private normalizeMemoryItemKind(kind: string): MemoryItemKind {
    const allowed: MemoryItemKind[] = [
      "preference",
      "principle",
      "decision",
      "constraint",
      "lesson",
      "project_state",
      "correction",
      "procedure",
      "claim",
      "diagnosis",
      "kb_candidate",
      "general",
    ];
    return allowed.includes(kind as MemoryItemKind) ? kind as MemoryItemKind : "general";
  }

  private normalizeMemoryItemStatus(status: string): MemoryItemEntry["status"] {
    if (status === "candidate" || status === "active" || status === "superseded" ||
      status === "rejected" || status === "archived" || status === "expired") {
      return status;
    }
    return "candidate";
  }

  private normalizeMemoryItemScope(scope: string): MemoryItemScope {
    if (scope === "agent" || scope === "session" || scope === "project" ||
      scope === "user_private_to_agent" || scope === "global_principle" || scope === "global") {
      return scope;
    }
    return "session";
  }

  private normalizeMemoryItemEvidenceLevel(value: string): MemoryItemEntry["evidenceLevel"] {
    switch (value) {
      case "source_verified":
      case "high":
        return "source_verified";
      case "stated":
      case "medium":
      case "low":
        return "stated";
      case "inferred":
      case "none":
        return "inferred";
      default:
        return "inferred";
    }
  }

  private normalizeMemoryItemContextPolicy(value: string): MemoryItemEntry["contextPolicy"] {
    switch (value) {
      case "on_recall":
        return "on_demand";
      case "auto":
        return "default";
      case "strict":
      case "forensic":
        return "strict_only";
      case "never":
      case "on_demand":
      case "default":
      case "always_core":
      case "project_active":
      case "strict_only":
        return value;
      default:
        return "on_demand";
    }
  }

  private normalizeMemoryItemPromotionState(value: string): MemoryItemEntry["promotionState"] {
    switch (value) {
      case "review_pending":
        return "drafted";
      case "promoted":
        return "exported";
      case "skipped":
        return "rejected";
      case "none":
      case "candidate":
      case "kb_candidate":
      case "drafted":
      case "approved":
      case "exported":
      case "rejected":
        return value;
      default:
        return "none";
    }
  }

  listMemoryItems(options: { sessionId?: string; agentId?: string } = {}): MemoryItemEntry[] {
    if (!this.openDatabase()) {
      return [];
    }
    try {
      return this.db?.prepare(`
        SELECT payload_json FROM memory_items
        WHERE (? IS NULL OR session_id = ?)
          AND (? IS NULL OR agent_id = ?)
        ORDER BY updated_at DESC, created_at DESC
      `).all(
        options.sessionId ?? null,
        options.sessionId ?? null,
        options.agentId ?? null,
        options.agentId ?? null,
      )
        .map((row) => this.normalizeMemoryItemEntry(this.parseObject(row.payload_json) as unknown as MemoryItemEntry)) ?? [];
    } finally {
      this.closeDatabase();
    }
  }

  async upsertRuntimeRecord<T extends Record<string, unknown>>(entry: RuntimeRecordEntry<T>): Promise<boolean> {
    await this.init();
    if (!this.openDatabase()) {
      return false;
    }
    try {
      const now = new Date().toISOString();
      this.prepare(`
        INSERT INTO runtime_records (
          kind, id, session_id, agent_id, created_at, updated_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, id) DO UPDATE SET
          session_id=excluded.session_id,
          agent_id=excluded.agent_id,
          updated_at=excluded.updated_at,
          payload_json=excluded.payload_json
      `)?.run(
        entry.kind,
        entry.id,
        entry.sessionId ?? null,
        entry.agentId ?? null,
        entry.createdAt || now,
        entry.updatedAt || now,
        this.stringify(entry.payload),
      );
      if (entry.kind === "knowledge_raw") {
        const memoryItem = this.memoryItemFromKnowledgeRaw(entry.payload as unknown as KnowledgeRawEntry);
        this.upsertMemoryItem(memoryItem);
        this.upsertMemoryItemSourceEdges(memoryItem);
      }
      return true;
    } finally {
      this.closeDatabase();
    }
  }

  listRuntimeRecords<T extends Record<string, unknown> = Record<string, unknown>>(
    kind: string,
    options: { sessionId?: string; agentId?: string } = {},
  ): RuntimeRecordEntry<T>[] {
    if (!this.openDatabase()) {
      return [];
    }
    try {
      return this.db?.prepare(`
        SELECT kind, id, session_id, agent_id, created_at, updated_at, payload_json
        FROM runtime_records
        WHERE kind = ?
          AND (? IS NULL OR session_id = ?)
          AND (? IS NULL OR agent_id = ?)
        ORDER BY updated_at DESC, created_at DESC
      `).all(kind, options.sessionId ?? null, options.sessionId ?? null, options.agentId ?? null, options.agentId ?? null)
        .map((row) => ({
          kind: String(row.kind ?? kind),
          id: String(row.id ?? ""),
          sessionId: typeof row.session_id === "string" ? row.session_id : undefined,
          agentId: typeof row.agent_id === "string" ? row.agent_id : undefined,
          createdAt: String(row.created_at ?? ""),
          updatedAt: String(row.updated_at ?? ""),
          payload: this.parseObject(row.payload_json) as T,
        })) ?? [];
    } finally {
      this.closeDatabase();
    }
  }

  async deleteRuntimeRecords(kind: string, options: { sessionId?: string; agentId?: string } = {}): Promise<number> {
    await this.init();
    if (!this.openDatabase()) {
      return 0;
    }
    try {
      if (kind === "knowledge_raw") {
        const where = `
          source_table = 'knowledge_raw'
          AND source_id IN (
            SELECT id FROM runtime_records
            WHERE kind = ?
              AND (? IS NULL OR session_id = ?)
              AND (? IS NULL OR agent_id = ?)
          )
        `;
        this.prepare(`
          DELETE FROM source_edges
          WHERE source_kind = 'memory_item'
            AND source_id IN (SELECT id FROM memory_items WHERE ${where})
        `)?.run(kind, options.sessionId ?? null, options.sessionId ?? null, options.agentId ?? null, options.agentId ?? null);
        this.prepare(`
          DELETE FROM trace_edges
          WHERE source_kind = 'memory_item'
            AND source_id IN (SELECT id FROM memory_items WHERE ${where})
        `)?.run(kind, options.sessionId ?? null, options.sessionId ?? null, options.agentId ?? null, options.agentId ?? null);
        this.prepare(`DELETE FROM memory_items WHERE ${where}`)
          ?.run(kind, options.sessionId ?? null, options.sessionId ?? null, options.agentId ?? null, options.agentId ?? null);
      }
      this.prepare(`
        DELETE FROM runtime_records
        WHERE kind = ?
          AND (? IS NULL OR session_id = ?)
          AND (? IS NULL OR agent_id = ?)
      `)?.run(kind, options.sessionId ?? null, options.sessionId ?? null, options.agentId ?? null, options.agentId ?? null);
      return this.getSingleNumber("SELECT changes() AS count");
    } finally {
      this.closeDatabase();
    }
  }

  private ftsRuntimeStatus(): RuntimeStoreStatus["ftsStatus"] {
    if (!this.enabled) {
      return "unavailable";
    }
    return this.ftsReady ? "ready" : "lazy_not_initialized";
  }

  private queryTerms(query: string): string[] {
    const seen = new Set<string>();
    const normalizedQuery = query.toLowerCase().replace(/^history\s+recall\s*:\s*/i, "");
    const rawTerms = normalizedQuery
      .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
      .map((term) => term.trim())
      .map((term) => this.normalizeRuntimeQueryTerm(term));
    return rawTerms
      .filter((term) => {
        if (term.length < 2 || SQLITE_RUNTIME_STOP_WORDS.has(term) || seen.has(term)) {
          return false;
        }
        seen.add(term);
        return true;
      });
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

  private distinctiveFtsTerms(terms: string[]): string[] {
    const seen = new Set<string>();
    return terms
      .map((term) => this.normalizeRuntimeQueryTerm(term).replace(/[^a-z0-9]+/g, ""))
      .filter((term) => {
        if (term.length < 2 || SQLITE_RUNTIME_STOP_WORDS.has(term) || seen.has(term)) {
          return false;
        }
        seen.add(term);
        return true;
      })
      .sort((left, right) => right.length - left.length);
  }

  private normalizeRuntimeQueryTerm(term: string): string {
    const lower = term.toLowerCase().trim();
    if (lower.length <= 4) {
      return lower;
    }
    return lower.replace(/(?:ingly|edly|ing|ed|es|s)$/i, "");
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
