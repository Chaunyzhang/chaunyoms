import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-vector-fallback-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "vector-fallback-session",
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

  const payloadAdapter = new OpenClawPayloadAdapter(
    () => ({
      config: {
        agents: {
          defaults: {
            memorySearch: {
              enabled: true,
              provider: "fake-embed",
            },
          },
        },
      },
    }),
    () => ({ info(): void {}, warn(): void {}, error(): void {} }),
  );

  const fixedPrefixProvider: FixedPrefixProvider = {
    async load() { return []; },
    async getKnowledgeBaseHit() { return null; },
    async hasKnowledgeBaseTopicHit() { return false; },
  };
  const retrieval = new ChaunyomsRetrievalService(
    runtime,
    payloadAdapter,
    {
      fixedPrefixProvider,
    },
  );

  const result = await retrieval.executeMemoryRetrieve({
    sessionId: config.sessionId,
    config,
    query: "something related to architecture docs in the knowledge base",
  });

  assert(result.details.route === "knowledge", "expected knowledge queries to stay in the unified knowledge route");
  assert(result.details.retrievalHitType === "recent_tail", "expected no vector hit in the standard runtime path");
  assert(
    String(result.content[0]?.text ?? "").includes("No standard retrieval hit found"),
    "expected standard fallback text when no reviewed knowledge exists",
  );

  await rm(dir, { recursive: true, force: true });
  console.log("test-retrieval-standard-no-vector passed");
}

void main();
