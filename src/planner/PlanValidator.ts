import {
  LlmPlannerPlan,
  PlanValidationResult,
  PlanValidationViolation,
} from "./LLMPlannerTypes";

export class PlanValidator {
  validate(plan: LlmPlannerPlan): PlanValidationResult {
    const violations: PlanValidationViolation[] = [];
    let repaired = false;
    let executablePlan: LlmPlannerPlan | undefined = this.clone(plan);

    if (plan.safety.markdownRuntimeFactSource !== false) {
      violations.push({
        code: "markdown_runtime_fact_source",
        severity: "error",
        message: "Planner attempted to make Markdown/Knowledge/AgentVault a runtime fact source.",
      });
    }

    if (plan.safety.toolOutputAsSource !== false) {
      violations.push({
        code: "tool_output_as_source",
        severity: "error",
        message: "Planner attempted to treat tool calls or tool results as Source.",
      });
    }

    if (
      (plan.retrieval.strength === "strict" || plan.retrieval.strength === "forensic") &&
      !plan.retrieval.sourceTraceRequired
    ) {
      violations.push({
        code: "strict_without_source_trace",
        severity: "error",
        message: `${plan.retrieval.strength} retrieval requires sourceTraceRequired=true.`,
      });
    }

    if (
      plan.retrieval.strength === "forensic" &&
      !plan.retrieval.candidateLayers.includes("raw_sources")
    ) {
      violations.push({
        code: "forensic_without_raw_sources",
        severity: "error",
        message: "forensic retrieval must include raw_sources in candidateLayers.",
      });
    }

    if (plan.retrieval.strength === "forensic" && plan.safety.summaryOnlyFinalFactAllowed) {
      violations.push({
        code: "forensic_summary_only_final_fact",
        severity: "error",
        message: "forensic retrieval cannot allow summary-only evidence as a final fact.",
      });
    }

    if (!plan.safety.currentInstructionProtected || !plan.context.protectRecentTail) {
      violations.push({
        code: "current_instruction_not_protected",
        severity: "error",
        message: "Current user instruction and recent tail must be protected from long-term-memory override.",
      });
    }

    if (plan.safety.crossAgentAccess === "blocked") {
      violations.push({
        code: "blocked_cross_agent_access",
        severity: "error",
        message: "Planner requested cross-agent private memory access that is blocked by policy.",
      });
    }

    if (executablePlan) {
      const repairedSteps = executablePlan.retrieval.routePlan.map((step, index) => {
        if (step.layer === "rag_candidates" && step.action !== "retrieve") {
          repaired = true;
          violations.push({
            code: "rag_candidate_only_repair",
            severity: "warning",
            message: "RAG is candidate discovery only and must use retrieve.",
            repair: "Set rag_candidates action to retrieve.",
          });
          return { ...step, action: "retrieve" as const, order: step.order ?? index + 1 };
        }
        if (step.layer === "graph_neighbors" && step.action !== "expand") {
          repaired = true;
          violations.push({
            code: "graph_candidate_only_repair",
            severity: "warning",
            message: "Graph is candidate/provenance expansion only and must use expand.",
            repair: "Set graph_neighbors action to expand.",
          });
          return { ...step, action: "expand" as const, order: step.order ?? index + 1 };
        }
        if (step.layer === "rerank" && step.action !== "order") {
          repaired = true;
          violations.push({
            code: "rerank_order_only_repair",
            severity: "warning",
            message: "Rerank may only order existing candidates and must use order.",
            repair: "Set rerank action to order.",
          });
          return { ...step, action: "order" as const, order: step.order ?? index + 1 };
        }
        return { ...step, order: step.order ?? index + 1 };
      });
      executablePlan = {
        ...executablePlan,
        retrieval: {
          ...executablePlan.retrieval,
          routePlan: repairedSteps,
        },
      };
    }

    if (
      plan.retrieval.candidateLayers.includes("rerank") &&
      !(executablePlan?.retrieval.routePlan ?? []).some((step) => step.layer === "rerank" && step.action === "order")
    ) {
      violations.push({
        code: "rerank_layer_without_order_step",
        severity: "error",
        message: "Candidate rerank layer must include a rerank.order route step before final context selection.",
      });
    }

    for (const step of plan.retrieval.routePlan) {
      if ((step.layer === "rag_candidates" || step.layer === "graph_neighbors") && step.action === "verify") {
        violations.push({
          code: "heavy_candidate_lane_as_authority",
          severity: "error",
          message: `${step.layer} is candidate-only and cannot be used as a final verification authority.`,
        });
      }
    }

    if (plan.safety.destructive && !plan.safety.requiresDryRun && executablePlan) {
      executablePlan = {
        ...executablePlan,
        safety: {
          ...executablePlan.safety,
          requiresDryRun: true,
        },
      };
      repaired = true;
      violations.push({
        code: "destructive_operation_dry_run_repair",
        severity: "warning",
        message: "Destructive operations must default to dry-run.",
        repair: "Set safety.requiresDryRun=true.",
      });
    }

    const errorCount = violations.filter((violation) => violation.severity === "error").length;
    if (errorCount > 0) {
      return {
        accepted: false,
        repaired,
        violations,
        fallbackRoute: "safe_no_answer",
      };
    }

    return {
      accepted: true,
      repaired,
      violations,
      executablePlan,
    };
  }

  private clone(plan: LlmPlannerPlan): LlmPlannerPlan {
    return {
      ...plan,
      activation: { ...plan.activation, triggers: [...plan.activation.triggers] },
      intent: {
        ...plan.intent,
        alternatives: plan.intent.alternatives.map((alternative) => ({
          ...alternative,
          evidence: [...alternative.evidence],
          ambiguity: [...alternative.ambiguity],
        })),
        ambiguity: [...plan.intent.ambiguity],
      },
      retrieval: {
        ...plan.retrieval,
        candidateLayers: [...plan.retrieval.candidateLayers],
        routePlan: plan.retrieval.routePlan.map((step) => ({ ...step })),
      },
      context: {
        ...plan.context,
        preferredSplits: { ...plan.context.preferredSplits },
      },
      memoryWrite: {
        ...plan.memoryWrite,
        candidateKinds: [...plan.memoryWrite.candidateKinds],
      },
      safety: { ...plan.safety },
      explain: {
        ...plan.explain,
        whyTheseLayers: [...plan.explain.whyTheseLayers],
      },
      deterministic: {
        ...plan.deterministic,
        routePlan: [...plan.deterministic.routePlan],
      },
      fallback: plan.fallback ? { ...plan.fallback } : undefined,
    };
  }
}
