import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";

import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  assert(DEFAULT_BRIDGE_CONFIG.embeddingEnabled === false, "embedding must stay disabled by default");
  assert(DEFAULT_BRIDGE_CONFIG.embeddingProvider === "none", "default embedding provider must not silently use local_hash");
  assert(DEFAULT_BRIDGE_CONFIG.ragProvider === "none", "RAG provider must not be configured by default");
  assert(DEFAULT_BRIDGE_CONFIG.graphProvider === "none", "Graph provider must not be configured by default");
  assert(DEFAULT_BRIDGE_CONFIG.rerankProvider === "none", "Rerank provider must not be configured by default");
  assert(DEFAULT_BRIDGE_CONFIG.graphBuilderProvider === "none", "Graph builder provider must not be configured by default");
  assert(DEFAULT_BRIDGE_CONFIG.evidenceAnswerResolverProvider === "none", "EvidenceAnswerResolver provider must not be configured by default");

  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-vector-defaults-"));
  const store = new SQLiteRuntimeStore({
    dbPath: path.join(dir, "runtime.sqlite"),
    agentId: "test-agent",
    knowledgeBaseDir: path.join(dir, "knowledge"),
    logger: console,
  });

  const noEmbedding = store.searchVectorCandidates("where did the user travel?", {
    ...DEFAULT_BRIDGE_CONFIG,
    ragEnabled: true,
    ragProvider: "sqlite_vec",
    embeddingEnabled: false,
    embeddingProvider: "none",
  });
  assert(noEmbedding.providerAvailable === false, "RAG must not run without embeddings");
  assert(noEmbedding.providerUnavailableReason === "embedding_disabled", "disabled embedding should be explicit");
  assert(noEmbedding.warnings.includes("embedding_disabled_vector_search_skipped"), "skip reason should be surfaced");

  const externalWithoutRuntime = store.searchVectorCandidates("where did the user travel?", {
    ...DEFAULT_BRIDGE_CONFIG,
    ragEnabled: true,
    ragProvider: "sqlite_vec",
    embeddingEnabled: true,
    embeddingProvider: "external",
    embeddingModel: "external-test-model",
  });
  assert(externalWithoutRuntime.ok === false, "external embeddings must not fall back to local_hash query vectors");
  assert(
    externalWithoutRuntime.providerUnavailableReason === "embedding_provider_not_runtime_available",
    "missing external query embedder should be explicit",
  );

  console.log("test-vector-defaults-no-model passed");
}

void main();
