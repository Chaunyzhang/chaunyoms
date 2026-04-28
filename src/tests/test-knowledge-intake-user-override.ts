import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KnowledgeIntentClassifier } from "../engines/KnowledgeIntentClassifier";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { KnowledgeMaintenanceService } from "../runtime/KnowledgeMaintenanceService";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";
import { RawMessage } from "../types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertOverrideReason(content: string, expected: string, metadata?: RawMessage["metadata"]): void {
  const service = new KnowledgeMaintenanceService({
    logger: { info(): void {}, warn(): void {}, error(): void {} },
    sourceMessageResolver: {} as never,
    knowledgePromotionEngine: {} as never,
    knowledgeIntakeGate: {} as never,
    knowledgeCandidateScorer: {} as never,
    ensureSession: async () => ({} as never),
  });
  const messages: RawMessage[] = [{
    id: "phrase",
    sessionId: "s",
    agentId: "a",
    role: "user",
    content,
    turnNumber: 1,
    tokenCount: 8,
    compacted: false,
    createdAt: new Date().toISOString(),
    metadata,
  }];
  const result = (service as unknown as {
    resolveKnowledgeUserOverride(
      messages: RawMessage[],
      config: { knowledgeIntakeUserOverrideEnabled: boolean; knowledgeIntakeUserOverridePatterns: string[] },
    ): string | null;
  }).resolveKnowledgeUserOverride(messages, {
    knowledgeIntakeUserOverrideEnabled: true,
    knowledgeIntakeUserOverridePatterns: [],
  });
  assert(result === expected, `expected override reason ${expected}, got ${result ?? "null"} for: ${content}`);
}

async function assertClassifierSignals(): Promise<void> {
  let llmCalls = 0;
  const classifier = new KnowledgeIntentClassifier(
    {
      async call(params: { prompt: string }): Promise<string> {
        llmCalls += 1;
        if (params.prompt.includes("Preserve this as reusable team doctrine")) {
          return JSON.stringify({
            intent: "promote_to_knowledge",
            confidence: 0.93,
            reason: "explicit preserve request",
            target: "knowledge_base",
          });
        }
        return JSON.stringify({
          intent: "none",
          confidence: 0.88,
          reason: "design discussion only",
          target: "unspecified",
        });
      },
    },
    { info(): void {}, warn(): void {}, error(): void {} },
  );
  const positive = await classifier.classifyUserMessage("Preserve this as reusable team doctrine.", {
    knowledgeIntakeUserOverrideEnabled: true,
    emergencyBrake: false,
  });
  assert(positive !== null, "expected positive LLM classifier signal");
  assert(positive.intent === "promote_to_knowledge", "expected LLM classifier to detect explicit knowledge intent");
  assert(positive.classifier === "llm", "expected LLM classifier label on positive intent");
  assert(typeof positive.latencyMs === "number", "expected LLM classifier to record latency");

  const negative = await classifier.classifyUserMessage("Can a knowledge base replace summaries?", {
    knowledgeIntakeUserOverrideEnabled: true,
    emergencyBrake: false,
  });
  assert(negative !== null, "expected negative LLM classifier signal");
  assert(negative.intent === "none", "expected LLM classifier to reject design discussion as write intent");
  assert(negative.classifier === "llm", "expected LLM classifier label on negative intent");

  const callsAfterCueQueries = llmCalls;
  const skipped = await classifier.classifyUserMessage("What is the next implementation step?", {
    knowledgeIntakeUserOverrideEnabled: true,
    emergencyBrake: false,
  });
  assert(skipped === null, "expected no-cue message to skip LLM classification");
  assert(llmCalls === callsAfterCueQueries, "expected no-cue message not to call the LLM");

  const fallback = new KnowledgeIntentClassifier(null, { info(): void {}, warn(): void {}, error(): void {} });
  const fallbackSignal = await fallback.classifyUserMessage(
    "\u8bf7\u8bb0\u4f4f\u8fd9\u4e2a\uff1a\u5de5\u5177\u7ed3\u679c\u4e0d\u957f\u671f\u4fdd\u5b58\u3002",
    {
      knowledgeIntakeUserOverrideEnabled: true,
      emergencyBrake: false,
    },
  );
  assert(fallbackSignal !== null, "expected fallback phrase classifier signal");
  assert(fallbackSignal.intent === "promote_to_knowledge", "expected fallback phrase classifier to detect Chinese intent");
  assert(fallbackSignal.classifier === "fallback_phrase", "expected fallback phrase classifier label");

  const failing = new KnowledgeIntentClassifier(
    {
      async call(): Promise<string> {
        throw new Error("simulated classifier outage");
      },
    },
    { info(): void {}, warn(): void {}, error(): void {} },
  );
  const failureFallback = await failing.classifyUserMessage("Remember this for later: release notes need provenance.", {
    knowledgeIntakeUserOverrideEnabled: true,
    emergencyBrake: false,
  });
  assert(failureFallback?.classifier === "fallback_phrase", "expected LLM failure to fall back to phrase detection");
}

