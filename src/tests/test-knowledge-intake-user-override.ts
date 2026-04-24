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
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-knowledge-override-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "knowledge-override-session",
    contextWindow: 200,
    contextThreshold: 0.5,
    freshTailTokens: 24,
    maxFreshTailTurns: 1,
    compactionBatchTurns: 2,
    summaryMaxOutputTokens: 160,
    strictCompaction: true,
    compactionBarrierEnabled: true,
    knowledgePromotionEnabled: true,
    knowledgeIntakeUserOverrideEnabled: true,
  };

  await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });

  const runtime = new ChaunyomsSessionRuntime(
    { info(): void {}, warn(): void {}, error(): void {} },
    {
      async call(params: { prompt: string }): Promise<string> {
        if (params.prompt.includes("git-friendly unified markdown knowledge base")) {
          return JSON.stringify({
            shouldWrite: true,
            reason: "user_requested_knowledge_capture",
            bucket: "facts",
            slug: "manual-release-note",
            title: "Manual Release Note",
            summary: "A user-forced project-state note captured in the wiki.",
            tags: ["manual", "release"],
            canonicalKey: "manual-release-note",
            body: "# Manual Release Note\n\n## Why it matters\n\nThe user explicitly asked to remember this item.\n\n## Canonical knowledge\n\nRelease coordination must stay visible.\n\n## Evidence\n\nCaptured through explicit user override.\n",
            status: "active",
          });
        }

        return JSON.stringify({
          summary: "Current release coordination is active.",
          keywords: ["release", "coordination"],
          toneTag: "focused",
          memoryType: "project_state",
          phase: "implementation",
          constraints: [],
          decisions: [],
          blockers: [],
          nextSteps: [],
          keyEntities: [],
          exactFacts: [],
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

  await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "u-1",
    role: "user",
    content: "Remember this and put this in the knowledge base.",
    turnNumber: 1,
  });
  await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "a-1",
    role: "assistant",
    content: "I will keep this release coordination note.",
    turnNumber: 1,
  });
  await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "u-2",
    role: "user",
    content: `Release coordination note ${"alpha ".repeat(30)}`,
    turnNumber: 2,
  });
  await runtime.ingest({
    sessionId: config.sessionId,
    config,
    id: "a-2",
    role: "assistant",
    content: `Release coordination acknowledged ${"beta ".repeat(30)}`,
    turnNumber: 2,
  });
  for (let turn = 3; turn <= 6; turn += 1) {
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `u-${turn}`,
      role: "user",
      content: `Release follow-up ${turn}: ${"alpha ".repeat(30)}`,
      turnNumber: turn,
    });
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `a-${turn}`,
      role: "assistant",
      content: `Release follow-up acknowledged ${turn}: ${"beta ".repeat(30)}`,
      turnNumber: turn,
    });
  }

  const compactResult = await runtime.compact({
    sessionId: config.sessionId,
    config,
    totalBudget: 80,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });
  assert(compactResult.compacted === true, "expected compact() to produce a level-one summary");
  await runtime.waitForBackgroundWork();

  const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  const entries = stores.knowledgeRawStore.getAll();
  assert(entries.length > 0, "expected explicit user override to enqueue a knowledge raw candidate");
  assert(
    entries.some((entry) => entry.intakeReason === "explicit_user_knowledge_override"),
    "expected explicit user override reason to be recorded on the candidate",
  );
  assert(
    stores.knowledgeStore.searchRelatedDocuments("manual release note", 3).some((entry) => entry.canonicalKey === "manual-release-note"),
    "expected explicit user override candidate to reach the managed wiki",
  );

  await rm(dir, { recursive: true, force: true });
  console.log("test-knowledge-intake-user-override passed");
}

void main();
