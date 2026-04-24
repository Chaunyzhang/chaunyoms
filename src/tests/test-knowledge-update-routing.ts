import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-knowledge-update-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "knowledge-update-session",
    contextWindow: 110,
    contextThreshold: 0.32,
    freshTailTokens: 12,
    maxFreshTailTurns: 1,
    compactionBatchTurns: 2,
  };
  await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });

  const runtime = new ChaunyomsSessionRuntime(
    { info(): void {}, warn(): void {}, error(): void {} },
    {
      async call(): Promise<string> {
        return JSON.stringify({
          summary: "Synthetic update summary.",
          keywords: ["queue_window", "memory"],
          toneTag: "focused",
          memoryType: "project_state",
          phase: "implementation",
          constraints: [],
          decisions: [],
          blockers: [],
          nextSteps: [],
          keyEntities: ["QUEUE_WINDOW"],
          exactFacts: ["QUEUE_WINDOW=3m", "QUEUE_WINDOW=7m"],
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

  const turn = async (turnNumber: number, userContent: string, assistantContent: string): Promise<void> => {
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `u-${turnNumber}`,
      role: "user",
      content: userContent,
      turnNumber,
    });
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `a-${turnNumber}`,
      role: "assistant",
      content: assistantContent,
      turnNumber,
    });
    await runtime.afterTurn({
      sessionId: config.sessionId,
      config,
      totalBudget: config.contextWindow,
      systemPromptTokens: 0,
      runtimeMessages: [],
    });
  };

  await turn(1, "Initial rollout note: QUEUE_WINDOW=3m for workers.", "Recorded initial queue window at 3m.");
  await turn(2, "Correction: QUEUE_WINDOW=7m is the current setting now.", "Updated current queue window to 7m.");

  const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  const factEntries = stores.durableMemoryStore
    .getAll()
    .filter((entry) => entry.metadata?.factKey === "QUEUE_WINDOW");
  assert(factEntries.length >= 2, "expected extracted fact entries for queue window history");
  assert(
    factEntries.filter((entry) => entry.recordStatus === "active").length === 1,
    "expected only one active queue window fact after update",
  );
  assert(
    factEntries.some((entry) => entry.recordStatus === "superseded" && entry.metadata?.factValue === "3m"),
    "expected old queue window fact to be superseded",
  );
  assert(
    factEntries.some((entry) => entry.recordStatus === "active" && entry.metadata?.factValue === "7m"),
    "expected newest queue window fact to stay active",
  );

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

  const result = await retrieval.executeMemoryRetrieve({
    sessionId: config.sessionId,
    config,
    query: "what is the current exact QUEUE_WINDOW now",
  });
  const text = String(result.content[0]?.text ?? "");
  assert(result.details.route === "durable_memory", "expected current exact fact to route to durable memory");
  assert(/QUEUE_WINDOW=7m/i.test(text), "expected updated fact to be returned");
  assert(!/QUEUE_WINDOW=3m/i.test(text), "expected stale fact not to appear in the primary answer");

  await rm(dir, { recursive: true, force: true });
  console.log("test-knowledge-update-routing passed");
}

void main();
