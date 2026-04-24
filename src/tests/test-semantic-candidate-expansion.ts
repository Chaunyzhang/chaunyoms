import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";
import { ChaunyomsRetrievalService } from "../runtime/ChaunyomsRetrievalService";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";
import { StablePrefixAdapter } from "../data/StablePrefixAdapter";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-semantic-candidate-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "semantic-candidate-session",
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
      id: "summary-semantic-1",
      sessionId: config.sessionId,
      agentId: config.agentId,
      summary: "Queue workers should use capped exponential retry backoff after failures.",
      keywords: ["queue", "workers", "retry", "backoff"],
      toneTag: "neutral",
      constraints: ["avoid endless retries"],
      decisions: ["use capped exponential backoff"],
      blockers: [],
      exactFacts: ["five retries max"],
      startTurn: 1,
      endTurn: 2,
      tokenCount: 24,
      createdAt: new Date().toISOString(),
      sourceHash: "semantic-hash",
      sourceMessageCount: 2,
    },
    {
      shouldWrite: true,
      reason: "canonical_retry_backoff",
      bucket: "patterns",
      slug: "queue-worker-retry-backoff",
      title: "Queue Worker Retry Backoff",
      summary: "Canonical retry and backoff policy for queue workers.",
      tags: ["queue", "workers", "retry", "backoff"],
      canonicalKey: "queue-worker-retry-backoff",
      body: "# Queue Worker Retry Backoff\n\nUse capped exponential backoff for queue workers after failures.\n",
      status: "active",
    },
    {
      sessionId: config.sessionId,
      sourceHash: "semantic-hash",
      sourceMessageCount: 2,
      promptVersion: "test-v1",
      modelName: "test-model",
    },
  );

  const payloadAdapter = new OpenClawPayloadAdapter(
    () => ({ config: {} }),
    () => ({ info(): void {}, warn(): void {}, error(): void {} }),
  );
  const retrieval = new ChaunyomsRetrievalService(
    runtime,
    payloadAdapter,
    {
      fixedPrefixProvider: new StablePrefixAdapter(),
    },
  );

  const result = await retrieval.executeMemoryRetrieve({
    sessionId: config.sessionId,
    config,
    query: "How should queue workers back off after failures?",
  });

  const text = String(result.content[0]?.text ?? "");
  assert(/capped exponential backoff/i.test(text), "expected semantic candidate fallback to reach authoritative knowledge");
  assert(result.details.route === "recent_tail", "expected original router to stay on recent_tail for generic phrasing");
  assert(result.details.retrievalHitType === "knowledge", "expected semantic fallback to return governed knowledge");
  assert(
    Array.isArray(result.details.semanticCandidates) && result.details.semanticCandidates.length > 0,
    "expected semantic candidates diagnostics",
  );
  assert(
    Array.isArray(result.details.fallbackTrace) &&
      result.details.fallbackTrace.some((item: { reason?: string }) => item.reason === "reviewed_knowledge_candidate_hit"),
    "expected reviewed knowledge fallback trace",
  );

  await rm(dir, { recursive: true, force: true });
  console.log("test-semantic-candidate-expansion passed");
}

void main();
