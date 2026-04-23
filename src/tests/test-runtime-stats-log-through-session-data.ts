import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-stats-log-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "stats-log-session",
    contextThreshold: 0.95,
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

  await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "user-1",
    role: "user",
    content: "Check whether after-turn stats are still written.",
  });
  await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "assistant-1",
    role: "assistant",
    content: "After-turn stats should be logged through the data layer.",
  });
  await runtime.afterTurn({
    sessionId: config.sessionId,
    config,
    totalBudget: config.contextWindow,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });

  const logPath = path.join(config.dataDir, "logs", `${config.sessionId}.after-turn.log`);
  await access(logPath);
  const logContent = await readFile(logPath, "utf8");
  assert(logContent.includes("\"sessionId\":\"stats-log-session\""), "expected after-turn stats log to include the session id");

  await rm(dir, { recursive: true, force: true });
  console.log("test-runtime-stats-log-through-session-data passed");
}

void main();
