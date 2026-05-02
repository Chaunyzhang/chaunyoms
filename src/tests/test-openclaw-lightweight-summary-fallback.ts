import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";
import { LlmCallParams } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-openclaw-fallback-"));
  const sessionId = "openclaw-lightweight-summary-fallback";
  const llmCalls: LlmCallParams[] = [];
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId,
    contextWindow: 1200,
    contextThreshold: 0.12,
    freshTailTokens: 120,
    maxFreshTailTurns: 1,
    compactionBatchTurns: 2,
    summaryMaxOutputTokens: 200,
    strictCompaction: false,
    compactionBarrierEnabled: false,
    openClawRuntimeProfile: "lightweight" as const,
  };

  try {
    await mkdir(config.workspaceDir, { recursive: true });
    const runtime = new ChaunyomsSessionRuntime(
      { info(): void {}, warn(): void {}, error(): void {} },
      {
        async call(params: LlmCallParams): Promise<string> {
          llmCalls.push(params);
          return "";
        },
      },
      config,
      createRuntimeLayerDependencies(),
    );

    await runtime.bootstrap({
      sessionId,
      config,
      totalBudget: config.contextWindow,
      systemPromptTokens: 0,
      runtimeMessages: [],
    });

    for (let turn = 1; turn <= 6; turn += 1) {
      await runtime.ingest({
        sessionId,
        config,
        id: `u-${turn}`,
        role: "user",
        content: turn === 1
          ? `I graduated with a degree in Business Administration. ${"background ".repeat(16)}`
          : `User turn ${turn}: ${"filler ".repeat(40)}`,
        turnNumber: turn,
      });
      await runtime.ingest({
        sessionId,
        config,
        id: `a-${turn}`,
        role: "assistant",
        content: `Assistant turn ${turn}: ${"response ".repeat(40)}`,
        turnNumber: turn,
      });
    }

    await runtime.afterTurn({
      sessionId,
      config,
      totalBudget: config.contextWindow,
      systemPromptTokens: 0,
      runtimeMessages: [],
    });

    const stores = await runtime.getSessionStores({ sessionId, config });
    const summaries = stores.summaryStore.getAllSummaries({ sessionId });
    assert(summaries.length > 0, "expected fallback summary to be persisted");
    assert(
      summaries[0].summary.includes("# Recall Summary"),
      "expected fallback markdown recall summary heading",
    );
    assert(
      summaries[0].exactFacts.some((fact) => /Business Administration/i.test(fact)),
      "expected fallback summary to retain exact fact anchors",
    );
    assert(llmCalls.length > 0, "expected summary generator to still attempt LLM first");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-openclaw-lightweight-summary-fallback passed");
}

void main();
