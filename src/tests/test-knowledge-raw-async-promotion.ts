import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-knowledge-raw-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "knowledge-raw-session",
    contextWindow: 200,
    contextThreshold: 0.5,
    freshTailTokens: 24,
    maxFreshTailTurns: 1,
    compactionBatchTurns: 2,
    summaryMaxOutputTokens: 160,
    strictCompaction: true,
    compactionBarrierEnabled: true,
    knowledgePromotionEnabled: false,
    knowledgePromotionManualReviewEnabled: true,
    kbCandidateEnabled: true,
    kbWriteEnabled: true,
    kbPromotionMode: "balanced_auto" as const,
    kbPromotionStrictness: "medium" as const,
    kbExportEnabled: true,
  };

  await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });

  const runtime = new ChaunyomsSessionRuntime(
    { info(): void {}, warn(): void {}, error(): void {} },
    {
      async call(params: { prompt: string }): Promise<string> {
        if (params.prompt.includes("git-friendly unified markdown knowledge base")) {
          return JSON.stringify({
            shouldWrite: true,
            reason: "accepted_knowledge_raw_candidate",
            bucket: "decisions",
            slug: "queue-retry-policy",
            title: "Queue Retry Policy",
            summary: "Canonical retry policy for queue workers.",
            tags: ["retry", "queue"],
            canonicalKey: "queue-retry-policy",
            body: "# Queue Retry Policy\n\n## Why it matters\n\nRetries must stay consistent.\n\n## Canonical knowledge\n\nUse capped exponential backoff with five retries.\n\n## Evidence\n\nDerived from the accepted summary candidate.\n",
            status: "active",
          });
        }

        return JSON.stringify({
          summary: "Retry policy for queue workers was formalized.",
          keywords: ["retry", "queue", "workers"],
          toneTag: "focused",
          memoryType: "decision",
          phase: "implementation",
          constraints: ["avoid duplicate processing"],
          decisions: ["use capped exponential backoff"],
          blockers: [],
          nextSteps: [],
          keyEntities: ["QueueWorker", "RetryCoordinator"],
          exactFacts: ["five retries max"],
          promotionIntent: "promote",
        });
      },
    },
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

  for (let turn = 1; turn <= 6; turn += 1) {
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `u-${turn}`,
      role: "user",
      content: `User turn ${turn}: finalize queue retry policy ${"alpha ".repeat(30)}`,
      turnNumber: turn,
    });
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `a-${turn}`,
      role: "assistant",
      content: `Assistant turn ${turn}: use capped exponential backoff with five retries ${"beta ".repeat(30)}`,
      turnNumber: turn,
    });
  }

  const compactResult = await runtime.compact({
    sessionId: config.sessionId,
    config,
    totalBudget: config.contextWindow,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });
  assert(compactResult.compacted, "expected explicit compaction to create a knowledge raw candidate");
  await runtime.waitForBackgroundWork();

  const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  const knowledgeRawEntries = stores.knowledgeRawStore.getAll();
  assert(knowledgeRawEntries.length > 0, "expected accepted summaries to enter knowledge raw");
  assert(
    knowledgeRawEntries.some((entry) => entry.status === "promoted"),
    "expected async knowledge worker to promote at least one knowledge raw candidate",
  );

  const docs = stores.knowledgeStore.searchRelatedDocuments("queue retry policy", 3);
  assert(docs.length > 0, "expected unified knowledge store to contain promoted wiki output");
  assert(
    docs.some((entry) => entry.canonicalKey === "queue-retry-policy"),
    "expected promoted wiki output to keep the canonical key",
  );

  await rm(dir, { recursive: true, force: true });
  console.log("test-knowledge-raw-async-promotion passed");
}

void main();
