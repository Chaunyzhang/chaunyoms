import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

function turnText(turn: number): string {
  const marker = turn === 52 ? "BENCHMARK_GATEWAY_PORT=15432" : `benchmark-routine-${turn}`;
  return `Benchmark turn ${turn}. ${marker}. ${"memory ".repeat(18)}`;
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-benchmark-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "benchmark-session",
    contextWindow: 320,
    contextThreshold: 0.4,
    freshTailTokens: 32,
    maxFreshTailTurns: 1,
    compactionBatchTurns: 3,
    summaryMaxOutputTokens: 160,
    strictCompaction: true,
    compactionBarrierEnabled: true,
  };

  await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });

  const runtime = new ChaunyomsSessionRuntime(
    { info(): void {}, warn(): void {}, error(): void {} },
    {
      async call(params): Promise<string> {
        const exactFacts = [
          ...new Set(
            Array.from(
              params.prompt.matchAll(/BENCHMARK_GATEWAY_PORT=([A-Za-z0-9:-]+)/g),
            ).map((match) => match[0]),
          ),
        ];
        return JSON.stringify({
          summary: `Benchmark summary retaining ${exactFacts[0] ?? "routine context"}.`,
          keywords: ["benchmark", ...(exactFacts.length > 0 ? exactFacts : [])],
          toneTag: "focused",
          memoryType: "project_state",
          phase: "implementation",
          constraints: ["retain exact facts"],
          decisions: ["compact safely"],
          blockers: [],
          nextSteps: ["measure replay latency"],
          keyEntities: ["benchmark-runtime"],
          exactFacts,
          promotionIntent: "candidate",
        });
      },
    },
    config,
    createRuntimeLayerDependencies(),
  );

  const bootStart = performance.now();
  await runtime.bootstrap({
    sessionId: config.sessionId,
    config,
    totalBudget: config.contextWindow,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });
  const bootMs = performance.now() - bootStart;

  const ingestStart = performance.now();
  for (let turn = 1; turn <= 80; turn += 1) {
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `u-${turn}`,
      role: "user",
      content: turnText(turn),
      turnNumber: turn,
    });
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `a-${turn}`,
      role: "assistant",
      content: `Assistant benchmark reply ${turn}. ${turnText(turn)}`,
      turnNumber: turn,
    });

    if (turn % 8 === 0) {
      await runtime.afterTurn({
        sessionId: config.sessionId,
        config,
        totalBudget: config.contextWindow,
        systemPromptTokens: 0,
        runtimeMessages: [],
      });
    }
  }
  const ingestMs = performance.now() - ingestStart;

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

  const retrieveStart = performance.now();
  const retrievalResult = await retrieval.executeMemoryRetrieve({
    sessionId: config.sessionId,
    config,
    query: "find the exact BENCHMARK_GATEWAY_PORT=15432 from earlier",
  });
  const retrieveMs = performance.now() - retrieveStart;

  const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  const summaries = stores.summaryStore.getAllSummaries({ sessionId: config.sessionId });
  const branchCount = summaries.filter((entry) => entry.nodeKind === "branch").length;
  const leafCount = summaries.filter((entry) => entry.nodeKind !== "branch").length;
  const recallText = String(retrievalResult.content[0]?.text ?? "");
  assert(/BENCHMARK_GATEWAY_PORT=15432/.test(recallText), "benchmark retrieval failed to recover exact fact");

  const metrics = {
    scenario: "runtime-replay-benchmark",
    bootMs: Number(bootMs.toFixed(2)),
    ingestAndAfterTurnMs: Number(ingestMs.toFixed(2)),
    retrieveMs: Number(retrieveMs.toFixed(2)),
    summaryCount: summaries.length,
    branchCount,
    leafCount,
    rawMessageCount: stores.rawStore.getAll({ sessionId: config.sessionId }).length,
    durableMemoryCount: stores.durableMemoryStore.count(),
    recallHitCount: Number(retrievalResult.details.hitCount ?? 0),
    compactionTriggered: summaries.length > 0,
    retrievalHitType: retrievalResult.details.retrievalHitType,
  };

  console.log(JSON.stringify(metrics, null, 2));
  await rm(dir, { recursive: true, force: true });
}

void main();
