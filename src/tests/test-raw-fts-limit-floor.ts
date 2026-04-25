import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";
import { ChaunyomsRetrievalService } from "../runtime/ChaunyomsRetrievalService";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";
import { FixedPrefixProvider } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const fixedPrefixProvider: FixedPrefixProvider = {
  async load() { return []; },
  async getKnowledgeBaseHit() { return null; },
  async hasKnowledgeBaseTopicHit() { return false; },
};

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-raw-fts-limit-"));
  try {
    const config = {
      ...DEFAULT_BRIDGE_CONFIG,
      dataDir: path.join(dir, "data"),
      workspaceDir: path.join(dir, "workspace"),
      sharedDataDir: path.join(dir, "shared"),
      memoryVaultDir: path.join(dir, "vault"),
      knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
      sessionId: "raw-fts-limit-session",
      contextWindow: 760,
      contextThreshold: 0.34,
      freshTailTokens: 48,
      maxFreshTailTurns: 1,
      compactionBatchTurns: 10,
      summaryMaxOutputTokens: 460,
      strictCompaction: true,
      compactionBarrierEnabled: true,
      configPreset: "balanced" as const,
    };
    await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });

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

    for (let turn = 1; turn <= 70; turn += 1) {
      await runtime.ingest({
        sessionId: config.sessionId,
        config,
        id: `noise-${turn}`,
        role: "user",
        turnNumber: turn,
        content: `LongMemEval noisy session | user: travel packing discussion ${turn}. Costa Rica trip planning, shirts, luggage, weather, itinerary, and generic vacation details.`,
      });
    }
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: "answer-shirts",
      role: "user",
      turnNumber: 71,
      content: "LongMemEval target | answer date 2023/05/30 | T12:7 | user: For my Costa Rica 5-day trip, I brought 3 shirts and one light jacket. | has_answer: true",
    });
    for (let turn = 72; turn <= 95; turn += 1) {
      await runtime.ingest({
        sessionId: config.sessionId,
        config,
        id: `after-noise-${turn}`,
        role: "assistant",
        turnNumber: turn,
        content: `LongMemEval noisy follow-up | assistant: more travel packing suggestions ${turn}, mentioning shirts and Costa Rica without the exact count.`,
      });
    }

    const retrieval = new ChaunyomsRetrievalService(
      runtime,
      new OpenClawPayloadAdapter(
        () => ({ config: {} }),
        () => ({ info(): void {}, warn(): void {}, error(): void {} }),
      ),
      { fixedPrefixProvider },
    );
    const result = await retrieval.executeMemoryRetrieve({
      sessionId: config.sessionId,
      config,
      query: "History recall: How many shirts did I bring to Costa Rica?",
      rawFts: true,
      deepRecall: true,
      rawFtsLimit: 1,
    });
    const text = String(result.content[0]?.text ?? "");
    const details = result.details as Record<string, unknown>;
    const answerCandidates = Array.isArray(details.answerCandidates)
      ? details.answerCandidates as Array<Record<string, unknown>>
      : [];

    assert(text.includes("3 shirts") || text.includes("3 (object"), "expected exact shirts count in source recall output");
    assert(answerCandidates.some((candidate) => candidate.text === "3" && candidate.sourceVerified === true), "expected source-verified count answer candidate");
    assert(Number(details.rawFtsHintCount ?? 0) > 1, "deep recall must not honor caller rawFtsLimit as a shrinking cap");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-raw-fts-limit-floor passed");
}

void main();
