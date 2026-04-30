import fixturesJson from "./fixtures/llm-planner-activation-fixtures.json";



import { LLMPlanner } from "../planner/LLMPlanner";

import { LLMPlannerActivationPolicy } from "../planner/LLMPlannerActivationPolicy";

import {

  PlannerActivationMode,

  PlannerCandidateLayer,

  PlannerIntent,

  PlannerRuntimeSignals,

} from "../planner/LLMPlannerTypes";

import {

  LlmCallParams,

  LlmCaller,

  RetrievalDecision,

  RetrievalStrength,

} from "../types";



function assert(condition: unknown, message: string): void {

  if (!condition) {

    throw new Error(message);

  }

}



interface Fixture {

  name: string;

  query: string;

  retrievalStrength?: RetrievalStrength;

  plannerMode?: PlannerRuntimeSignals["llmPlannerMode"];

  hasLlmCaller?: boolean;

  signals?: Partial<PlannerRuntimeSignals>;

  expectedMode: PlannerActivationMode;

  expectedLlmInvoked?: boolean;

  expectedIntent?: PlannerIntent;

  expectSourceTraceRequired?: boolean;

  expectedLayers?: PlannerCandidateLayer[];

  expectedTriggers?: string[];

  expectedMemoryWriteAllowed?: boolean;

  expectedFallbackFrom?: string;

  skipPlan?: boolean;

}



const fixtures = fixturesJson as Fixture[];



const baseSignals: PlannerRuntimeSignals = {

  retrievalStrength: "medium",

  llmPlannerMode: "auto",

  hasLlmCaller: false,

  hasCompactedHistory: false,

  hasProjectRegistry: false,

  hasMemoryItemHits: false,

  hasKnowledgeHits: false,

  hasKnowledgeRawHint: false,

  recentAssistantUncertainty: false,

  queryComplexity: "low",

  referencesCurrentWork: false,

  autoRecallEnabled: true,

  emergencyBrake: false,

  memoryItemEnabled: true,

  totalBudget: 128000,

};



const deterministicDecision: RetrievalDecision = {

  route: "recent_tail",

  reason: "fixture_recent_tail",

  requiresEmbeddings: false,

  requiresSourceRecall: false,

  canAnswerDirectly: true,

  routePlan: ["recent_tail"],

  explanation: "fixture deterministic decision",

};



class RecordingCaller implements LlmCaller {

  calls: LlmCallParams[] = [];



  async call(params: LlmCallParams): Promise<string> {

    this.calls.push(params);

    return JSON.stringify({

      intent: {

        primary: "history_trace",

        confidence: 0.93,

        ambiguity: ["fixture_llm_hint"],

      },

      retrieval: {

        sourceTraceRequired: true,

        dagExpansion: {

          mode: "delegated_agent",

          reason: "fixture delegated DAG expansion",

        },

        candidateLayers: ["memory_items", "base_summaries", "raw_sources"],

        progressive: true,

        stopCondition: "verified_source_trace_sufficient",

      },

      memoryWrite: {

        allowed: false,

        reason: "fixture no write",

      },

      explain: {

        shortReason: "fixture LLMPlanner JSON accepted",

        whyTheseLayers: ["fixture"],

      },

    });

  }

}



function signalsFor(fixture: Fixture): PlannerRuntimeSignals {

  return {

    ...baseSignals,

    ...(fixture.signals ?? {}),

    retrievalStrength: fixture.retrievalStrength ?? baseSignals.retrievalStrength,

    llmPlannerMode: fixture.plannerMode ?? baseSignals.llmPlannerMode,

    hasLlmCaller: fixture.hasLlmCaller ?? baseSignals.hasLlmCaller,

  };

}



