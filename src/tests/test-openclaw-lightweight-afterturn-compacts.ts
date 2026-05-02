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
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-openclaw-lite-"));
  const sessionId = "openclaw-lightweight-afterturn";
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
    strictCompaction: true,
    compactionBarrierEnabled: false,
    openClawRuntimeProfile: "lightweight" as const,
  };
  const llmCalls: LlmCallParams[] = [];

  try {
    await mkdir(config.workspaceDir, { recursive: true });
    const runtime = new ChaunyomsSessionRuntime(
      { info(): void {}, warn(): void {}, error(): void {} },
      {
        async call(params: LlmCallParams): Promise<string> {
          llmCalls.push(params);
          return [
            "# Recall Summary",
            "## Scope",
            "Compacted source span.",
            "## Exact Facts",
            "- Business Administration degree",
            "## Retrieval Cues",
            "- degree",
            "- graduated",
          ].join("\n");
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
          ? `I graduated with a degree in Business Administration. ${"background ".repeat(20)}`
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
    assert(summaries.length > 0, "expected lightweight afterTurn to create at least one summary");
    assert(
      summaries.every((summary) => (summary.summaryLevel ?? 1) === 1 && (summary.nodeKind ?? "leaf") === "leaf"),
      "expected lightweight afterTurn path to generate only leaf summaries",
    );
    assert(
      llmCalls.some((call) =>
        String(call.prompt).includes("compact recall-oriented source-backed summary") ||
        String(call.prompt).includes("# Recall Summary")),
      "expected lightweight afterTurn compaction to invoke recall summary generation after enough closed turns",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-openclaw-lightweight-afterturn-compacts passed");
}

void main();
