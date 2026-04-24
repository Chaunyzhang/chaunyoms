import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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

function buildTurnContent(turn: number): string {
  const specialMarkers: Record<number, string> = {
    9: "DEPLOY_TOKEN=alpha-09",
    27: "GATEWAY_PORT=15432",
    45: "ROLLUP_PHASE=validation",
    63: "QUEUE_WINDOW=7m",
  };
  const marker = specialMarkers[turn] ?? `routine-${turn}`;
  return `Replay turn ${turn}. Keep project memory organized. ${marker}. ${"context ".repeat(18)}`;
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-long-session-replay-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "long-session-replay",
    contextWindow: 260,
    contextThreshold: 0.38,
    freshTailTokens: 30,
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
        const prompt = params.prompt;
        const exactFacts = [
          ...new Set(
            Array.from(
              prompt.matchAll(/(?:DEPLOY_TOKEN|GATEWAY_PORT|ROLLUP_PHASE|QUEUE_WINDOW)=([A-Za-z0-9:-]+)/g),
            ).map((match) => match[0]),
          ),
        ];
        return JSON.stringify({
          summary: `Replay summary preserving ${exactFacts[0] ?? "routine context"}.`,
          keywords: ["replay", "memory", ...(exactFacts.length > 0 ? exactFacts : [])],
          toneTag: "focused",
          memoryType: "project_state",
          phase: "implementation",
          constraints: ["keep source recall reliable"],
          decisions: ["preserve exact runtime markers"],
          blockers: [],
          nextSteps: ["continue replay validation"],
          keyEntities: ["ChaunyomsSessionRuntime", "SummaryIndexStore"],
          exactFacts,
          promotionIntent: "candidate",
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

  for (let turn = 1; turn <= 72; turn += 1) {
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `u-${turn}`,
      role: "user",
      content: buildTurnContent(turn),
      turnNumber: turn,
    });
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `a-${turn}`,
      role: "assistant",
      content: `Assistant replay response ${turn}. ${buildTurnContent(turn)}`,
      turnNumber: turn,
    });

    if (turn % 6 === 0) {
      await runtime.afterTurn({
        sessionId: config.sessionId,
        config,
        totalBudget: config.contextWindow,
        systemPromptTokens: 0,
        runtimeMessages: [],
      });
    }
  }

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

  const recallResult = await retrieval.executeMemoryRetrieve({
    sessionId: config.sessionId,
    config,
    query: "find the exact GATEWAY_PORT from earlier",
  });
  const recallText = String(recallResult.content[0]?.text ?? "");
  assert(/GATEWAY_PORT=15432/.test(recallText), "expected long replay recall to recover exact raw detail");
  assert(
    Array.isArray(recallResult.details.sourceTrace) &&
      recallResult.details.sourceTrace.some((trace: { verified?: boolean }) => trace.verified === true),
    "expected verified source trace in long replay recall",
  );

  const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  const summaries = stores.summaryStore.getAllSummaries({ sessionId: config.sessionId });
  assert(summaries.length >= 4, "expected multiple compaction summaries during replay");
  assert(
    summaries.some((entry) => entry.nodeKind === "branch"),
    "expected replay to create branch rollups after multiple compactions",
  );

  const logPath = path.join(config.dataDir, "logs", `${config.sessionId}.after-turn.log`);
  await access(logPath);
  const logContent = await readFile(logPath, "utf8");
  assert(/lastCompactionDiagnostics/.test(logContent), "expected replay after-turn log to capture compaction diagnostics");
  assert(/configPreset/.test(logContent), "expected replay after-turn log to capture config preset");

  await rm(dir, { recursive: true, force: true });
  console.log("test-long-session-replay passed");
}

void main();
