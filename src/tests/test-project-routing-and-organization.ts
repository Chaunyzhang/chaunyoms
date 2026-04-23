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
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-project-routing-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "project-routing-session",
    contextWindow: 32000,
    contextThreshold: 0.95,
    freshTailTokens: 120,
    maxFreshTailTurns: 3,
    compactionBatchTurns: 4,
    summaryMaxOutputTokens: 120,
    strictCompaction: true,
    compactionBarrierEnabled: true,
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

  const ingestTurn = async (
    turnNumber: number,
    userContent: string,
    assistantContent: string,
  ): Promise<void> => {
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

  await ingestTurn(
    1,
    "Project Atlas status: refine parser reliability and keep the release checklist current.",
    "Project Atlas decision: must use Redis queue for retry orchestration.",
  );
  await ingestTurn(
    2,
    "Project Beacon status: migrate billing safely before the next release window.",
    "Project Beacon decision: must use Postgres connection pool for billing migration.",
  );
  await ingestTurn(
    3,
    "Project Atlas follow-up: keep parser rollout coordinated with QA.",
    "Project Atlas decision: must use Redis queue for retry orchestration!",
  );

  const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  const projects = stores.projectStore.getAll().filter((project) => project.status !== "archived");
  assert(projects.length >= 2, "expected organizer to retain multiple active projects");
  const atlasProject = projects.find((project) => /atlas/i.test(project.title));
  const beaconProject = projects.find((project) => /beacon/i.test(project.title));
  assert(atlasProject, "expected project registry to contain Project Atlas");
  assert(beaconProject, "expected project registry to contain Project Beacon");

  const atlasDecisionMemories = stores.durableMemoryStore
    .getAll()
    .filter((entry) => entry.projectId === atlasProject?.id && /redis queue/i.test(entry.text));
  assert(atlasDecisionMemories.length >= 2, "expected organizer test fixture to create duplicate-ish Atlas memories");
  assert(
    atlasDecisionMemories.filter((entry) => entry.recordStatus === "active").length === 1,
    "expected background organizer to keep only one active Atlas redis-queue decision",
  );
  assert(
    atlasDecisionMemories.some((entry) => entry.recordStatus === "superseded"),
    "expected background organizer to supersede older duplicate Atlas decisions",
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

  const atlasRoute = await retrieval.executeMemoryRoute({
    sessionId: config.sessionId,
    config,
    query: "What is the status of Project Atlas right now?",
  });
  assert(atlasRoute.details.route === "project_registry", "expected project status queries to hard-route to project registry");
  assert(
    atlasRoute.details.matchedProjectTitle && /atlas/i.test(String(atlasRoute.details.matchedProjectTitle)),
    "expected route decision to match Project Atlas",
  );

  const beaconRetrieve = await retrieval.executeMemoryRetrieve({
    sessionId: config.sessionId,
    config,
    query: "What constraint did we set for Project Beacon?",
  });
  const beaconText = String(beaconRetrieve.content[0]?.text ?? "");
  assert(beaconRetrieve.details.route === "durable_memory", "expected durable constraint queries to route to durable memory");
  assert(/postgres connection pool/i.test(beaconText), "expected durable retrieval to return the Beacon constraint");

  const atlasRetrieve = await retrieval.executeMemoryRetrieve({
    sessionId: config.sessionId,
    config,
    query: "What decision did we make for Project Atlas?",
  });
  const atlasText = String(atlasRetrieve.content[0]?.text ?? "");
  assert(atlasRetrieve.details.route === "durable_memory", "expected durable decision queries to route to durable memory");
  assert(/redis queue/i.test(atlasText), "expected project-scoped durable retrieval to prioritize Atlas decision");
  assert(!/postgres connection pool/i.test(atlasText), "expected project-scoped durable retrieval to avoid Beacon bleed-through");

  await rm(dir, { recursive: true, force: true });
  console.log("test-project-routing-and-organization passed");
}

void main();
