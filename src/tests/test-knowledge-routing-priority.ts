import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  await writeFile(
    path.join(config.knowledgeBaseDir, "topic-index.json"),
    JSON.stringify({
      topics: [
        {
          topicId: "queue retry policy",
          latestVersion: 1,
          latestFile: "queue-retry-policy-v1.md",
          summary: "External policy note for queue retries.",
        },
      ],
    }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(config.knowledgeBaseDir, "queue-retry-policy-v1.md"),
    "# Imported Queue Retry Policy\n\nImported knowledge says to retry indefinitely.\n",
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
  assert(/Imported knowledge says to retry indefinitely/i.test(knowledgeText), "expected retrieval to also return imported knowledge content");
  assert(/1\.\s+Queue Retry Policy/i.test(knowledgeText), "expected the managed canonical hit to rank first for generic knowledge queries");
  assert(knowledgeRetrieve.details.topRecordType === "managed_record", "expected generic knowledge query to prefer managed records");
  assert(knowledgeRetrieve.details.conflictDetected === true, "expected unified knowledge retrieval to flag internal/external canonical conflicts");
  assert(
    Array.isArray(knowledgeRetrieve.details.conflictCanonicalKeys) &&
      knowledgeRetrieve.details.conflictCanonicalKeys.includes("queue-retry-policy"),
    "expected conflict metadata to include the shared canonical key",
  );

  const importedRoute = await retrieval.executeMemoryRoute({
    sessionId: config.sessionId,
    config,
    query: "Look in imported knowledge in the knowledge base for the queue retry policy",
  });
  assert(importedRoute.details.route === "knowledge", "expected imported knowledge queries to still use the unified knowledge route");

  const importedRetrieve = await retrieval.executeMemoryRetrieve({
    sessionId: config.sessionId,
    config,
    query: "Look in imported knowledge in the knowledge base for the queue retry policy",
  });
  const importedText = String(importedRetrieve.content[0]?.text ?? "");
  assert(/Imported knowledge says to retry indefinitely/i.test(importedText), "expected imported knowledge queries to surface imported content through the unified corpus");
  assert(/1\.\s+queue retry policy/i.test(importedText), "expected imported source record to rank first when the query explicitly prefers imported knowledge");

  const importCachePath = path.join(
    config.sharedDataDir,
    "plugin-cache",
    "knowledge-import",
    Buffer.from(path.normalize(config.knowledgeBaseDir)).toString("hex").slice(0, 24),
    ".chaunyoms-import-index.json",
  );
  await access(importCachePath);
  let cacheLeakedIntoKnowledgeDir = false;
  try {
    await access(path.join(config.knowledgeBaseDir, ".chaunyoms-import-index.json"));
    cacheLeakedIntoKnowledgeDir = true;
  } catch {
    // Expected: the cache file should not exist inside the external knowledge dir.
  }
  assert(!cacheLeakedIntoKnowledgeDir, "expected imported knowledge cache to stay outside the external knowledge directory");

  await rm(dir, { recursive: true, force: true });
  console.log("test-knowledge-routing-priority passed");
}

void main();
