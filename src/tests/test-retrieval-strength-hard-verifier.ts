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

  metadata: { messageId: "m1" },

};

const summaryItem: ContextItem = {

  kind: "summary",

  tokenCount: 10,

  turnNumber: 7,

  content: "Summary says gateway port must stay 15432.",

  metadata: { sourceSummaryId: "summary-1" },

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



  const lowEmpty = verifier.verify({

    retrievalStrength: "low",

    items: [],

    sourceTrace: [],

  });

  assert(lowEmpty.status === "insufficient", "low mode still needs at least one selected item or answer candidate");

  assert(lowEmpty.sourceTraceStatus === "missing", "low mode with no evidence reports missing evidence");



  const light = verifier.verify({

    retrievalStrength: "low",

    items: [item],

    sourceTrace: [],

  });

  assert(light.status === "sufficient", "low mode may present retrieved context as hints");

  assert(light.sourceTraceRequired === false, "low mode should not require source trace");



  const strictNoTrace = verifier.verify({

    retrievalStrength: "high",

    items: [item],

    sourceTrace: [],

  });

  assert(strictNoTrace.status === "needs_expansion", "high mode with items but no source trace must expand instead of finalize");

  assert(strictNoTrace.recommendedAction === "trace_raw", "high no-trace result should recommend raw tracing");

  assert(strictNoTrace.sourceTraceStatus === "missing", "high no-trace result should report missing trace");



  const strictNoItems = verifier.verify({

    retrievalStrength: "high",

    items: [],

    sourceTrace: [],

  });

  assert(strictNoItems.status === "insufficient", "high mode with no items/no trace must be insufficient");

  assert(strictNoItems.recommendedAction === "no_answer", "high no evidence should recommend no-answer");



  const strictVerifiedTrace = verifier.verify({

    retrievalStrength: "high",

    items: [item],

    sourceTrace: [trace()],

  });

  assert(strictVerifiedTrace.status === "sufficient", "high raw-backed verified trace should be sufficient");

  assert(strictVerifiedTrace.sourceTraceStatus === "complete_raw", "high raw-backed trace should report complete_raw status");



  const strictVerifiedAnswer = verifier.verify({

    retrievalStrength: "high",

    items: [item],

    sourceTrace: [],

    answerCandidates: [answer()],

  });

  assert(strictVerifiedAnswer.status === "needs_expansion", "high source-verified answer candidate without raw trace must expand to raw source");

  assert(strictVerifiedAnswer.verifiedAnswerCount === 1, "high verifier should count source-verified answer candidates");



  const highSummaryOnlyTrace = verifier.verify({

    retrievalStrength: "high",

    items: [summaryItem],

    sourceTrace: [trace()],

  });

  assert(highSummaryOnlyTrace.status === "needs_expansion", "high summary-only trace must expand to original raw messages");

  assert(highSummaryOnlyTrace.rawEvidenceItemCount === 0, "high summary-only trace should not count as raw evidence");



  const xhighCompleteRaw = verifier.verify({

    retrievalStrength: "xhigh",

    items: [item],

    sourceTrace: [trace({ strategy: "message_ids", verified: true, resolvedMessageCount: 1 })],

  });

  assert(xhighCompleteRaw.status === "sufficient", "xhigh mode should accept complete raw trace");

  assert(xhighCompleteRaw.sourceTraceStatus === "complete_raw", "xhigh complete trace status should be complete_raw");



  const xhighTraceOnly = verifier.verify({

    retrievalStrength: "xhigh",

    items: [item],

    sourceTrace: [trace({ strategy: "none", verified: true, resolvedMessageCount: 0 })],

  });

  assert(xhighTraceOnly.status === "needs_expansion", "xhigh verified-but-incomplete trace must still expand");

  assert(xhighTraceOnly.recommendedAction === "trace_raw", "xhigh incomplete trace should request raw tracing");



  const xhighSummaryOnly = verifier.verify({

    retrievalStrength: "xhigh",

    items: [item],

    sourceTrace: [],

    answerCandidates: [answer({ sourceVerified: true })],

  });

  assert(xhighSummaryOnly.status === "needs_expansion", "xhigh mode must not accept answer-candidate-only evidence");

  assert(xhighSummaryOnly.recommendedAction === "trace_raw", "xhigh answer-candidate-only evidence should recommend raw tracing when a raw item is available");



  console.log("test-retrieval-strength-hard-verifier passed");

}



main();
