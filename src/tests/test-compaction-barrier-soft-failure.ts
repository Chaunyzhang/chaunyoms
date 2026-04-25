import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-barrier-soft-failure-"));
  const warnings: Array<Record<string, unknown>> = [];
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "barrier-soft-failure",
    contextWindow: 120,
    contextThreshold: 0.25,
    freshTailTokens: 12,
    maxFreshTailTurns: 1,
    compactionBatchTurns: 1,
    strictCompaction: true,
    compactionBarrierEnabled: true,
  };

  try {
    await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });
    const runtime = new ChaunyomsSessionRuntime(
      {
        info(): void {},
        warn(event: string, data?: Record<string, unknown>): void {
          warnings.push({ event, ...(data ?? {}) });
        },
        error(): void {},
      },
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

    for (let turn = 1; turn <= 10; turn += 1) {
      const content = `Turn ${turn} payload ${"history pressure ".repeat(60)}`;
      await runtime.ingest({
        sessionId: config.sessionId,
        config,
        id: `u-${turn}`,
        role: "user",
        content,
        turnNumber: turn,
      });
      await runtime.ingest({
        sessionId: config.sessionId,
        config,
        id: `a-${turn}`,
        role: "assistant",
        content: `Assistant ${content}`,
        turnNumber: turn,
      });
    }

    const assembled = await runtime.assemble({
      sessionId: config.sessionId,
      config,
      totalBudget: config.contextWindow,
      systemPromptTokens: 0,
      runtimeMessages: [],
    });

    assert(assembled.items.length > 0, "expected assemble to return fallback context items");
    assert(
      warnings.some((warning) => warning.event === "compaction_barrier_soft_failed"),
      "expected compaction barrier to soft-fail instead of throwing",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-compaction-barrier-soft-failure passed");
}

void main();