async function main(): Promise<void> {
  [
    "\u8bb0\u4f4f\u8fd9\u4e2a\uff1a\u53d1\u5e03\u8282\u594f\u8981\u6bcf\u5468\u540c\u6b65\u3002",
    "\u5e2e\u6211\u8bb0\u4e00\u4e0b\uff1a\u5ba2\u6237\u504f\u597d\u5148\u7ed9\u7ed3\u8bba\u3002",
    "\u653e\u8fdb\u77e5\u8bc6\u5e93\uff1a\u6545\u969c\u590d\u76d8\u9700\u8981\u4fdd\u7559\u6765\u6e90\u3002",
    "\u5199\u8fdb wiki\uff1a\u8fd0\u884c\u624b\u518c\u9700\u8981\u4eba\u5de5\u5ba1\u6838\u3002",
    "\u6c89\u6dc0\u5230\u77e5\u8bc6\u5e93\uff1a\u957f\u671f\u7ea6\u675f\u4e0d\u80fd\u81ea\u52a8\u8986\u76d6\u3002",
    "\u4fdd\u5b58\u4e3a\u77e5\u8bc6\uff1a\u5de5\u5177\u7ed3\u679c\u9ed8\u8ba4\u4e0d\u957f\u671f\u4fdd\u5b58\u3002",
  ].forEach((content) => assertOverrideReason(content, "explicit_user_knowledge_override"));

  assertOverrideReason("Please preserve this as reusable team doctrine.", "explicit_user_knowledge_intent", {
    knowledgeIntent: {
      intent: "promote_to_knowledge",
      confidence: 0.91,
      reason: "llm_detected_explicit_write_intent",
      target: "knowledge_base",
      classifier: "llm",
    },
  });

  await assertClassifierSignals();

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
    knowledgePromotionEnabled: false,
    knowledgePromotionManualReviewEnabled: true,
    kbCandidateEnabled: true,
    kbWriteEnabled: true,
    kbPromotionMode: "balanced_auto" as const,
    kbPromotionStrictness: "medium" as const,
    kbExportEnabled: true,
    knowledgeIntakeUserOverrideEnabled: true,
  };

  await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });

  const runtime = new ChaunyomsSessionRuntime(
    { info(): void {}, warn(): void {}, error(): void {} },
    {
      async call(params: { prompt: string }): Promise<string> {
        if (params.prompt.includes("Classify whether the user is explicitly asking")) {
          return JSON.stringify({
            intent: params.prompt.includes("Remember this") ? "promote_to_knowledge" : "none",
            confidence: 0.93,
            reason: "explicit save request",
            target: "knowledge_base",
          });
        }
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
    entries.some((entry) => entry.intakeReason === "explicit_user_knowledge_intent"),
    "expected LLM-tagged user override reason to be recorded on the candidate",
  );
  assert(
    stores.knowledgeStore.searchRelatedDocuments("manual release note", 3).some((entry) => entry.canonicalKey === "manual-release-note"),
    "expected explicit user override candidate to reach the managed wiki",
  );

  await rm(dir, { recursive: true, force: true });
  console.log("test-knowledge-intake-user-override passed");
}

void main();
