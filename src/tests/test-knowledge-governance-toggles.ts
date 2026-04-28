import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";
import { BridgeConfig, KnowledgeRawEntry } from "../types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function runScenario(
  name: string,
  overrides: Partial<BridgeConfig>,
  options: { approveFirstCandidate?: boolean } = {},
): Promise<{
  compacted: boolean;
  entries: KnowledgeRawEntry[];
  docCanonicalKeys: string[];
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `chaunyoms-kb-governance-${name}-`));
  try {
    const config: BridgeConfig = {
      ...DEFAULT_BRIDGE_CONFIG,
      ...overrides,
      dataDir: path.join(dir, "data"),
      workspaceDir: path.join(dir, "workspace"),
      sharedDataDir: path.join(dir, "shared"),
      memoryVaultDir: path.join(dir, "vault"),
      knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
      sessionId: `kb-governance-${name}`,
      contextWindow: 200,
      contextThreshold: 0.5,
      freshTailTokens: 24,
      maxFreshTailTurns: 1,
      compactionBatchTurns: 2,
      summaryMaxOutputTokens: 160,
      knowledgeMarkdownEnabled: true,
      strictCompaction: true,
      compactionBarrierEnabled: true,
    };

    await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });

    const runtime = new ChaunyomsSessionRuntime(
      { info(): void {}, warn(): void {}, error(): void {} },
      {
        async call(params: { prompt: string }): Promise<string> {
          if (params.prompt.includes("git-friendly unified markdown knowledge base")) {
            return JSON.stringify({
              shouldWrite: true,
              reason: "kb_governance_toggle_test",
              bucket: "decisions",
              slug: "governed-kb-policy",
              title: "Governed KB Policy",
              summary: "Governed KB writes require explicit write/export permission.",
              tags: ["governance", "kb"],
              canonicalKey: "governed-kb-policy",
              body: "# Governed KB Policy\n\n## Canonical knowledge\n\nWrites require kbWriteEnabled and kbExportEnabled.\n",
              status: "active",
            });
          }
          return JSON.stringify({
            summary: "Governed KB writes require explicit write/export permission.",
            keywords: ["governance", "kb", "write"],
            toneTag: "focused",
            memoryType: "decision",
            phase: "implementation",
            constraints: ["require write and export toggles"],
            decisions: ["gate knowledge vault writes by kbWriteEnabled and kbExportEnabled"],
            blockers: [],
            nextSteps: [],
            keyEntities: ["KnowledgeVault"],
            exactFacts: ["kbWriteEnabled=true"],
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

    for (let turn = 1; turn <= 6; turn += 1) {
      await runtime.ingest({
        sessionId: config.sessionId,
        config,
        id: `u-${turn}`,
        role: "user",
        content: `User turn ${turn}: governed KB write policy ${"alpha ".repeat(30)}`,
        turnNumber: turn,
      });
      await runtime.ingest({
        sessionId: config.sessionId,
        config,
        id: `a-${turn}`,
        role: "assistant",
        content: `Assistant turn ${turn}: knowledge writes require explicit toggles ${"beta ".repeat(30)}`,
        turnNumber: turn,
      });
    }

    const compactResult = await runtime.compact({
      sessionId: config.sessionId,
      config,
      totalBudget: config.contextWindow,
      systemPromptTokens: 0,
      runtimeMessages: [],
    });
    if (!config.emergencyBrake) {
      assert(compactResult.compacted, "expected explicit compaction to produce a summary for governance test");
    }
    await runtime.waitForBackgroundWork();

    let stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
    if (options.approveFirstCandidate) {
      const candidate = stores.knowledgeRawStore.getAll()[0];
      assert(candidate, "expected a review candidate before approval");
      const review = await runtime.reviewKnowledgeCandidate({ sessionId: config.sessionId, config }, {
        id: candidate.id,
        action: "approve",
        reviewer: "test",
      });
      assert(review.ok, "expected manual knowledge candidate approval to succeed");
      await runtime.waitForBackgroundWork();
      stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
    }

    return {
      compacted: compactResult.compacted,
      entries: stores.knowledgeRawStore.getAll(),
      docCanonicalKeys: stores.knowledgeStore
        .searchRelatedDocuments("governed kb policy", 5)
        .map((entry) => entry.canonicalKey),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const candidateDisabled = await runScenario("candidate-disabled", {
    knowledgePromotionEnabled: true,
    kbCandidateEnabled: false,
    kbWriteEnabled: true,
    kbPromotionMode: "balanced_auto",
    kbPromotionStrictness: "medium",
    kbExportEnabled: true,
  });
  assert(candidateDisabled.entries.length === 0, "kbCandidateEnabled=false must block candidate creation even if legacy promotion is on");
  assert(candidateDisabled.docCanonicalKeys.length === 0, "candidate-disabled scenario must not write knowledge docs");

  const writeDisabled = await runScenario("write-disabled", {
    knowledgePromotionEnabled: false,
    kbCandidateEnabled: true,
    kbWriteEnabled: false,
    kbPromotionMode: "balanced_auto",
    kbPromotionStrictness: "medium",
    kbExportEnabled: true,
  });
  assert(writeDisabled.entries.length > 0, "kbCandidateEnabled=true should allow governed candidate creation without legacy promotion");
  assert(
    writeDisabled.entries.every((entry) => entry.status === "review_pending"),
    "kbWriteEnabled=false must keep candidates in review instead of auto-promoting",
  );
  assert(writeDisabled.docCanonicalKeys.length === 0, "kbWriteEnabled=false must block flat-vault writes");

  const exportDisabled = await runScenario("export-disabled", {
    knowledgePromotionEnabled: false,
    kbCandidateEnabled: true,
    kbWriteEnabled: true,
    kbPromotionMode: "balanced_auto",
    kbPromotionStrictness: "medium",
    kbExportEnabled: false,
  });
  assert(exportDisabled.entries.length > 0, "kbExportEnabled=false should still allow governed candidate review");
  assert(
    exportDisabled.entries.every((entry) => entry.status === "review_pending"),
    "kbExportEnabled=false must keep candidates in review instead of auto-promoting",
  );
  assert(exportDisabled.docCanonicalKeys.length === 0, "kbExportEnabled=false must block flat-vault writes");

  const manualNoAuto = await runScenario("manual-no-auto", {
    knowledgePromotionEnabled: false,
    kbCandidateEnabled: true,
    kbWriteEnabled: true,
    kbPromotionMode: "manual",
    kbPromotionStrictness: "medium",
    kbExportEnabled: true,
  });
  assert(
    manualNoAuto.entries.every((entry) => entry.status === "review_pending"),
    "manual mode must not auto-promote before explicit review approval",
  );
  assert(manualNoAuto.docCanonicalKeys.length === 0, "manual mode must not write before explicit review approval");

  const assistedApproved = await runScenario("assisted-approved", {
    knowledgePromotionEnabled: false,
    kbCandidateEnabled: true,
    kbWriteEnabled: true,
    kbPromotionMode: "assisted",
    kbPromotionStrictness: "medium",
    kbExportEnabled: true,
  }, { approveFirstCandidate: true });
  assert(
    assistedApproved.entries.some((entry) => entry.status === "promoted"),
    "assisted mode should promote after explicit review approval",
  );
  assert(
    assistedApproved.docCanonicalKeys.includes("governed-kb-policy"),
    "assisted approval should write the governed knowledge document",
  );

  const emergencyStopped = await runScenario("emergency-brake", {
    knowledgePromotionEnabled: true,
    kbCandidateEnabled: true,
    kbWriteEnabled: true,
    kbPromotionMode: "balanced_auto",
    kbPromotionStrictness: "medium",
    kbExportEnabled: true,
    emergencyBrake: true,
  });
  assert(emergencyStopped.compacted === false, "emergencyBrake=true should stop compaction-driven knowledge intake");
  assert(emergencyStopped.entries.length === 0, "emergencyBrake=true must not create knowledge candidates");
  assert(emergencyStopped.docCanonicalKeys.length === 0, "emergencyBrake=true must not write knowledge docs");

  const autoWrite = await runScenario("auto-write", {
    knowledgePromotionEnabled: false,
    kbCandidateEnabled: true,
    kbWriteEnabled: true,
    kbPromotionMode: "balanced_auto",
    kbPromotionStrictness: "medium",
    kbExportEnabled: true,
  });
  assert(autoWrite.entries.some((entry) => entry.status === "promoted"), "balanced_auto with write/export enabled should promote eligible candidates");
  assert(autoWrite.docCanonicalKeys.includes("governed-kb-policy"), "enabled KB write/export should produce the governed knowledge document");

  console.log("test-knowledge-governance-toggles passed");
}

void main();
