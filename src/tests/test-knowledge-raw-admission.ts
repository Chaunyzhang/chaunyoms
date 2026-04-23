import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-knowledge-raw-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "knowledge-raw-session",
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

  const remembered = await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "user-remember-1",
    role: "user",
    content: "帮我记一下：这个项目默认只用 pnpm，不用 npm。",
  });
  assert(remembered.ingested, "expected explicit project memory message to be ingested");

  let stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  assert(stores.rawStore.getAll().length === 1, "expected remembered user message to stay in raw history");
  assert(stores.knowledgeRawStore.count() === 1, "expected explicit remember message to be promoted into knowledge raw");
  const rememberedEntry = stores.knowledgeRawStore.getAll()[0];
  assert(rememberedEntry.memoryIntent === "project_memory", "expected explicit remember message to be tagged as project_memory");
  assert(rememberedEntry.kind === "constraint", "expected project toolchain preference to be normalized as a knowledge constraint");
  assert(rememberedEntry.tags.includes("config"), "expected remembered entry to keep config tag");

  const temporary = await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "user-remember-2",
    role: "user",
    content: "帮我记一下，等下提醒我跑测试。",
  });
  assert(temporary.ingested, "expected temporary reminder to remain in transcript history");
  stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  assert(stores.rawStore.getAll().length === 2, "expected temporary reminder to still be present in transcript raw history");
  assert(stores.knowledgeRawStore.count() === 1, "expected temporary reminder to stay out of knowledge raw");

  const toolOutput = await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "tool-output-1",
    role: "tool",
    content: "{\"file\":\"src/index.ts\",\"status\":\"changed\"}",
  });
  assert(toolOutput.ingested, "expected substantive tool output to be accepted");
  stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  assert(stores.rawStore.getAll().length === 2, "expected tool output to avoid transcript raw and go to observation");
  assert(stores.observationStore.count() === 1, "expected tool output to be persisted as an observation");
  assert(stores.knowledgeRawStore.count() === 2, "expected substantive tool output to yield a knowledge raw candidate");

  const toolReceipt = await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "tool-receipt-1",
    role: "tool",
    content: "Command completed.",
  });
  assert(!toolReceipt.ingested, "expected low-value tool receipt to be blocked by unified ingest ingress");

  await rm(dir, { recursive: true, force: true });
  console.log("test-knowledge-raw-admission passed");
}

void main();