async function main(): Promise<void> {

  const policy = new LLMPlannerActivationPolicy();

  const planner = new LLMPlanner(() => null);



  for (const fixture of fixtures) {

    const signals = signalsFor(fixture);

    const activation = policy.decide(fixture.query, signals);

    assert(

      activation.mode === fixture.expectedMode,

      `${fixture.name}: expected activation ${fixture.expectedMode}, got ${activation.mode}`,

    );

    if (typeof fixture.expectedLlmInvoked === "boolean") {

      assert(

        activation.llmInvoked === fixture.expectedLlmInvoked,

        `${fixture.name}: expected llmInvoked=${fixture.expectedLlmInvoked}, got ${activation.llmInvoked}`,

      );

    }

    for (const expectedTrigger of fixture.expectedTriggers ?? []) {

      assert(

        activation.triggers.includes(expectedTrigger),

        `${fixture.name}: missing activation trigger ${expectedTrigger}; got ${activation.triggers.join(",")}`,

      );

    }



    if (fixture.skipPlan) {

      continue;

    }



    const { plan } = await planner.plan({

      query: fixture.query,

      deterministicDecision,

      signals,

      now: "2026-04-28T00:00:00.000Z",

    });

    if (fixture.expectedIntent) {

      assert(

        plan.intent.primary === fixture.expectedIntent,

        `${fixture.name}: expected intent ${fixture.expectedIntent}, got ${plan.intent.primary}`,

      );

    }

    if (typeof fixture.expectSourceTraceRequired === "boolean") {

      assert(

        plan.retrieval.sourceTraceRequired === fixture.expectSourceTraceRequired,

        `${fixture.name}: expected sourceTraceRequired=${fixture.expectSourceTraceRequired}, got ${plan.retrieval.sourceTraceRequired}`,

      );

    }

    for (const expectedLayer of fixture.expectedLayers ?? []) {

      assert(

        plan.retrieval.candidateLayers.includes(expectedLayer),

        `${fixture.name}: expected candidate layer ${expectedLayer}; got ${plan.retrieval.candidateLayers.join(",")}`,

      );

    }

    if (typeof fixture.expectedMemoryWriteAllowed === "boolean") {

      assert(

        plan.memoryWrite.allowed === fixture.expectedMemoryWriteAllowed,

        `${fixture.name}: expected memoryWrite.allowed=${fixture.expectedMemoryWriteAllowed}, got ${plan.memoryWrite.allowed}`,

      );

      assert(plan.memoryWrite.requiredSourceRefs, `${fixture.name}: memory write candidates must require source refs`);

      assert(plan.memoryWrite.reviewRequired, `${fixture.name}: memory write candidates must require review`);

    }

    if (fixture.expectedFallbackFrom) {

      assert(

        plan.fallback?.from === fixture.expectedFallbackFrom,

        `${fixture.name}: expected fallback from ${fixture.expectedFallbackFrom}, got ${plan.fallback?.from ?? "none"}`,

      );

    }

  }



  const caller = new RecordingCaller();

  const llmPlanner = new LLMPlanner(() => caller);

  const { plan } = await llmPlanner.plan({

    query: "刚才那个端口是多少",

    deterministicDecision,

    signals: {

      ...baseSignals,

      retrievalStrength: "high",

      hasLlmCaller: true,

      hasCompactedHistory: true,

      hasMemoryItemHits: true,

      llmPlannerModel: "planner-fixture-model",

      dagExpansionMode: "planner_decides",

      dagExpansionAgentProvider: "llm",

    },

    now: "2026-04-28T00:00:00.000Z",

  });

  assert(caller.calls.length === 1, "LLMPlanner path should invoke the configured caller once");

  assert(caller.calls[0].model === "planner-fixture-model", "LLMPlanner should pass the configured planner model to the caller");

  assert(plan.fallback === undefined, "valid LLMPlanner JSON should not leave a fallback marker");

  assert(plan.intent.primary === "history_trace", "LLMPlanner JSON hint should merge into intent");

  assert(plan.retrieval.sourceTraceRequired, "LLMPlanner JSON hint should preserve source trace requirement");

  assert(plan.retrieval.dagExpansion.mode === "delegated_agent", "LLMPlanner should allow configured delegated DAG expansion");

  assert(plan.retrieval.dagExpansion.agentProvider === "llm", "delegated DAG expansion should preserve configured provider");

  assert(

    plan.retrieval.routePlan.some((step) => step.action === "verify" && step.layer === "raw_sources"),

    "LLMPlanner source-sensitive plan should include a raw source verification step",

  );



  const deterministicWhenUnconfigured = await new LLMPlanner(() => caller).plan({

    query: "what exact thing happened earlier?",

    deterministicDecision,

    signals: {

      ...baseSignals,

      retrievalStrength: "high",

      hasLlmCaller: true,

      hasCompactedHistory: true,

      dagExpansionMode: "planner_decides",

      dagExpansionAgentProvider: "none",

    },

    now: "2026-04-28T00:01:00.000Z",

  });

  assert(

    deterministicWhenUnconfigured.plan.retrieval.dagExpansion.mode === "deterministic",

    "Planner must not select delegated DAG expansion when no provider is configured",

  );



  console.log("test-llm-planner-activation-policy passed");

}



void main();
