import { LLMPlanner } from "../planner/LLMPlanner";

import { PlanValidator } from "../planner/PlanValidator";

import { DeterministicReranker } from "../retrieval/RetrievalEnhancementProviders";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";

import { PlannerRuntimeSignals } from "../planner/LLMPlannerTypes";

import { RetrievalDecision } from "../types";



function assert(condition: unknown, message: string): void {

  if (!condition) {

    throw new Error(message);

  }

}



const deterministicDecision: RetrievalDecision = {

  route: "summary_tree",

  reason: "fixture_summary_tree",

  requiresEmbeddings: false,

  requiresSourceRecall: true,

  canAnswerDirectly: false,

  routePlan: ["summary_tree"],

  explanation: "fixture deterministic decision",

};



const baseSignals: PlannerRuntimeSignals = {

  retrievalStrength: "medium",

  llmPlannerMode: "auto",

  hasLlmCaller: false,

  hasCompactedHistory: true,

  hasProjectRegistry: false,

  hasMemoryItemHits: true,

  hasKnowledgeHits: false,

  hasKnowledgeRawHint: false,

  recentAssistantUncertainty: false,

  queryComplexity: "medium",

  referencesCurrentWork: false,

  autoRecallEnabled: true,

  emergencyBrake: false,

  memoryItemEnabled: true,

  totalBudget: 128000,

  heavyRetrievalPolicy: DEFAULT_BRIDGE_CONFIG.heavyRetrievalPolicy,

  ragPlannerPolicy: DEFAULT_BRIDGE_CONFIG.ragPlannerPolicy,

  graphPlannerPolicy: DEFAULT_BRIDGE_CONFIG.graphPlannerPolicy,

  rerankPlannerPolicy: DEFAULT_BRIDGE_CONFIG.rerankPlannerPolicy,

  graphEnabled: false,

  ragEnabled: false,

  rerankEnabled: false,

  graphProvider: "none",

  ragProvider: "none",

  rerankProvider: "none",

  candidateRerankThreshold: 20,

  laneCandidateRerankThreshold: 10,

  candidateAmbiguityMargin: 0.08,

  strictModeRequiresRerankOnConflict: true,

};



async function main(): Promise<void> {

  const planner = new LLMPlanner(() => null);



  const ragPlan = await planner.plan({

    query: "Find memories similar to that principle we discussed about plugin engineering.",

    deterministicDecision,

    signals: {

      ...baseSignals,

      ragEnabled: true,

      ragProvider: "embedding",

    },

    now: "2026-04-29T00:00:00.000Z",

  });

  assert(ragPlan.plan.retrieval.candidateLayers.includes("rag_candidates"), "semantic/fuzzy query should schedule RAG candidates when enabled");

  assert(

    ragPlan.plan.retrieval.routePlan.some((step) => step.layer === "rag_candidates" && step.action === "retrieve"),

    "RAG lane must be retrieve/candidate-only",

  );



  const graphPlan = await planner.plan({

    query: "Which modules depend on this decision, and what provenance trace supports it?",

    deterministicDecision,

    signals: {

      ...baseSignals,

      graphEnabled: true,

      graphProvider: "sqlite_edges",

    },

    now: "2026-04-29T00:00:01.000Z",

  });

  assert(graphPlan.plan.retrieval.candidateLayers.includes("graph_neighbors"), "relation/provenance query should schedule Graph candidates when enabled");

  assert(

    graphPlan.plan.retrieval.routePlan.some((step) => step.layer === "graph_neighbors" && step.action === "expand"),

    "Graph lane must expand candidate/provenance neighbors",

  );



  const overloadPlan = await planner.plan({

    query: "Recall the overloaded historical evidence pool for this architecture decision.",

    deterministicDecision,

    signals: {

      ...baseSignals,

      estimatedCandidateCount: 25,

      candidateOverload: true,

      candidateRerankThreshold: 20,

      laneCandidateRerankThreshold: 10,

    },

    now: "2026-04-29T00:00:02.000Z",

  });

  assert(overloadPlan.plan.retrieval.candidateLayers.includes("rerank"), "candidate overload must schedule rerank");

  assert(

    overloadPlan.plan.retrieval.routePlan.some((step) => step.layer === "rerank" && step.action === "order"),

    "candidate overload must include rerank.order before final selection",

  );

  const validation = new PlanValidator().validate(overloadPlan.plan);

  assert(validation.accepted, "valid overload rerank plan should pass PlanValidator");



  const reranked = new DeterministicReranker().rerank(

    [

      { id: "summary-low", lane: "summary", score: 70, authority: "hint", tokenCount: 80, payload: "summary-low" },

      { id: "raw-high", lane: "raw", score: 69, authority: "raw_evidence", sourceVerified: true, tokenCount: 100, payload: "raw-high" },

      { id: "memory-high", lane: "atom", score: 68, authority: "active_memory", sourceVerified: true, tokenCount: 60, payload: "memory-high" },

      { id: "summary-high", lane: "summary", score: 67, authority: "source_backed_summary", sourceVerified: true, tokenCount: 70, payload: "summary-high" },

    ],

    {

      ...DEFAULT_BRIDGE_CONFIG,

      candidateRerankThreshold: 3,

      laneCandidateRerankThreshold: 10,

      rerankEnabled: false,

      rerankProvider: "none",

    },

  );

  assert(reranked.audit.required, "overloaded candidate pool should require rerank");

  assert(!reranked.audit.used, "rerank must not run when provider is disabled");

  assert(reranked.audit.provider === "none", "disabled provider must not masquerade as deterministic fallback");

  assert(reranked.audit.providerUnavailableReason === "rerank_provider_not_configured", "audit should record explicit provider unavailability");

  assert(reranked.candidates[0].id === "summary-low", "disabled rerank should preserve candidate order");

  const explicitDeterministic = new DeterministicReranker().rerank(

    [

      { id: "summary-low", lane: "summary", score: 70, authority: "hint", tokenCount: 80, payload: "summary-low" },

      { id: "raw-high", lane: "raw", score: 69, authority: "raw_evidence", sourceVerified: true, tokenCount: 100, payload: "raw-high" },

      { id: "memory-high", lane: "atom", score: 68, authority: "active_memory", sourceVerified: true, tokenCount: 60, payload: "memory-high" },

    ],

    {

      ...DEFAULT_BRIDGE_CONFIG,

      candidateRerankThreshold: 3,

      rerankEnabled: true,

      rerankProvider: "deterministic",

    },

  );

  assert(explicitDeterministic.audit.used, "explicit deterministic provider should run when rerank is required");

  assert(explicitDeterministic.audit.provider === "deterministic", "explicit deterministic provider should be reported honestly");

  assert(explicitDeterministic.candidates[0].id === "memory-high", "source-verified active memory should rank first when explicitly configured");



  const notRequired = new DeterministicReranker().rerank(

    [

      { id: "only", lane: "raw", score: 10, authority: "raw_evidence", sourceVerified: true, payload: "only" },

    ],

    {

      ...DEFAULT_BRIDGE_CONFIG,

      rerankEnabled: false,

      rerankProvider: "none",

    },

  );

  assert(!notRequired.audit.required && !notRequired.audit.used, "single candidate should not require rerank");

  assert(notRequired.audit.providerUnavailableReason === undefined, "audit should not report provider unavailability when rerank is not needed");



  console.log("test-heavy-retrieval-planner-rerank passed");

}



void main();
