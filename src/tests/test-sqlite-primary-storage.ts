import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { SessionDataLayer } from "../data/SessionDataLayer";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { MemoryItemDraftEntry, EvidenceAtomEntry, SummaryEntry } from "../types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const nodeRequire = createRequire(__filename);

type TestSQLiteDatabase = {
  prepare(sql: string): { all(): Array<{ name?: unknown }> };
  close(): void;
};

type TestSQLiteModule = {
  DatabaseSync?: new (location: string) => TestSQLiteDatabase;
};

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-sqlite-primary-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "sqlite-primary-session",
    agentId: "sqlite-primary-agent",
  };

  await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });
  const layer = new SessionDataLayer({ info(): void {}, warn(): void {}, error(): void {} });
  const stores = await layer.ensure(config.sessionId, config);
  const now = new Date().toISOString();

  await layer.appendRawMessage({
    id: "msg-1",
    sessionId: config.sessionId,
    agentId: config.agentId,
    role: "user",
    content: "Store this only in SQLite primary storage.",
    turnNumber: 1,
    createdAt: now,
    tokenCount: 9,
    compacted: false,
  });

  const summary: SummaryEntry = {
    id: "summary-1",
    sessionId: config.sessionId,
    agentId: config.agentId,
    recordStatus: "active",
    summary: "SQLite primary summary.",
    keywords: ["sqlite", "primary"],
    toneTag: "focused",
    memoryType: "decision",
    phase: "implementation",
    constraints: ["JSON hot-path persistence is off."],
    decisions: ["SQLite is the primary runtime ledger."],
    blockers: [],
    nextSteps: [],
    keyEntities: ["SQLiteRuntimeStore"],
    exactFacts: ["Runtime store counts must match repository counts."],
    openQuestions: [],
    conflicts: [],
    startTurn: 1,
    endTurn: 1,
    tokenCount: 24,
    sourceMessageIds: ["msg-1"],
    sourceMessageCount: 1,
    sourceHash: "hash-1",
    summaryLevel: 1,
    nodeKind: "leaf",
    promotionIntent: "candidate",
    createdAt: now,
  };
  await stores.summaryStore.addSummary(summary);

  const memory: MemoryItemDraftEntry = {
    id: "memory-1",
    sessionId: config.sessionId,
    agentId: config.agentId,
    kind: "assistant_decision",
    recordStatus: "active",
    text: "SQLite primary is the runtime source of truth.",
    fingerprint: "sqlite-primary-decision",
    tags: ["sqlite"],
    createdAt: now,
    sourceType: "snapshot",
    sourceIds: ["summary-1"],
  };
  await stores.memoryItemDraftStore.addEntries([memory]);

  const atom: EvidenceAtomEntry = {
    id: "atom-1",
    sessionId: config.sessionId,
    agentId: config.agentId,
    recordStatus: "active",
    atomStatus: "accepted",
    type: "decision",
    text: "SQLite primary owns runtime state.",
    retrievalText: "sqlite primary runtime state",
    tags: ["sqlite"],
    confidence: 0.9,
    importance: 0.8,
    stability: 0.8,
    sourceTraceComplete: true,
    sourceSummaryId: "summary-1",
    sourceMessageIds: ["msg-1"],
    startTurn: 1,
    endTurn: 1,
    createdAt: now,
  };
  await stores.evidenceAtomStore.upsertMany([atom]);

  const status = layer.getRuntimeStore().getStatus();
  assert(status.enabled, "expected SQLite runtime to be enabled");
  assert(status.counts.messages === 1, "expected message count in SQLite");
  assert(status.counts.summaries === 1, "expected summary count in SQLite");
  assert(status.counts.memories === 0, "SQLite primary must not persist legacy memories rows");
  assert(status.counts.evidenceAtoms === 0, "SQLite primary must not persist legacy evidence atom rows");
  assert(status.counts.memoryItems === 2, "expected memory/evidence inputs to persist only as MemoryItems");

  const sqlite = nodeRequire("node:sqlite") as TestSQLiteModule;
  if (sqlite.DatabaseSync) {
    const db = new sqlite.DatabaseSync(layer.getRuntimeStore().getPath());
    try {
      assert(db.prepare("PRAGMA table_info(memories)").all().length === 0, "legacy memories table must not exist");
      assert(db.prepare("PRAGMA table_info(evidence_atoms)").all().length === 0, "legacy evidence_atoms table must not exist");
    } finally {
      db.close();
    }
  }

  const agentDir = path.join(config.dataDir, "agents", config.agentId);
  assert(!existsSync(path.join(agentDir, `${config.agentId}.raw.jsonl`)), "raw JSONL hot-path file should not be written");
  assert(!existsSync(path.join(agentDir, `${config.agentId}.summaries.json`)), "summary JSON hot-path file should not be written");
  assert(!existsSync(path.join(agentDir, `${config.agentId}.memory-item-drafts.json`)), "MemoryItem JSON hot-path file should not be written");
  assert(!existsSync(path.join(agentDir, `${config.agentId}.evidence-atoms.json`)), "atom JSON hot-path file should not be written");

  layer.getRuntimeStore().dispose();
  await rm(dir, { recursive: true, force: true });
  console.log("test-sqlite-primary-storage passed");
}

void main();
