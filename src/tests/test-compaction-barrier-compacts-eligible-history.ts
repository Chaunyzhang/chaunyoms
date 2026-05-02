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
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-barrier-exhausts-history-"));
  const sessionId = "barrier-exhausts-history";
  const summaryCalls: Array<{ maxOutputTokens?: number; prompt: string; responseFormat?: string }> = [];
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId,
    contextWindow: 260,
    contextThreshold: 0.3,
    freshTailTokens: 24,
    maxFreshTailTurns: 1,
    compactionBatchTurns: 2,
    summaryMaxOutputTokens: 5,
    strictCompaction: true,
    compactionBarrierEnabled: true,
  };

  try {
    await mkdir(config.workspaceDir, { recursive: true });
    const runtime = new ChaunyomsSessionRuntime(
      { info(): void {}, warn(): void {}, error(): void {} },
      {
        async call(params: LlmCallParams): Promise<string> {
          summaryCalls.push({
            maxOutputTokens: params.maxOutputTokens,
            prompt: params.prompt,
            responseFormat: params.responseFormat,
          });
          return [
            "# Recall Summary",
            "## Scope",
            "Compacted source span for eligible history.",
            "## Exact Facts",
            "- freshTailTurns=1",
            "## Retrieval Cues",
            "- eligible-history",
            "- barrier",
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

    for (let turn = 1; turn <= 8; turn += 1) {
      await runtime.ingest({
        sessionId,
        config,
        id: `u-${turn}`,
        role: "user",
        content: `User turn ${turn}: ${"historical payload ".repeat(45)}`,
        turnNumber: turn,
      });
      await runtime.ingest({
        sessionId,
        config,
        id: `a-${turn}`,
        role: "assistant",
        content: `Assistant turn ${turn}: ${"historical response ".repeat(45)}`,
        turnNumber: turn,
      });
      await runtime.ingest({
        sessionId,
        config,
        id: `tool-${turn}`,
        role: "tool",
        content: `TOOL_SHOULD_NOT_ENTER_RECALL_SUMMARY_SOURCE ${"tool output ".repeat(120)}`,
        turnNumber: turn,
      });
    }

    await runtime.assemble({
      sessionId,
      config,
      totalBudget: config.contextWindow,
      systemPromptTokens: 0,
      runtimeMessages: [],
    });

    const stores = await runtime.getSessionStores({ sessionId, config });
    const uncompactedTurns = [
      ...new Set(stores.rawStore.getUncompactedMessages({ sessionId }).map((message) => message.turnNumber)),
    ];

    assert(
      uncompactedTurns.length === 1 && uncompactedTurns[0] === 8,
      `expected only the fresh tail turn to remain uncompacted, got ${uncompactedTurns.join(", ")}`,
    );
    assert(
      stores.summaryStore.getAllSummaries({ sessionId }).length > 0,
      "expected barrier compaction to create at least one summary",
    );
    const recallSummaryCalls = summaryCalls.filter((call) =>
      call.prompt.includes("Recall Summary") || call.prompt.includes("source-backed summary"),
    );
    assert(recallSummaryCalls.length > 0, "expected at least one recall summary generation call");
    assert(
      recallSummaryCalls.every((call) => !call.prompt.includes("TOOL_SHOULD_NOT_ENTER_RECALL_SUMMARY_SOURCE")),
      "expected tool output to be excluded from recall summary source prompts",
    );
    assert(
      recallSummaryCalls.every((call) => (call.maxOutputTokens ?? 0) > config.summaryMaxOutputTokens),
      "expected recall summary output budget to be based on source size instead of fixed config limit",
    );
    assert(
      recallSummaryCalls.every((call) => call.responseFormat === "text"),
      "expected recall summary generation to request Markdown text, not JSON",
    );
    const summaries = stores.summaryStore.getAllSummaries({ sessionId });
    assert(
      summaries.every((summary) => !summary.sourceMessageIds?.some((id) => id.startsWith("tool-"))),
      "expected tool messages to be excluded from summary source bindings",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-compaction-barrier-compacts-eligible-history passed");
}

void main();
