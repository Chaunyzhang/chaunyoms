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
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-tree-project-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "tree-project-session",
    contextWindow: 220,
    contextThreshold: 0.45,
    freshTailTokens: 24,
    maxFreshTailTurns: 1,
    compactionBatchTurns: 2,
    summaryMaxOutputTokens: 120,
    strictCompaction: true,
    compactionBarrierEnabled: true,
  };

  await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });

  const runtime = new ChaunyomsSessionRuntime(
    { info(): void {}, warn(): void {}, error(): void {} },
    {
      async call(): Promise<string> {
        return JSON.stringify({
          summary: "Rollup-safe summary capturing implementation status and next actions.",
          keywords: ["chaunyoms", "memory", "project", "summary"],
          toneTag: "focused",
          memoryType: "project_state",
          phase: "implementation",
          constraints: ["keep shared data stable"],
          decisions: ["preserve raw history", "build summary hierarchy"],
          blockers: [],
          nextSteps: ["stabilize rollup metadata", "keep project registry aligned"],
          keyEntities: ["ChaunyomsSessionRuntime.ts", "ProjectRegistryStore"],
          exactFacts: ["contextThreshold=0.45", "compactionBatchTurns=2"],
          promotionIntent: "promote",
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

  for (let turn = 1; turn <= 12; turn += 1) {
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `u-${turn}`,
      role: "user",
      content: `ChaunyOMS project turn ${turn}: refine summary tree and project registry ${"alpha ".repeat(24)}`,
      turnNumber: turn,
    });
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `a-${turn}`,
      role: "assistant",
      content: `Assistant turn ${turn}: keep memory state active and update project navigation ${"beta ".repeat(24)}`,
      turnNumber: turn,
    });

    if (turn % 3 === 0) {
      await runtime.afterTurn({
        sessionId: config.sessionId,
        config,
        totalBudget: config.contextWindow,
        systemPromptTokens: 0,
        runtimeMessages: [],
      });
    }
  }

  const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  const summaries = stores.summaryStore.getAllSummaries();
  const branch = summaries.find((entry) => entry.nodeKind === "branch");
  assert(branch, "expected summary hierarchy rollup to create at least one branch summary");
  assert((branch?.summaryLevel ?? 0) > 1, "expected branch summary to have a higher summary level");
  assert((branch?.childSummaryIds?.length ?? 0) >= 3, "expected branch summary to link multiple child summaries");
  assert(branch?.memoryType === "project_state", "expected branch summary to retain memory type metadata");
  assert(branch?.phase === "implementation", "expected branch summary to retain phase metadata");
  assert((branch?.nextSteps?.length ?? 0) > 0, "expected branch summary to retain next-step metadata");
  assert((branch?.keyEntities?.length ?? 0) > 0, "expected branch summary to retain key-entity metadata");
  assert(branch?.promotionIntent === "promote", "expected branch summary to retain promotion intent metadata");

  const childIds = new Set(branch?.childSummaryIds ?? []);
  const linkedChildren = summaries.filter((entry) => childIds.has(entry.id));
  assert(linkedChildren.length >= 3, "expected linked child summaries to exist");
  assert(
    linkedChildren.every((entry) => entry.parentSummaryId === branch?.id),
    "expected linked child summaries to point back to their parent branch summary",
  );
  assert(
    linkedChildren.every((entry) => entry.projectId && entry.topicId),
    "expected leaf summaries to carry project/topic coordinates",
  );

  const projects = stores.projectStore.getAll();
  assert(projects.length > 0, "expected project registry to contain at least one project");
  const project = projects[0];
  assert(project.summaryIds.length > 0, "expected project registry to link summaries");
  assert(project.title.length > 0, "expected project registry to carry a title");

  const projectStateEntries = stores.durableMemoryStore
    .getAll()
    .filter((entry) => entry.kind === "project_state");
  assert(projectStateEntries.length > 0, "expected compaction-triggered navigation writes to emit project_state durable memories");
  const activeProjectStateEntries = projectStateEntries.filter((entry) => entry.recordStatus === "active");
  assert(activeProjectStateEntries.length === 1, "expected only the newest project_state memory to remain active");

  await rm(dir, { recursive: true, force: true });
  console.log("test-summary-tree-and-project-registry passed");
}

void main();
