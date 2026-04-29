import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { EnvironmentDoctor } from "../system/EnvironmentDoctor";
import { MemoryItemDraftEntry, RawMessage, SummaryEntry } from "../types";

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

function parseTestVector(value: unknown): number[] {
  if (value instanceof Uint8Array) {
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    const vector: number[] = [];
    for (let offset = 0; offset < value.byteLength; offset += 4) {
      vector.push(view.getFloat32(offset, true));
    }
    return vector;
  }
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => Number(entry)) : [];
  }
  return [];
}

function cosineDistance(leftValue: unknown, rightValue: unknown): number {
  const left = parseTestVector(leftValue);
  const right = parseTestVector(rightValue);
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm <= 0 || rightNorm <= 0) {
    return 1;
  }
  return 1 - (dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)));
}

async function main(): Promise<void> {
  const doctor = EnvironmentDoctor.run();
  assert(doctor.checks.some((check) => check.name === "node_sqlite"), "environment doctor should inspect node:sqlite");
  assert(doctor.checks.some((check) => check.name === "sqlite_load_extension_api"), "environment doctor should inspect loadExtension support");
  const missingExtensionDoctor = EnvironmentDoctor.run({
    vectorExtensionPath: path.join(os.tmpdir(), "missing-sqlite-vec-extension"),
  });
  assert(missingExtensionDoctor.checks.some((check) => check.name === "vector_extension_load" && !check.ok), "environment doctor should probe configured vector extension paths");

  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-rag-graph-"));
  try {
    const store = new SQLiteRuntimeStore({
      dbPath: path.join(dir, "runtime.sqlite"),
      agentId: "agent-rag",
      knowledgeBaseDir: path.join(dir, "knowledge"),
      logger,
    });
    const messages: RawMessage[] = [{
      id: "msg-rag-1",
      sessionId: "session-rag",
      agentId: "agent-rag",
      role: "user",
      content: "Use deployment port 15432 for socket binding.",
      turnNumber: 1,
      sequence: 1,
      createdAt: "2026-04-29T00:00:00.000Z",
      tokenCount: 10,
      compacted: true,
    }];
    const summaries: SummaryEntry[] = [{
      id: "summary-rag-1",
      sessionId: "session-rag",
      agentId: "agent-rag",
      summary: "Deployment architecture decisions include the socket binding port.",
      keywords: ["deployment", "architecture"],
      toneTag: "neutral",
      constraints: [],
      decisions: ["Use deployment port 15432."],
      blockers: [],
      exactFacts: ["15432"],
      startTurn: 1,
      endTurn: 1,
      sourceMessageIds: ["msg-rag-1"],
      tokenCount: 12,
      createdAt: "2026-04-29T00:00:01.000Z",
    }];
    const memories: MemoryItemDraftEntry[] = [
      {
        id: "socket-binding",
        sessionId: "session-rag",
        agentId: "agent-rag",
        kind: "constraint",
        recordStatus: "active",
        text: "Use deployment port 15432 for socket binding.",
        fingerprint: "socket-binding",
        tags: ["socket", "deployment"],
        createdAt: "2026-04-29T00:00:02.000Z",
        sourceType: "raw_message",
        sourceIds: ["msg-rag-1"],
      },
      {
        id: "architecture-link",
        sessionId: "session-rag",
        agentId: "agent-rag",
        kind: "assistant_decision",
        recordStatus: "active",
        text: "Graph recall should connect deployment architecture decisions.",
        fingerprint: "architecture-link",
        tags: ["deployment", "architecture"],
        createdAt: "2026-04-29T00:00:03.000Z",
        sourceType: "snapshot",
        sourceIds: ["summary-rag-1"],
      },
    ];
    await store.mirror({ messages, summaries, memories });
    const config = {
      ...DEFAULT_BRIDGE_CONFIG,
      sessionId: "session-rag",
      agentId: "agent-rag",
      ragEnabled: true,
      ragProvider: "sqlite_vec" as const,
      embeddingEnabled: true,
      embeddingProvider: "local_hash" as const,
      graphEnabled: true,
      graphProvider: "sqlite_graph" as const,
      graphBuilderEnabled: true,
      graphBuilderProvider: "deterministic" as const,
      vectorSearchMaxCandidates: 8,
      ragFallbackToBruteForce: true,
    };
    const index = store.indexRetrievalEnhancements(config, {
      sessionId: "session-rag",
      agentId: "agent-rag",
    });
    assert(index.ok, `enhancement index should not fail: ${index.warnings.join(",")}`);
    assert(index.vectorIndexed >= 2, "embedding index should create vector chunks/embeddings");
    assert(index.graphNodesIndexed >= 2, "graph builder should create graph nodes");
    assert(index.graphEdgesIndexed > 0, "graph builder should create associative graph edges");

    const status = store.getStatus();
    assert(status.counts.vectorChunks >= 2, "runtime status should expose vector chunk counts");
    assert(status.counts.vectorEmbeddings >= 2, "runtime status should expose vector embedding counts");
    assert(status.counts.graphEdges > 0, "runtime status should expose graph edge counts");
    assert(status.capabilities.ragFallbackAvailable, "runtime status should expose brute-force fallback availability");

    const rag = store.searchVectorCandidates("socket binding port", config, {
      sessionId: "session-rag",
      agentId: "agent-rag",
    });
    assert(rag.ok, "RAG search should be isolated and return ok with fallback");
    assert(rag.mode === "brute_force", "sqlite_vec should degrade to brute-force when no vector extension is loaded");
    assert(rag.degraded, "sqlite_vec fallback should be marked degraded");
    assert(rag.candidates.length > 0, "RAG search should return local vector candidates");

    const unsafeStore = store as unknown as {
      openDatabase(): boolean;
      db: {
        function(name: string, fn: (left: unknown, right: unknown) => number): void;
      } | null;
      vectorExtensionLoaded: boolean;
    };
    assert(unsafeStore.openDatabase(), "test should be able to open sqlite runtime");
    unsafeStore.db?.function("vec_distance_cosine", cosineDistance);
    unsafeStore.vectorExtensionLoaded = true;
    const sqliteVec = store.searchVectorCandidates("socket binding port", config, {
      sessionId: "session-rag",
      agentId: "agent-rag",
    });
    assert(sqliteVec.ok, "sqlite_vec path should return ok when vec_distance_cosine is available");
    assert(sqliteVec.mode === "sqlite_vec", "sqlite_vec path should use SQLite vector distance instead of brute-force");
    assert(!sqliteVec.degraded, "loaded sqlite_vec path should not be marked degraded");
    assert(sqliteVec.candidates.some((candidate) => candidate.reason === "sqlite_vec_vector_similarity"), "sqlite_vec path should mark extension-backed candidate reasons");

    const graph = store.searchGraphCandidates("socket binding", config, {
      sessionId: "session-rag",
      agentId: "agent-rag",
    });
    assert(graph.ok, "Graph search should be isolated and return ok");
    assert(graph.mode === "sqlite_graph", "Graph search should use sqlite_graph provider");
    assert(graph.candidates.length > 0, "Graph search should return associative neighbor candidates");
    assert(graph.candidates.some((candidate) => String(candidate.metadata?.reasons ?? "").includes("graph:")), "Graph candidates should carry edge reasons");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-rag-graph-rerank-node-env passed");
}

void main();
