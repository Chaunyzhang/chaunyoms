import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";
import { ChaunyomsRetrievalService } from "../runtime/ChaunyomsRetrievalService";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";
import { FixedPrefixProvider, NavigationRepository, VectorSearchFallbackRepository } from "../types";

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
    async getSharedInsightHit() { return null; },
    async getKnowledgeBaseHit() { return null; },
    async hasSharedInsightHint() { return false; },
    async hasKnowledgeBaseTopicHit() { return false; },
  };
  const navigationRepository: NavigationRepository = {
    async getNavigationHit() { return null; },
    async getNavigationStateHit() { return null; },
    async hasNavigationHint() { return false; },
    async hasStructuredNavigationState() { return false; },
    async writeNavigationSnapshot() { return { written: false }; },
  };
  const vectorSearchFallback: VectorSearchFallbackRepository = {
    async search() {
      return {
        text: "Vector fallback result for architecture docs.",
        source: "adapter-test",
        score: 3,
      };
    },
  };

  const retrieval = new ChaunyomsRetrievalService(
    runtime,
    payloadAdapter,
    () => ({ config: {} }),
    {
      fixedPrefixProvider,
      navigationRepository,
      vectorSearchFallback,
    },
  );

  const result = await retrieval.executeMemoryRetrieve({
    sessionId: config.sessionId,
    config,
    query: "something related to architecture docs in the knowledge base",
  });

  assert(result.details.route === "vector_search", "expected router to choose vector search");
  assert(result.details.source === "adapter-test", "expected retrieval to use the injected vector fallback adapter");
  assert(
    String(result.content[0]?.text ?? "").includes("Vector fallback result"),
    "expected vector fallback text to be returned",
  );

  await rm(dir, { recursive: true, force: true });
  console.log("test-retrieval-vector-fallback-adapter passed");
}

void main();
