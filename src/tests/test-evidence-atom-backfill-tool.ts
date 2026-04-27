import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";
import { SummaryEntry } from "../types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-atom-backfill-"));
  const config = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: "atom-backfill-session",
    agentId: "atom-backfill-agent",
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

  const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  const summary: SummaryEntry = {
    id: "summary-backfill-1",
    sessionId: config.sessionId,
    agentId: config.agentId,
    recordStatus: "active",
    summary: "A legacy level-one summary with structured fields but no persistent atoms.",
    keywords: ["legacy", "atom", "backfill"],
    toneTag: "focused",
    memoryType: "decision",
    phase: "implementation",
    constraints: ["Backfill must be explicit and dry-run by default."],
    decisions: ["Use oms_backfill_atoms for old summary atom migration."],
    blockers: [],
    nextSteps: ["Run apply=true only after reviewing the dry-run report."],
    keyEntities: ["oms_backfill_atoms"],
    exactFacts: ["Dry-run does not mutate the atom store."],
    openQuestions: [],
    conflicts: [],
    startTurn: 1,
    endTurn: 2,
    tokenCount: 96,
    sourceMessageIds: ["m-1", "m-2"],
    sourceMessageCount: 2,
    sourceHash: "source-hash",
    summaryLevel: 1,
    nodeKind: "leaf",
    promotionIntent: "candidate",
    createdAt: new Date().toISOString(),
    quality: {
      confidence: 0.9,
      sourceTraceComplete: true,
      unresolvedConflicts: 0,
      needsHumanReview: false,
    },
  };
  await stores.summaryStore.addSummary(summary);

  const dryRun = await runtime.backfillEvidenceAtoms({ sessionId: config.sessionId, config }, {
    apply: false,
    scope: "session",
  });
  assert(dryRun.apply === false, "expected dry-run result");
  assert(dryRun.generatedAtoms >= 4, "expected dry-run to generate atoms from structured summary fields");
  assert(dryRun.writtenAtoms === 0, "expected dry-run not to write atoms");
  assert(stores.evidenceAtomStore.getAll({ sessionId: config.sessionId }).length === 0, "expected dry-run to leave atom store unchanged");

  const applied = await runtime.backfillEvidenceAtoms({ sessionId: config.sessionId, config }, {
    apply: true,
    scope: "session",
  });
  assert(applied.writtenAtoms === dryRun.generatedAtoms, "expected apply run to write generated atoms");
  assert(stores.evidenceAtomStore.getAll({ sessionId: config.sessionId }).length === applied.writtenAtoms, "expected persistent atom store to contain written atoms");

  const secondDryRun = await runtime.backfillEvidenceAtoms({ sessionId: config.sessionId, config }, {
    apply: false,
    scope: "session",
  });
  assert(secondDryRun.generatedAtoms === 0, "expected existing source summaries to be skipped after apply");
  assert(secondDryRun.skippedExistingSummaries === 1, "expected already-backfilled summary to be counted as skipped");

  await rm(dir, { recursive: true, force: true });
  console.log("test-evidence-atom-backfill-tool passed");
}

void main();
