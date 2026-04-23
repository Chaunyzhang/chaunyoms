import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-tool-turn-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "tool-turn-session",
  };
  await mkdir(config.workspaceDir, { recursive: true });

  const runtime = new ChaunyomsSessionRuntime(
    { info(): void {}, warn(): void {}, error(): void {} },
    null,
    config,
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
    content: "Check the config file.",
  });
  await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "assistant-1",
    role: "assistant",
    content: "Looking it up now.",
  });
  await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "tool-1",
    role: "tool",
    content: "config.json contains enableTools=false",
  });
  await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "assistant-2",
    role: "assistant",
    content: "I found it in config.json.",
  });

  const stores = await runtime.getSessionStores({
    sessionId: config.sessionId,
    config,
  });
  const turnMap = stores.rawStore.getAll().map((message) => ({
    id: message.id,
    role: message.role,
    turnNumber: message.turnNumber,
  }));

  assert(turnMap.length === 4, "expected four ingested messages");
  assert(turnMap[0]?.turnNumber === 1, "expected user message to start turn 1");
  assert(turnMap[1]?.turnNumber === 1, "expected assistant message to stay in turn 1");
  assert(turnMap[2]?.turnNumber === 1, "expected tool message to stay in turn 1");
  assert(turnMap[3]?.turnNumber === 1, "expected follow-up assistant message to stay in turn 1");

  await rm(dir, { recursive: true, force: true });
  console.log("test-tool-turn-numbering passed");
}

void main();
