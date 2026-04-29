import {
  RetrievalDecision,
  RetrievalLayerScore,
  RetrievalRoute,
} from "../types";
import {
  LlmPlannerPlan,
  PlannerCandidateLayer,
  PlanValidationResult,
} from "../planner/LLMPlannerTypes";

export interface PlannerDecisionMetadata {
  runId: string;
  activationMode: string;
  llmInvoked: boolean;
  selectedPlan: "planner" | "deterministic";
  intent: {
    primary: string;
    confidence: number;
    ambiguity: string[];
  };
  validation: {
    accepted: boolean;
    repaired: boolean;
    fallbackRoute?: string;
    violations: Array<{ code: string; severity: string; message: string; repair?: string }>;
  };
  routeSteps: Array<{
    layer: string;
    action: string;
    order?: number;
    reason: string;
    stopIf?: string;
    budgetTokens?: number;
  }>;
  stopCondition: string;
  sourceTraceRequired: boolean;
  fallback?: LlmPlannerPlan["fallback"];
  deterministicRoute: RetrievalRoute;
  deterministicRoutePlan: RetrievalRoute[];
}

export class RetrievalRuntime {
  decisionFromPlan(args: {
    plan: LlmPlannerPlan;
    validation: PlanValidationResult;
    deterministicDecision: RetrievalDecision;
    usePlanner: boolean;
  }): RetrievalDecision {
    const executablePlan = args.validation.executablePlan ?? args.plan;
    const selectedPlan = args.usePlanner && args.validation.accepted ? "planner" : "deterministic";
    const routePlan = selectedPlan === "planner"
      ? this.routesFromLayers(executablePlan.retrieval.candidateLayers)
      : args.deterministicDecision.routePlan;
    const route = routePlan[0] ?? args.deterministicDecision.route;
    const layerScores = this.mergeLayerScores(
      args.deterministicDecision.layerScores ?? [],
      executablePlan,
      selectedPlan,
    );
    return {
      ...args.deterministicDecision,
      route,
      routePlan,
      reason: selectedPlan === "planner"
        ? `planner_${executablePlan.intent.primary}`
        : args.deterministicDecision.reason,
      requiresSourceRecall: selectedPlan === "planner"
        ? executablePlan.retrieval.sourceTraceRequired ||
          routePlan.includes("summary_tree")
        : args.deterministicDecision.requiresSourceRecall,
      canAnswerDirectly: selectedPlan === "planner"
        ? !executablePlan.retrieval.sourceTraceRequired
        : args.deterministicDecision.canAnswerDirectly,
      explanation: selectedPlan === "planner"
        ? executablePlan.explain.shortReason
        : args.deterministicDecision.explanation,
      layerScores,
      planner: this.metadata(executablePlan, args.validation, args.deterministicDecision, selectedPlan),
    };
  }

  metadata(
    plan: LlmPlannerPlan,
    validation: PlanValidationResult,
    deterministicDecision: RetrievalDecision,
    selectedPlan: "planner" | "deterministic",
  ): PlannerDecisionMetadata {
    return {
      runId: plan.runId,
      activationMode: plan.activation.mode,
      llmInvoked: plan.activation.llmInvoked,
      selectedPlan,
      intent: {
        primary: plan.intent.primary,
        confidence: plan.intent.confidence,
        ambiguity: plan.intent.ambiguity,
      },
      validation: {
        accepted: validation.accepted,
        repaired: validation.repaired,
        fallbackRoute: validation.fallbackRoute,
        violations: validation.violations.map((violation) => ({ ...violation })),
      },
      routeSteps: plan.retrieval.routePlan.map((step) => ({ ...step })),
      stopCondition: plan.retrieval.stopCondition,
      sourceTraceRequired: plan.retrieval.sourceTraceRequired,
      fallback: plan.fallback,
      deterministicRoute: deterministicDecision.route,
      deterministicRoutePlan: deterministicDecision.routePlan,
    };
  }

  private routesFromLayers(layers: PlannerCandidateLayer[]): RetrievalRoute[] {
    const routes: RetrievalRoute[] = [];
    const add = (route: RetrievalRoute) => {
      if (!routes.includes(route)) routes.push(route);
    };
    for (const layer of layers) {
      switch (layer) {
        case "recent_tail":
          add("recent_tail");
          break;
        case "memory_items":
          add("memory_item");
          break;
        case "project_registry":
          add("project_registry");
          break;
        case "base_summaries":
        case "raw_sources":
        case "rag_candidates":
        case "graph_neighbors":
          add("summary_tree");
          break;
        case "rerank":
          break;
        case "knowledge_export_index":
          add("knowledge");
          break;
        default:
          break;
      }
    }
    return routes.length > 0 ? routes : ["recent_tail"];
  }

  private mergeLayerScores(
    deterministic: RetrievalLayerScore[],
    plan: LlmPlannerPlan,
    selectedPlan: "planner" | "deterministic",
  ): RetrievalLayerScore[] {
    const plannerScores = this.routesFromLayers(plan.retrieval.candidateLayers).map((route, index) => ({
      route,
      score: Math.max(1, 100 - index * 10),
      reasons: [
        `planner_intent:${plan.intent.primary}`,
        `planner_selected:${selectedPlan === "planner"}`,
        `planner_run:${plan.runId}`,
      ],
    }));
    const merged = new Map<RetrievalRoute, RetrievalLayerScore>();
    for (const score of deterministic) {
      merged.set(score.route, { ...score, reasons: [...score.reasons] });
    }
    for (const score of plannerScores) {
      const current = merged.get(score.route);
      if (current) {
        current.score += score.score;
        current.reasons = [...new Set([...current.reasons, ...score.reasons])];
      } else {
        merged.set(score.route, score);
      }
    }
    return [...merged.values()].sort((left, right) => right.score - left.score || left.route.localeCompare(right.route));
  }
}
