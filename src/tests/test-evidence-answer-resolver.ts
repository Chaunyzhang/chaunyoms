import { EvidenceAnswerResolver } from "../resolvers/EvidenceAnswerResolver";
import { AnswerCandidate, ContextItem, SourceTrace } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const item: ContextItem = {
  kind: "message",
  content: "The gateway port is 15432.",
  role: "user",
  turnNumber: 1,
  tokenCount: 8,
  metadata: { messageId: "m1" },
};

const trace: SourceTrace = {
  route: "raw_exact_search",
  sessionId: "s1",
  strategy: "message_ids",
  verified: true,
  reason: "fixture",
  sourceMessageCount: 1,
  resolvedMessageCount: 1,
  messageIds: ["m1"],
};

function candidate(overrides: Partial<AnswerCandidate>): AnswerCandidate {
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

async function main(): Promise<void> {
  const resolver = new EvidenceAnswerResolver();

  const unavailable = await resolver.resolve({
    query: "what is the gateway port?",
    items: [item],
    sourceTrace: [trace],
    retrievalStrength: "high",
    config: {
      enabled: false,
      provider: "none",
      timeoutMs: 2500,
      fallbackToDeterministic: false,
    },
    answerCandidates: [candidate({ text: "15432", confidence: 0.91 })],
  });
  assert(unavailable.status === "unavailable", "resolver must not run when unconfigured");
  assert(unavailable.providerAvailable === false, "unconfigured resolver must report provider unavailable");

  const answered = await resolver.resolve({
    query: "what is the gateway port?",
    items: [item],
    sourceTrace: [trace],
    retrievalStrength: "high",
    config: {
      enabled: true,
      provider: "deterministic",
      timeoutMs: 2500,
      fallbackToDeterministic: false,
    },
    answerCandidates: [
      candidate({ text: "15432", confidence: 0.82 }),
      candidate({ text: "15432", confidence: 0.91 }),
    ],
  });
  assert(answered.status === "answered", "source-verified candidates should resolve to an answer");
  assert(answered.answer === "15432", "resolver should select the top normalized answer");
  assert(answered.sourceVerified, "resolved answer should preserve source verification");

  const sourceVerifiedButNoRawTrace = await resolver.resolve({
    query: "what is the gateway port?",
    items: [item],
    sourceTrace: [],
    retrievalStrength: "high",
    config: {
      enabled: true,
      provider: "deterministic",
      timeoutMs: 2500,
      fallbackToDeterministic: false,
    },
    answerCandidates: [candidate({ text: "15432", confidence: 0.91 })],
  });
  assert(sourceVerifiedButNoRawTrace.status === "insufficient", "high resolver must reject source-verified candidates until raw trace is complete");
  assert(sourceVerifiedButNoRawTrace.reason === "no_verified_source_trace_for_answer", "high resolver should name missing raw trace explicitly");

  const conflict = await resolver.resolve({
    query: "what is the gateway port?",
    items: [item],
    sourceTrace: [trace],
    retrievalStrength: "xhigh",
    config: {
      enabled: true,
      provider: "deterministic",
      timeoutMs: 2500,
      fallbackToDeterministic: false,
    },
    answerCandidates: [
      candidate({ text: "15432", confidence: 0.91 }),
      candidate({ text: "15433", confidence: 0.88, evidenceMessageIds: ["m2"] }),
    ],
  });
  assert(conflict.status === "conflict", "near-tied source-backed answers should require more evidence");
  assert(conflict.alternatives.length >= 2, "conflict should expose alternatives");

  const insufficient = await resolver.resolve({
    query: "what is the gateway port?",
    items: [item],
    sourceTrace: [],
    retrievalStrength: "high",
    config: {
      enabled: true,
      provider: "deterministic",
      timeoutMs: 2500,
      fallbackToDeterministic: false,
    },
    answerCandidates: [candidate({ sourceVerified: false })],
  });
  assert(insufficient.status === "insufficient", "high retrieval should reject unverified answer candidates");

  const llmWithoutModel = await resolver.resolve({
    query: "what is the gateway port?",
    items: [item],
    sourceTrace: [trace],
    retrievalStrength: "xhigh",
    config: {
      enabled: true,
      provider: "llm",
      timeoutMs: 2500,
      fallbackToDeterministic: false,
    },
    llmCaller: { call: async () => JSON.stringify({ status: "answered", selectedCandidateIndex: 0 }) },
    answerCandidates: [candidate({ text: "15432" })],
  });
  assert(llmWithoutModel.status === "unavailable", "LLM resolver must require model configuration");
  assert(llmWithoutModel.reason === "evidence_answer_resolver_model_required", "missing model should fail closed explicitly");

  console.log("test-evidence-answer-resolver passed");
}

void main();
