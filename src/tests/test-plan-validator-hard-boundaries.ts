import { PlanValidator } from "../planner/PlanValidator";
import { LlmPlannerPlan } from "../planner/LLMPlannerTypes";
import { RetrievalRuntime } from "../retrieval/RetrievalRuntime";
import { RetrievalDecision } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function basePlan(overrides: Partial<LlmPlannerPlan> = {}): LlmPlannerPlan {
  const plan: LlmPlannerPlan = {
    schemaVersion: "oms.llm_planner.plan.v1",
    runId: "planner-test",
    createdAt: "2026-04-28T00:00:00.000Z",
    activation: {
      mode: "llm_planner",
      reason: "fixture",
      llmInvoked: false,
      triggers: ["fixture"],
    },
    intent: {
      primary: "history_trace",
      alternatives: [{
        intent: "history_trace",
        confidence: 0.9,
        evidence: ["fixture"],
        ambiguity: [],
        userVisibleReason: "fixture",
      }],
      confidence: 0.9,
      ambiguity: [],
      userLanguage: "zh",
    },
    retrieval: {
      strength: "strict",
      sourceTraceRequired: true,
      candidateLayers: ["base_summaries", "raw_sources"],
      routePlan: [{
        layer: "base_summaries",
        action: "retrieve",
        reason: "fixture",
        stopIf: "verified_source_trace_sufficient",
      }],
      progressive: true,
      stopCondition: "verified_source_trace_sufficient",
    },
    context: {
      totalRequestedTokens: 2048,
      protectRecentTail: true,
      minimumRecentTailTokens: 512,
      preferredSplits: {
        recentTail: 900,
        summaries: 500,
        rawEvidence: 400,
        reserve: 248,
      },
      reason: "fixture",
    },
    memoryWrite: {
      allowed: false,
      candidateKinds: [],
      reason: "fixture",
      requiredSourceRefs: true,
      reviewRequired: true,
    },
    safety: {
      destructive: false,
      requiresDryRun: false,
      crossAgentAccess: "same_agent",
      markdownRuntimeFactSource: false,
      toolOutputAsSource: false,
      currentInstructionProtected: true,
      summaryOnlyFinalFactAllowed: true,
    },
    explain: {
      shortReason: "fixture",
      whyTheseLayers: ["fixture"],
      expectedUserVisibleBehavior: "fixture",
    },
    deterministic: {
      route: "summary_tree",
      routePlan: ["summary_tree"],
      reason: "fixture",
    },
  };

  return {
    ...plan,
    ...overrides,
    activation: { ...plan.activation, ...overrides.activation },
    intent: { ...plan.intent, ...overrides.intent },
    retrieval: { ...plan.retrieval, ...overrides.retrieval },
    context: { ...plan.context, ...overrides.context },
    memoryWrite: { ...plan.memoryWrite, ...overrides.memoryWrite },
    safety: { ...plan.safety, ...overrides.safety },
    explain: { ...plan.explain, ...overrides.explain },
    deterministic: { ...plan.deterministic, ...overrides.deterministic },
  };
}

function codes(plan: LlmPlannerPlan): string[] {
  return new PlanValidator().validate(plan).violations.map((violation) => violation.code);
}

function mutated(mutator: (plan: LlmPlannerPlan) => void): LlmPlannerPlan {
  const plan = basePlan();
  mutator(plan);
  return plan;
}

function main(): void {
  const validator = new PlanValidator();
  const valid = validator.validate(basePlan());
  assert(valid.accepted, "valid source-traced strict plan should be accepted");
  assert(valid.executablePlan?.safety.currentInstructionProtected === true, "accepted plan should preserve executable clone");

  assert(
    codes(mutated((plan) => {
      (plan.safety as unknown as Record<string, unknown>).markdownRuntimeFactSource = true;
    }))
      .includes("markdown_runtime_fact_source"),
    "Markdown/Knowledge/AgentVault must never be accepted as runtime fact source",
  );
  assert(
    codes(mutated((plan) => {
      (plan.safety as unknown as Record<string, unknown>).toolOutputAsSource = true;
    }))
      .includes("tool_output_as_source"),
    "tool_call/tool_result must never be accepted as Source",
  );
  assert(
    codes(mutated((plan) => {
      plan.retrieval.sourceTraceRequired = false;
    }))
      .includes("strict_without_source_trace"),
    "strict retrieval must require source trace",
  );
  assert(
    codes(mutated((plan) => {
      plan.retrieval.strength = "forensic";
      plan.retrieval.sourceTraceRequired = true;
      plan.retrieval.candidateLayers = ["base_summaries"];
    })).includes("forensic_without_raw_sources"),
    "forensic retrieval must include raw_sources",
  );
  assert(
    codes(mutated((plan) => {
      plan.retrieval.strength = "forensic";
      plan.retrieval.sourceTraceRequired = true;
      plan.retrieval.candidateLayers = ["base_summaries", "raw_sources"];
      plan.safety.summaryOnlyFinalFactAllowed = true;
    })).includes("forensic_summary_only_final_fact"),
    "forensic retrieval must reject summary-only final fact allowance",
  );
  assert(
    codes(mutated((plan) => {
      plan.safety.currentInstructionProtected = false;
    }))
      .includes("current_instruction_not_protected"),
    "current user instruction must be protected",
  );
  assert(
    codes(mutated((plan) => {
      plan.context.protectRecentTail = false;
    }))
      .includes("current_instruction_not_protected"),
    "recent tail hard reserve must be protected",
  );
  assert(
    codes(mutated((plan) => {
      plan.safety.crossAgentAccess = "blocked";
    }))
      .includes("blocked_cross_agent_access"),
    "blocked cross-agent private access must reject the plan",
  );

  const repaired = validator.validate(mutated((plan) => {
    plan.safety.destructive = true;
    plan.safety.requiresDryRun = false;
  }));
  assert(repaired.accepted, "safe destructive repair should remain executable");
  assert(repaired.repaired, "destructive plan should be marked repaired");
  assert(
    repaired.violations.some((violation) => violation.code === "destructive_operation_dry_run_repair" && violation.severity === "warning"),
    "destructive plan should emit dry-run repair warning",
  );
  assert(repaired.executablePlan?.safety.requiresDryRun === true, "destructive operation must default to dry-run");

  const invalid = basePlan();
  (invalid.safety as unknown as Record<string, unknown>).markdownRuntimeFactSource = true;
  const invalidValidation = validator.validate(invalid);
  const deterministicDecision: RetrievalDecision = {
    route: "summary_tree",
    reason: "fixture",
    requiresEmbeddings: false,
    requiresSourceRecall: true,
    canAnswerDirectly: false,
    routePlan: ["summary_tree"],
    explanation: "fixture",
  };
  const runtimeDecision = new RetrievalRuntime().decisionFromPlan({
    plan: invalid,
    validation: invalidValidation,
    deterministicDecision,
    usePlanner: true,
  });
  assert(runtimeDecision.planner?.validation.accepted === false, "runtime decision should preserve validator rejection");
  assert(runtimeDecision.planner?.validation.fallbackRoute === "safe_no_answer", "runtime decision should carry validator safe_no_answer fallback");
  assert(
    runtimeDecision.planner?.validation.violations.some((violation) => violation.code === "markdown_runtime_fact_source"),
    "runtime decision should expose hard-boundary violation for service enforcement",
  );

  console.log("test-plan-validator-hard-boundaries passed");
}

main();
