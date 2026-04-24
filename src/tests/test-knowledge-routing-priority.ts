import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";
import { ChaunyomsRetrievalService } from "../runtime/ChaunyomsRetrievalService";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";
import { StablePrefixAdapter } from "../data/StablePrefixAdapter";
import { VectorSearchFallbackStore } from "../data/VectorSearchFallbackStore";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-knowledge-routing-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "knowledge-routing-session",
    knowledgePromotionEnabled: true,
  };

  await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });
  await mkdir(config.knowledgeBaseDir, { recursive: true });

  const runtime = new ChaunyomsSessionRuntime(
    { info(): void {}, warn(): void {}, error(): void {} },
    null,
    config,
    createRuntimeLayerDependencies(),
  );
  await runtime.bootstrap({
    sessionId: config.sessionId,
    config,
    totalBudget: config.contextWindow,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });

  const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  await stores.knowledgeStore.writePromotion(
    {
      id: "summary-knowledge-1",
      sessionId: config.sessionId,
      agentId: config.agentId,
      summary: "Retry policy for queue workers was formalized.",
      keywords: ["retry", "queue", "workers"],
      toneTag: "neutral",
      constraints: ["avoid duplicate processing"],
      decisions: ["use capped exponential backoff"],
      blockers: [],
      exactFacts: ["five retries max"],
      startTurn: 1,
      endTurn: 2,
      tokenCount: 24,
      createdAt: new Date().toISOString(),
      sourceHash: "retry-hash",
      sourceMessageCount: 2,
    },
    {
      shouldWrite: true,
      reason: "formal_retry_policy",
      bucket: "decisions",
      slug: "queue-retry-policy",
      title: "Queue Retry Policy",
      summary: "Canonical retry policy for queue workers.",
      tags: ["retry", "queue"],
      canonicalKey: "queue-retry-policy",
      body: "# Queue Retry Policy\n\n## Canonical knowledge\n\nManaged knowledge says to use capped exponential backoff with five retries.\n",
      status: "active",
    },
    {
      sessionId: config.sessionId,
      sourceHash: "retry-hash",
      sourceMessageCount: 2,
      promptVersion: "test-v1",
      modelName: "test-model",
    },
  );

  await mkdir(path.join(config.knowledgeBaseDir, "raw"), { recursive: true });
  await writeFile(
    path.join(config.knowledgeBaseDir, "raw", "queue-retry-manual-note.md"),
    [
      "---",
      "title: Queue Retry Manual Note",
      "summary: Manual raw note for queue retry policy.",
      "canonical_key: queue-retry-manual-note",
      "tags:",
      "  - retry",
      "  - queue",
      "---",
      "",
      "# Queue Retry Manual Note",
      "",
      "Manual raw knowledge says queue retries must stop rather than retry indefinitely.",
      "",
    ].join("\n"),
    "utf8",
  );

  const payloadAdapter = new OpenClawPayloadAdapter(
    () => ({ config: {} }),
    () => ({ info(): void {}, warn(): void {}, error(): void {} }),
  );
  const retrieval = new ChaunyomsRetrievalService(
    runtime,
    payloadAdapter,
    () => ({ config: {} }),
    {
      fixedPrefixProvider: new StablePrefixAdapter(),
      navigationRepository: new StablePrefixAdapter(),
      vectorSearchFallback: new VectorSearchFallbackStore(),
    },
  );

  const knowledgeRoute = await retrieval.executeMemoryRoute({
    sessionId: config.sessionId,
    config,
    query: "Check the knowledge base for the queue retry policy",
  });
  assert(knowledgeRoute.details.route === "knowledge", "expected default knowledge queries to route to the unified knowledge corpus");

  const knowledgeRetrieve = await retrieval.executeMemoryRetrieve({
    sessionId: config.sessionId,
    config,
    query: "Check the knowledge base for the queue retry policy",
  });
  const knowledgeText = String(knowledgeRetrieve.content[0]?.text ?? "");
  assert(/Managed knowledge says/i.test(knowledgeText), "expected retrieval to return managed knowledge content");
  assert(/Manual raw knowledge says queue retries must stop/i.test(knowledgeText), "expected retrieval to also return user-provided raw knowledge content");
  assert(knowledgeRetrieve.details.topRecordType === "knowledge_record", "expected unified knowledge query to return undifferentiated knowledge records");
  assert(
    typeof knowledgeRetrieve.details.knowledgeHitCount === "number" &&
      knowledgeRetrieve.details.knowledgeHitCount >= 2,
    "expected managed and manual raw records to share the same knowledge hit path",
  );

  const rawRoute = await retrieval.executeMemoryRoute({
    sessionId: config.sessionId,
    config,
    query: "Look in raw knowledge in the knowledge base for the queue retry policy",
  });
  assert(rawRoute.details.route === "knowledge", "expected raw knowledge queries to still use the unified knowledge route");

  const rawRetrieve = await retrieval.executeMemoryRetrieve({
    sessionId: config.sessionId,
    config,
    query: "Look in raw knowledge in the knowledge base for the queue retry policy",
  });
  const rawText = String(rawRetrieve.content[0]?.text ?? "");
  assert(/Manual raw knowledge says queue retries must stop/i.test(rawText), "expected raw knowledge queries to surface manual raw content through the unified corpus");
  assert(!("importedHitCount" in rawRetrieve.details), "expected retrieval metadata to stop splitting imported/internal counts");

  await rm(dir, { recursive: true, force: true });
  console.log("test-knowledge-routing-priority passed");
}

void main();
