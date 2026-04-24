import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import failureCorpus from "./fixtures/failure-corpus.json";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";
import { ChaunyomsRetrievalService } from "../runtime/ChaunyomsRetrievalService";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";
import {
  FixedPrefixProvider,
  NavigationRepository,
  VectorSearchFallbackRepository,
} from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

type FailureScenario = {
  id: string;
  kind: "recall_disabled" | "vector_hint_only" | "prompt_for_api";
  query: string;
  expectedTextIncludes: string[];
  expectedDetails: Record<string, string | boolean | undefined>;
};

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

async function buildRuntime(
  configOverrides: Partial<typeof DEFAULT_BRIDGE_CONFIG>,
  apiConfig: Record<string, unknown>,
  vectorSearchFallback?: VectorSearchFallbackRepository,
): Promise<{
  runtime: ChaunyomsSessionRuntime;
  retrieval: ChaunyomsRetrievalService;
  config: typeof DEFAULT_BRIDGE_CONFIG;
  dir: string;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-failure-corpus-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "failure-corpus-session",
    ...configOverrides,
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
    () => ({ config: apiConfig }),
    () => ({ info(): void {}, warn(): void {}, error(): void {} }),
  );
  const retrieval = new ChaunyomsRetrievalService(
    runtime,
    payloadAdapter,
    () => ({ config: apiConfig }),
    {
      fixedPrefixProvider,
      navigationRepository,
      vectorSearchFallback: vectorSearchFallback ?? {
        async search() { return null; },
      },
    },
  );

  return { runtime, retrieval, config, dir };
}

async function main(): Promise<void> {
  for (const scenario of failureCorpus as unknown as FailureScenario[]) {
    if (scenario.kind === "recall_disabled") {
      const { runtime, retrieval, config, dir } = await buildRuntime(
        {
          autoRecallEnabled: false,
        },
        {},
      );
      try {
        await runtime.ingest({
          sessionId: config.sessionId,
          config,
          id: "u-1",
          role: "user",
          content: "Remember the retry parameter: maxAttempts=5",
          turnNumber: 1,
        });
        await runtime.ingest({
          sessionId: config.sessionId,
          config,
          id: "a-1",
          role: "assistant",
          content: "Stored: maxAttempts=5 for queue workers.",
          turnNumber: 1,
        });
        await runtime.compact({
          sessionId: config.sessionId,
          config: {
            ...config,
            contextWindow: 64,
            contextThreshold: 0.2,
            freshTailTokens: 4,
            maxFreshTailTurns: 0,
          },
          totalBudget: 64,
          systemPromptTokens: 0,
          runtimeMessages: [],
        });

        const result = await retrieval.executeMemoryRetrieve({
          sessionId: config.sessionId,
          config,
          query: scenario.query,
        });
        const text = String(result.content[0]?.text ?? "");
        for (const expected of scenario.expectedTextIncludes) {
          assert(text.includes(expected), `${scenario.id}: expected text to include ${expected}`);
        }
        for (const [key, value] of Object.entries(scenario.expectedDetails)) {
          assert(result.details[key] === value, `${scenario.id}: expected ${key}=${String(value)}`);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      continue;
    }

    if (scenario.kind === "vector_hint_only") {
      const { retrieval, config, dir } = await buildRuntime(
        {},
        {
          agents: {
            defaults: {
              memorySearch: {
                enabled: true,
                provider: "fake-embed",
              },
            },
          },
        },
        {
          async search() {
            return {
              text: "Vector hint mentions architecture docs but has no governed source attached.",
              source: "failure-corpus-vector",
              score: 2,
            };
          },
        },
      );
      try {
        const result = await retrieval.executeMemoryRetrieve({
          sessionId: config.sessionId,
          config,
          query: scenario.query,
        });
        const text = String(result.content[0]?.text ?? "");
        for (const expected of scenario.expectedTextIncludes) {
          assert(text.includes(expected), `${scenario.id}: expected text to include ${expected}`);
        }
        for (const [key, value] of Object.entries(scenario.expectedDetails)) {
          assert(result.details[key] === value, `${scenario.id}: expected ${key}=${String(value)}`);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      continue;
    }

    if (scenario.kind === "prompt_for_api") {
      const { retrieval, config, dir } = await buildRuntime({}, {});
      try {
        const result = await retrieval.executeMemoryRoute({
          sessionId: config.sessionId,
          config,
          query: scenario.query,
        });
        const text = String(result.content[0]?.text ?? "");
        for (const expected of scenario.expectedTextIncludes) {
          assert(text.includes(expected), `${scenario.id}: expected text to include ${expected}`);
        }
        for (const [key, value] of Object.entries(scenario.expectedDetails)) {
          assert(result.details[key] === value, `${scenario.id}: expected ${key}=${String(value)}`);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }

  console.log("test-failure-corpus passed");
}

void main();
