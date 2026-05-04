import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import { ContextPlanner } from "../engines/ContextPlanner";
import { EvidenceAtomEngine } from "../engines/EvidenceAtomEngine";
import { MemoryItemDraftEntry, KnowledgeRawEntry, RawMessage, SummaryEntry } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const logger = {
  info(): void {},
  warn(): void {},
  error(): void {},
};

const nodeRequire = createRequire(__filename);

type TestSQLiteDatabase = {
  prepare(sql: string): { all(): Array<{ name?: unknown }> };
  close(): void;
};

type TestSQLiteModule = {
  DatabaseSync?: new (location: string) => TestSQLiteDatabase;
};

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-sqlite-runtime-"));
  try {
    const store = new SQLiteRuntimeStore({
      dbPath: path.join(dir, "runtime.sqlite"),
      agentId: "agent-1",
      knowledgeBaseDir: path.join(dir, "knowledge"),
      logger,
    });
    const messages: RawMessage[] = [
      {
        id: "m-1",
        sessionId: "s-1",
        agentId: "agent-1",
        role: "user",
        content: "The deployment port is 15432.",
        turnNumber: 1,
        sequence: 1,
        createdAt: "2026-04-24T00:00:00.000Z",
        tokenCount: 8,
        compacted: true,
      },
      {
        id: "m-2",
        sessionId: "s-1",
        agentId: "agent-1",
        role: "assistant",
        content: "Recorded the deployment port.",
        turnNumber: 1,
        sequence: 2,
        createdAt: "2026-04-24T00:00:01.000Z",
        tokenCount: 6,
        compacted: true,
      },
      {
        id: "m-raw-only",
        sessionId: "s-raw",
        agentId: "agent-1",
        role: "user",
        content: "The raw-only launch phrase is amber falcon.",
        turnNumber: 1,
        sequence: 3,
        createdAt: "2026-04-24T00:00:04.000Z",
        tokenCount: 8,
        compacted: false,
      },
    ];
    const summaries: SummaryEntry[] = [{
      id: "summary-1",
      sessionId: "s-1",
      agentId: "agent-1",
      summary: "Deployment port is 15432.",
      keywords: ["deployment", "port"],
      toneTag: "neutral",
      constraints: [],
      decisions: [],
      blockers: [],
      exactFacts: ["15432"],
      startTurn: 1,
      endTurn: 1,
      sourceMessageIds: ["m-1", "m-2"],
      sourceBinding: {
        scope: "agent",
        sessionId: "s-1",
        agentId: "agent-1",
        messageIds: ["m-1", "m-2"],
      },
      tokenCount: 6,
      createdAt: "2026-04-24T00:00:02.000Z",
    }];
    const memories: MemoryItemDraftEntry[] = [{
      id: "memory-1",
      sessionId: "s-1",
      agentId: "agent-1",
      kind: "constraint",
      recordStatus: "active",
      text: "Use deployment port 15432.",
      fingerprint: "fp-1",
      tags: ["deployment"],
      createdAt: "2026-04-24T00:00:03.000Z",
      sourceType: "raw_message",
      sourceIds: ["m-1"],
      metadata: {
        factKey: "deployment_port",
        factValue: "15432",
        supersedes: ["memory-old"],
        confidence: 0.9,
        priority: 10,
      },
    }];

    const atoms = new EvidenceAtomEngine().fromSummary(summaries[0]);
    await store.mirror({ messages, summaries, memories, atoms });
    assert(store.isEnabled(), "SQLite runtime store should be enabled under Node 24");
    const initialStatus = store.getStatus();
    assert(initialStatus.counts.memories === 0, "SQLite runtime must not persist a parallel memories table");
    assert(initialStatus.counts.evidenceAtoms === 0, "SQLite runtime must not persist a parallel evidence_atoms table");
    assert(initialStatus.counts.memoryItems === 2, "SQLite runtime should materialize memoryItem/evidence inputs as MemoryItems");
    assert(initialStatus.ftsReady === true && initialStatus.ftsStatus === "ready", "FTS should be ready immediately after mirror because the runtime keeps the raw substrate write-through indexed");
    assert(store.grepMessages("15432", { sessionId: "s-1" }).length === 1, "grep should find raw source message");
    const summaryOnlyRecall = store.withAssemblyRead((runtime) =>
      runtime.getQueryRecallEvidence(
        "What deployment port did I mention earlier?",
        4,
        "question-session",
        { requireSummaryPath: true },
      ),
    );
    assert(
      summaryOnlyRecall?.rawHits.some((hit) => hit.message.id === "m-1" && hit.sourceKind === "summary"),
      "summary-only recall should expand raw evidence only through matching summary source refs",
    );
    const rawOnlyRecall = store.withAssemblyRead((runtime) =>
      runtime.getQueryRecallEvidence(
        "What raw-only launch phrase did I mention earlier?",
        4,
        "question-session",
        { requireSummaryPath: true },
      ),
    );
    assert(
      rawOnlyRecall?.rawHits.length === 0,
      "summary-only recall must not fall back to direct raw FTS/scan when no summary matches",
    );
    const ftsStatus = store.getStatus();
    assert(ftsStatus.ftsReady === true && ftsStatus.ftsStatus === "ready", "FTS should report ready after grep initializes it");
    assert(store.expand("summary", "summary-1").messages.length === 2, "expand should follow summary source edges to raw messages");
    assert(store.expand("summary", "summary:summary-1").messages.length === 2, "expand should accept OpenClaw-style summary-prefixed ids");
    assert(store.expand("auto", "summary:summary-1").messages.length === 2, "auto expand should infer summary-prefixed ids");
    assert(store.expand("message", "message:m-1").messages[0]?.id === "m-1", "expand should accept OpenClaw-style message-prefixed ids");
    assert(store.expand("auto", "source:m-1").messages[0]?.id === "m-1", "auto expand should treat source-prefixed ids as raw messages");
    assert(store.trace("summary", "summary:summary-1").some((edge) => edge.targetId === "m-1"), "trace should accept summary-prefixed ids");
    assert(store.trace("memory", "memory-1").length === 0, "legacy memory trace should not exist as a runtime layer");
    assert(store.trace("evidence_atom", atoms[0].id).length === 0, "legacy evidence atom trace should not exist as a runtime layer");
    assert(store.trace("memory_item", "memory-item:memory-1").some((edge) => edge.targetId === "m-1"), "trace should expose MemoryItem-draft-derived MemoryItem source edge");
    assert(store.trace("memory_item", "memory-item:memory-1").some((edge) => edge.relation === "supersedes" && edge.targetId === "memory-item:memory-old"), "MemoryItem should materialize supersedes trace edges");
    assert(store.replay({ sessionId: "s-1", startTurn: 1, endTurn: 1 }).length === 2, "replay should return turn messages");

    const memoryItems = store.listMemoryItems({ agentId: "agent-1" });
    const memoryItemItem = memoryItems.find((item) => item.sourceTable === "memory_item_drafts");
    const atomItem = memoryItems.find((item) => item.sourceTable === "summary_evidence_drafts");
    if (!memoryItemItem || !atomItem) {
      throw new Error("MemoryItem drafts and evidence atoms should both be mirrored as MemoryItems");
    }
    assert(memoryItemItem.kind === "constraint", "MemoryItem constraints should map to MemoryItem kind=constraint");
    assert(memoryItemItem.scope === "agent" && memoryItemItem.scopeId === "agent-1", "memoryItem MemoryItem should expose document-style scope fields");
    assert(memoryItemItem.scopeType === "agent", "MemoryItem should expose document-style scope_type alias");
    assert(memoryItemItem.content === memoryItemItem.text, "MemoryItem should expose document-style content field");
    assert(memoryItemItem.evidenceLevel === "source_verified", "raw-message memoryItem MemoryItem should carry source-verified evidence level");
    assert(memoryItemItem.contextPolicy === "default", "memoryItem MemoryItem should use the document's context_policy vocabulary");
    assert(memoryItemItem.confidence === 0.9 && memoryItemItem.priority === 10, "memoryItem MemoryItem should expose confidence and priority as fields");
    assert(memoryItemItem.sourceRefs?.some((ref) => ref.messageId === "m-1"), "memoryItem MemoryItem should expose source refs");
    assert(memoryItemItem.supports.includes("m-1"), "memoryItem MemoryItem should expose supports source ids");
    assert(memoryItemItem.supersedes.includes("memory-old"), "memoryItem MemoryItem should expose supersedes as a field");
    assert(memoryItemItem.metadata?.factKey === "deployment_port", "memoryItem MemoryItem should preserve legacy metadata fields");

    const sqlite = nodeRequire("node:sqlite") as TestSQLiteModule;
    if (sqlite.DatabaseSync) {
      const db = new sqlite.DatabaseSync(path.join(dir, "runtime.sqlite"));
      try {
        const columns = new Set(db.prepare("PRAGMA table_info(memory_items)").all().map((row) => String(row.name)));
        assert(db.prepare("PRAGMA table_info(memories)").all().length === 0, "legacy memories table must not exist");
        assert(db.prepare("PRAGMA table_info(evidence_atoms)").all().length === 0, "legacy evidence_atoms table must not exist");
        for (const column of [
          "memory_id",
          "scope_type",
          "scope_id",
          "content",
          "confidence",
          "stability",
          "priority",
          "promotion_state",
          "valid_to",
          "created_by_agent_id",
          "updated_by_agent_id",
          "metadata_json",
        ]) {
          assert(columns.has(column), `memory_items should expose document field column ${column}`);
        }
      } finally {
        db.close();
      }
    }

    assert(atomItem.evidenceLevel === "source_verified", "evidence atom MemoryItem should retain source-verified evidence level");
    assert(atomItem.contextPolicy === "strict_only", "evidence atom MemoryItem should only enter strict fact contexts by policy");
    assert(atomItem.sourceIds.includes("summary-1") && atomItem.sourceIds.includes("m-1"), "evidence atom MemoryItem should carry summary and raw source ids");
    assert(atomItem.sourceRefs?.some((ref) => ref.messageId === "m-1"), "evidence atom MemoryItem should expose source refs");
    assert(atomItem.supports.includes("summary-1"), "evidence atom MemoryItem should expose supports fields");

    const knowledgeRaw: KnowledgeRawEntry = {
      id: "knowledge-raw-1",
      sessionId: "s-1",
      agentId: "agent-1",
      sourceSummaryId: summaries[0].id,
      sourceSummary: summaries[0],
      oneLineSummary: "Deployment port belongs in reviewed knowledge.",
      intakeReason: "unit_test_candidate",
      status: "pending",
      createdAt: "2026-04-24T00:00:04.000Z",
      updatedAt: "2026-04-24T00:00:04.000Z",
    };
    await store.upsertRuntimeRecord({
      kind: "knowledge_raw",
      id: knowledgeRaw.id,
      sessionId: knowledgeRaw.sessionId,
      agentId: knowledgeRaw.agentId,
      createdAt: knowledgeRaw.createdAt,
      updatedAt: knowledgeRaw.updatedAt,
      payload: knowledgeRaw as unknown as Record<string, unknown>,
    });
    const kbItem = store.listMemoryItems({ agentId: "agent-1" }).find((item) => item.sourceTable === "knowledge_raw");
    if (!kbItem) {
      throw new Error("knowledge raw should be mirrored as a MemoryItem record");
    }
    assert(kbItem.kind === "kb_candidate", "knowledge raw should be mirrored as a kb_candidate MemoryItem");
    assert(kbItem.promotionState === "candidate", "pending knowledge raw should retain candidate promotion state");
    assert(kbItem.contextPolicy === "never", "kb_candidate MemoryItems should not enter the hot context path by default");
    assert(kbItem.scope === "agent" && kbItem.scopeId === "agent-1", "knowledge raw MemoryItem should expose document-style scope fields");
    assert(kbItem.content === "Deployment port belongs in reviewed knowledge.", "knowledge raw MemoryItem should expose content field");
    assert(kbItem.sourceIds.includes("summary-1") && kbItem.supports.includes("summary-1"), "knowledge raw MemoryItem should expose source/support fields");
    assert(kbItem.priority === 80, "knowledge raw MemoryItem should be a low hot-path priority candidate field");
    assert(store.trace("memory_item", "memory-item:knowledge-raw-1").some((edge) => edge.targetId === "summary-1"), "knowledge raw MemoryItem should trace to source summary");
    await store.deleteRuntimeRecords("knowledge_raw", { agentId: "agent-1" });
    assert(!store.listMemoryItems({ agentId: "agent-1" }).some((item) => item.sourceTable === "knowledge_raw"), "deleting knowledge raw records should remove their MemoryItem record");

    const planner = new ContextPlanner();
    const plan = planner.plan([
      planner.buildCandidate({ kind: "message", tokenCount: 5, role: "user", content: "A" }, "recent_tail", 0),
      planner.buildCandidate({ kind: "message", tokenCount: 5, role: "user", content: "A" }, "recent_tail", 1),
    ], { budget: 20, runId: "run-1", createdAt: "2026-04-24T00:00:04.000Z" });
    store.recordContextPlan({
      sessionId: "s-1",
      agentId: "agent-1",
      totalBudget: 20,
      intent: "test",
      plan,
    });
    assert(store.getLatestContextRuns(1)[0]?.id === "run-1", "context run should be recorded in SQLite");
    const verify = store.verifyIntegrity();
    assert(verify.selectedCandidatesWithoutTarget === 0, "selected runtime context candidates should have synthetic target ids for why/trace");
    const inspect = store.inspectContextRun("run-1");
    assert(inspect.selected.every((candidate) => typeof candidate.targetId === "string" && candidate.targetId.length > 0), "selected candidates should expose target ids");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-sqlite-runtime-store passed");
}

void main();
