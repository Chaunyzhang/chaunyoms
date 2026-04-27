import { access, mkdtemp, readdir, rm } from "node:fs/promises";
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-navigation-write-"));
  const dataDir = path.join(dir, "data");
  const workspaceDir = path.join(dir, "workspace");
  const sharedDataDir = path.join(dir, "shared");
  const memoryVaultDir = path.join(dir, "vault");
  const knowledgeBaseDir = path.join(sharedDataDir, "knowledge-base");
  const sessionId = "navigation-write-session";

  const runtime = new ChaunyomsSessionRuntime(
    { info(): void {}, warn(): void {}, error(): void {} },
    {
      async call(): Promise<string> {
        return JSON.stringify({
          summary: "Compacted navigation snapshot should now be written.",
          keywords: ["compaction", "navigation"],
          toneTag: "focused",
        });
      },
    },
    {
      ...DEFAULT_BRIDGE_CONFIG,
      dataDir,
      workspaceDir,
      sharedDataDir,
      memoryVaultDir,
      knowledgeBaseDir,
      sessionId,
      contextWindow: 200,
      contextThreshold: 0.5,
      freshTailTokens: 24,
      maxFreshTailTurns: 1,
      compactionBatchTurns: 2,
      summaryMaxOutputTokens: 120,
      strictCompaction: true,
      compactionBarrierEnabled: true,
      agentVaultMirrorEnabled: true,
    },
    createRuntimeLayerDependencies(),
  );

  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir,
    workspaceDir,
    sharedDataDir,
    memoryVaultDir,
    knowledgeBaseDir,
    sessionId,
    contextWindow: 200,
    contextThreshold: 0.5,
    freshTailTokens: 24,
    maxFreshTailTurns: 1,
    compactionBatchTurns: 2,
    summaryMaxOutputTokens: 120,
    strictCompaction: true,
    compactionBarrierEnabled: true,
    agentVaultMirrorEnabled: true,
  };

  await runtime.bootstrap({
    sessionId,
    config,
    totalBudget: 1000,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });

  await runtime.ingest({
    sessionId,
    config,
    id: "u-1",
    role: "user",
    content: "Short user turn that should not trigger compaction.",
    turnNumber: 1,
  });
  await runtime.ingest({
    sessionId,
    config,
    id: "a-1",
    role: "assistant",
    content: "Short assistant turn that should not trigger compaction.",
    turnNumber: 1,
  });

  await runtime.afterTurn({
    sessionId,
    config,
    totalBudget: 1000,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });

  const workspaceMemoryDir = path.join(workspaceDir, "memory");
  const vaultNavigationPath = path.join(
    memoryVaultDir,
    "agents",
    config.agentId,
    "navigation",
    "NAVIGATION.md",
  );
  assert(!(await exists(vaultNavigationPath)), "expected vault navigation snapshot to stay absent before compaction");
  const preCompactionFiles = await readdir(workspaceMemoryDir).catch(() => []);
  assert(preCompactionFiles.length === 0, "expected workspace memory snapshots to stay empty before compaction");
  let stores = await runtime.getSessionStores({ sessionId, config });
  assert(stores.summaryStore.getAllSummaries().length === 0, "expected afterTurn not to create summaries");

  for (let turn = 2; turn <= 7; turn += 1) {
    await runtime.ingest({
      sessionId,
      config,
      id: `u-${turn}`,
      role: "user",
      content: `User turn ${turn}: ${"alpha ".repeat(30)}`,
      turnNumber: turn,
    });
    await runtime.ingest({
      sessionId,
      config,
      id: `a-${turn}`,
      role: "assistant",
      content: `Assistant turn ${turn}: ${"beta ".repeat(30)}`,
      turnNumber: turn,
    });
  }

  await runtime.assemble({
    sessionId,
    config,
    totalBudget: 200,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });

  const summariesAfterAssemble = stores.summaryStore.getAllSummaries().length;
  await runtime.afterTurn({
    sessionId,
    config,
    totalBudget: 200,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });
  assert(await exists(vaultNavigationPath), "expected vault navigation snapshot to be written after compaction");
  const postCompactionFiles = await readdir(workspaceMemoryDir);
  assert(postCompactionFiles.length > 0, "expected workspace memory snapshot to be written after compaction");

  stores = await runtime.getSessionStores({ sessionId, config });
  assert(
    stores.summaryStore.getAllSummaries().length === summariesAfterAssemble,
    "expected afterTurn not to create additional summaries after assemble compaction",
  );
  assert(
    stores.summaryStore.getAllSummaries().length > 0,
    "expected compaction-triggered navigation write test to create at least one summary",
  );

  await rm(dir, { recursive: true, force: true });
  console.log("test-navigation-write-on-compaction passed");
}

void main();
