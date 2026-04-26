import { ContextPlanner } from "../engines/ContextPlanner";
import { ChaunyomsRetrievalService } from "../runtime/ChaunyomsRetrievalService";
import { ContextItem, RecallResult } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  const service = Object.create(ChaunyomsRetrievalService.prototype) as {
    contextPlanner: ContextPlanner;
    planRecallItems(query: string, result: RecallResult, retrievalBudget: {
      total: number;
      atom: number;
      summary: number;
      raw: number;
      perItem: { atom: number; summary: number; raw: number };
    }): { items: ContextItem[]; consumedTokens: number };
    evaluateEvidenceGate(query: string, items: ContextItem[], result: RecallResult): {
      status: string;
      recommendedAction: string;
      reason: string;
      targetIds: string[];
    };
    formatRecallText(
      query: string,
      items: ContextItem[],
      sourceTrace: RecallResult["sourceTrace"],
      answerCandidates: RecallResult["answerCandidates"],
      presentation: { maxItems: number; maxCharsPerItem: number; includeFullTrace: boolean },
      evidenceGate: { status: string; reason: string; atomHitCount: number; usableAtomCount: number; verifiedTraceCount: number; recommendedAction: string; nextActionHint?: string; targetIds: string[] },
    ): string;
  };
  service.contextPlanner = new ContextPlanner();

  const atom: ContextItem = {
    kind: "summary",
    summaryId: "summary-1",
    tokenCount: 80,
    content: "[evidence_atom:constraint] 工具结果默认不进入长期记忆。",
    metadata: {
      atomId: "atom-1",
      persistentEvidenceAtom: true,
      sourceSummaryId: "summary-1",
      sourceMessageIds: ["m-1"],
      sourceVerified: true,
      sourceTraceComplete: true,
      atomStatus: "accepted",
      confidence: 0.92,
      stability: 0.85,
    },
  };
  const largeSummary: ContextItem = {
    kind: "summary",
    summaryId: "summary-large",
    tokenCount: 2400,
    content: Array.from({ length: 2400 }, (_, index) => `summary${index}`).join(" "),
    metadata: { sourceSummaryId: "summary-large", sourceVerified: true },
  };
  const largeRaw: ContextItem = {
    kind: "message",
    role: "user",
    turnNumber: 8,
    tokenCount: 2200,
    content: Array.from({ length: 2200 }, (_, index) => `raw${index}`).join(" "),
    metadata: { messageId: "m-raw" },
  };
  const result: RecallResult = {
    items: [largeSummary, atom, largeRaw],
    consumedTokens: 4680,
    sourceTrace: [{
      route: "summary_tree",
      summaryId: "summary-1",
      sessionId: "s-1",
      strategy: "message_ids",
      verified: true,
      reason: "unit",
      resolvedMessageCount: 1,
      messageIds: ["m-1"],
    }],
    dagTrace: [],
    strategy: "summary_navigation",
  };

  const planned = service.planRecallItems("工具结果是否保存", result, {
    total: 900,
    atom: 250,
    summary: 300,
    raw: 300,
    perItem: { atom: 180, summary: 260, raw: 260 },
  });

  assert(planned.consumedTokens <= 900, "expected selected recall items to stay under total budget");
  assert(planned.items.some((item) => item.metadata?.atomId === "atom-1"), "expected evidence atom to survive budget planning");
  assert(planned.items.some((item) => item.metadata?.recallSnippet === true), "expected large non-atom item to be converted into a snippet");

  const gate = service.evaluateEvidenceGate("工具结果是否保存", planned.items, result);
  assert(gate.status === "sufficient", "expected atom-backed hits to be sufficient");
  assert(gate.recommendedAction === "answer", "expected atom-backed hits to recommend direct answer");
  assert(gate.targetIds.includes("atom:atom-1"), "expected atom trace target in evidence gate");

  const rawGate = service.evaluateEvidenceGate("请给我原文引用", [largeSummary], { ...result, sourceTrace: [] });
  assert(rawGate.status === "needs_expansion", "expected raw-source query without trace to need expansion");
  assert(rawGate.recommendedAction === "trace_raw", "expected raw-source query to recommend trace_raw");

  const conflictedAtom: ContextItem = {
    ...atom,
    metadata: { ...atom.metadata, atomId: "atom-conflict", atomStatus: "conflicted" },
  };
  const conflictGate = service.evaluateEvidenceGate("工具结果是否保存", [conflictedAtom], result);
  assert(conflictGate.status === "needs_expansion", "expected conflicted atom to require expansion");
  assert(conflictGate.recommendedAction === "expand_l1", "expected conflicted atom to expand L1 before answering");
  assert(conflictGate.reason.includes("conflicted"), "expected conflict reason to be visible");

  const expiredAtom: ContextItem = {
    ...atom,
    metadata: { ...atom.metadata, atomId: "atom-expired", atomStatus: "expired" },
  };
  const expiredGate = service.evaluateEvidenceGate("工具结果是否保存", [expiredAtom], { ...result, sourceTrace: [] });
  assert(expiredGate.status === "insufficient", "expected expired atom without trace to be insufficient");
  assert(expiredGate.recommendedAction === "no_answer", "expected expired atom without trace to refuse memory answer");

  const weakAtom: ContextItem = {
    ...atom,
    metadata: {
      ...atom.metadata,
      atomId: "atom-weak",
      confidence: 0.41,
      stability: 0.28,
      sourceTraceComplete: false,
    },
  };
  const weakGate = service.evaluateEvidenceGate("工具结果是否保存", [weakAtom], { ...result, sourceTrace: [] });
  assert(weakGate.status === "insufficient", "expected weak untraced atom to be insufficient");
  assert(weakGate.recommendedAction === "no_answer", "expected weak untraced atom to avoid direct answer");

  const text = service.formatRecallText("工具结果是否保存", planned.items, result.sourceTrace, [], {
    maxItems: 4,
    maxCharsPerItem: 400,
    includeFullTrace: false,
  }, {
    status: gate.status,
    reason: "selected context includes evidence atoms",
    atomHitCount: 1,
    usableAtomCount: 1,
    verifiedTraceCount: 1,
    recommendedAction: gate.recommendedAction,
    nextActionHint: "Answer from the selected evidence atoms.",
    targetIds: gate.targetIds,
  });
  assert(text.includes("Trace targets:") && text.includes("atom:atom-1"), "expected formatted recall text to expose trace targets");
  assert(text.includes("Next action hint:"), "expected formatted recall text to expose next action hint");

  console.log("test-retrieval-evidence-gate-budget passed");
}

main();
