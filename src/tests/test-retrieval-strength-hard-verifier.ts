import { RetrievalVerifier } from "../retrieval/RetrievalVerifier";
import { AnswerCandidate, ContextItem, SourceTrace } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const item: ContextItem = {
  kind: "message",
  tokenCount: 10,
  turnNumber: 7,
  role: "user",
  content: "Gateway port must stay 15432.",
};

function trace(overrides: Partial<SourceTrace> = {}): SourceTrace {
  return {
    route: "summary_tree",
    summaryId: "summary-1",
    sessionId: "session-1",
    agentId: "agent-1",
    strategy: "message_ids",
    verified: true,
    reason: "fixture",
    sourceMessageCount: 1,
    resolvedMessageCount: 1,
    messageIds: ["m1"],
    ...overrides,
  };
}

function answer(overrides: Partial<AnswerCandidate> = {}): AnswerCandidate {
  return {
    text: "15432",
    type: "unknown",
    confidence: 0.9,
    evidenceMessageIds: ["m1"],
    sourceVerified: true,
    reason: "fixture",
    ...overrides,
  };
}

function main(): void {
  const verifier = new RetrievalVerifier();

  const off = verifier.verify({
    retrievalStrength: "off",
    items: [],
    sourceTrace: [],
  });
  assert(off.status === "sufficient", "retrievalStrength=off should not demand source recall");
  assert(off.sourceTraceStatus === "not_required", "off mode source trace status should be not_required");

  const light = verifier.verify({
    retrievalStrength: "light",
    items: [item],
    sourceTrace: [],
  });
  assert(light.status === "sufficient", "light mode may present retrieved context as hints");
  assert(light.sourceTraceRequired === false, "light mode should not require source trace");

  const strictNoTrace = verifier.verify({
    retrievalStrength: "strict",
    items: [item],
    sourceTrace: [],
  });
  assert(strictNoTrace.status === "needs_expansion", "strict mode with items but no source trace must expand instead of finalize");
  assert(strictNoTrace.recommendedAction === "trace_raw", "strict no-trace result should recommend raw tracing");
  assert(strictNoTrace.sourceTraceStatus === "missing", "strict no-trace result should report missing trace");

  const strictNoItems = verifier.verify({
    retrievalStrength: "strict",
    items: [],
    sourceTrace: [],
  });
  assert(strictNoItems.status === "insufficient", "strict mode with no items/no trace must be insufficient");
  assert(strictNoItems.recommendedAction === "no_answer", "strict no evidence should recommend no-answer");

  const strictVerifiedTrace = verifier.verify({
    retrievalStrength: "strict",
    items: [item],
    sourceTrace: [trace()],
  });
  assert(strictVerifiedTrace.status === "sufficient", "strict verified trace should be sufficient");
  assert(strictVerifiedTrace.sourceTraceStatus === "verified", "strict verified trace should report verified status");

  const strictVerifiedAnswer = verifier.verify({
    retrievalStrength: "strict",
    items: [item],
    sourceTrace: [],
    answerCandidates: [answer()],
  });
  assert(strictVerifiedAnswer.status === "sufficient", "strict source-verified answer candidate should be sufficient");
  assert(strictVerifiedAnswer.verifiedAnswerCount === 1, "strict verifier should count source-verified answer candidates");

  const forensicCompleteRaw = verifier.verify({
    retrievalStrength: "forensic",
    items: [item],
    sourceTrace: [trace({ strategy: "message_ids", verified: true, resolvedMessageCount: 1 })],
  });
  assert(forensicCompleteRaw.status === "sufficient", "forensic mode should accept complete raw trace");
  assert(forensicCompleteRaw.sourceTraceStatus === "complete_raw", "forensic complete trace status should be complete_raw");

  const forensicTraceOnly = verifier.verify({
    retrievalStrength: "forensic",
    items: [item],
    sourceTrace: [trace({ strategy: "none", verified: true, resolvedMessageCount: 0 })],
  });
  assert(forensicTraceOnly.status === "needs_expansion", "forensic verified-but-incomplete trace must still expand");
  assert(forensicTraceOnly.recommendedAction === "trace_raw", "forensic incomplete trace should request raw tracing");

  const forensicSummaryOnly = verifier.verify({
    retrievalStrength: "forensic",
    items: [item],
    sourceTrace: [],
    answerCandidates: [answer({ sourceVerified: true })],
  });
  assert(forensicSummaryOnly.status === "insufficient", "forensic mode must not accept answer-candidate-only evidence");
  assert(forensicSummaryOnly.recommendedAction === "no_answer", "forensic answer-candidate-only evidence should recommend no-answer");

  console.log("test-retrieval-strength-hard-verifier passed");
}

main();
