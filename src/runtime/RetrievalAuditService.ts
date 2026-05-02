import type { ContextPlannerResult } from "../engines/ContextPlanner";
import type { LifecycleContext } from "../host/OpenClawPayloadAdapter";
import type { RetrievalVerificationResult } from "../retrieval/RetrievalVerifier";
import type {
  RetrievalDecision,
  ProgressiveRetrievalStepRecord,
} from "../types";
import type { PlannerAuditContext, EvidenceGateResult } from "./RetrievalServiceContracts";
import { ChaunyomsSessionRuntime } from "./ChaunyomsSessionRuntime";

export class RetrievalAuditService {
  constructor(private readonly runtime: ChaunyomsSessionRuntime) {}

  buildProgressiveRetrievalSteps(args: PlannerAuditContext): ProgressiveRetrievalStepRecord[] {
    const planner = args.decision.planner;
    if (!planner || planner.routeSteps.length === 0) {
      return [];
    }
    const selected = args.planned?.plan.selected ?? [];
    const rejected = args.planned?.plan.rejected ?? [];
    const sourceTrace = args.recallResult?.sourceTrace ?? [];
    const verifiedTraceCount = sourceTrace.filter((trace) => trace.verified).length;
    const terminalIndex = this.resolveTerminalPlannerStepIndex(planner.routeSteps, args.retrievalVerification);
    return planner.routeSteps.map((step, index) => {
      const layerSelected = selected.filter((candidate) => this.candidateMatchesPlannerLayer(candidate.source, step.layer));
      const layerRejected = rejected.filter((candidate) => this.candidateMatchesPlannerLayer(candidate.source, step.layer));
      const isRawStep = step.layer === "raw_sources";
      const isRerankStep = step.layer === "rerank";
      const candidatesFound = isRawStep
        ? Math.max(sourceTrace.length, args.recallResult?.rawCandidateCount ?? 0)
        : isRerankStep
          ? args.rerankAudit?.candidateCount ?? 0
          : layerSelected.length + layerRejected.length;
      const stopTriggered = index === terminalIndex;
      return {
        plannerRunId: planner.runId,
        stepIndex: index,
        layer: step.layer,
        action: step.action,
        query: args.query,
        candidatesFound,
        selectedCount: isRawStep
          ? sourceTrace.length
          : isRerankStep
            ? args.rerankAudit?.orderedCandidateIds.length ?? 0
            : layerSelected.length,
        rejectedCount: isRerankStep ? 0 : layerRejected.length,
        rejectedReasons: isRerankStep
          ? args.rerankAudit?.reasons ?? []
          : [...new Set(layerRejected.map((candidate) => candidate.rejectedReason))],
        sourceVerifiedCount: isRawStep
          ? verifiedTraceCount
          : layerSelected.filter((candidate) => candidate.authority === "raw_evidence" || candidate.authority === "source_backed_summary").length,
        latencyMs: this.estimateStepLatencyMs(step.action, args.timings),
        stopTriggered,
        stopReason: stopTriggered
          ? this.resolvePlannerStopReason(args.retrievalVerification, args.evidenceGate, step.stopIf)
          : step.stopIf,
        reason: step.reason,
        stopIf: step.stopIf,
        order: step.order,
        budgetTokens: step.budgetTokens,
      };
    });
  }

  async recordPlannerAuditOnly(
    context: Pick<LifecycleContext, "sessionId" | "config" | "totalBudget">,
    query: string,
    decision: RetrievalDecision,
    intent: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (!decision.planner) {
      return;
    }
    const now = new Date().toISOString();
    const plan: ContextPlannerResult = {
      runId: `context-${decision.planner.runId}`,
      createdAt: now,
      selected: [],
      rejected: [],
      selectedTokens: 0,
      candidateCount: decision.planner.routeSteps.length,
      budget: 0,
    };
    const progressiveRetrievalSteps = this.buildProgressiveRetrievalSteps({
      query,
      decision,
    });
    await this.runtime.recordRetrievalPlan(context, intent, plan, 0, {
      query,
      route: decision.route,
      retrievalStrength: context.config.retrievalStrength,
      usageFeedbackEnabled: context.config.usageFeedbackEnabled,
      planner: decision.planner,
      plannerRunId: decision.planner.runId,
      plannerIntent: decision.planner.intent.primary,
      selectedPlan: decision.planner.selectedPlan,
      sourceTraceRequired: decision.planner.sourceTraceRequired,
      progressiveRetrievalSteps,
      ...extra,
    });
  }

  private resolveTerminalPlannerStepIndex(
    steps: Array<{ action: string; layer: string }>,
    verification?: RetrievalVerificationResult,
  ): number {
    if (!verification) {
      return Math.max(steps.length - 1, 0);
    }
    if (verification.status === "sufficient") {
      const verifyIndex = steps.findIndex((step) => step.action === "verify");
      if (verifyIndex >= 0) {
        return verifyIndex;
      }
      const rawIndex = steps.findIndex((step) => step.layer === "raw_sources");
      return rawIndex >= 0 ? rawIndex : Math.max(steps.length - 1, 0);
    }
    return Math.max(steps.length - 1, 0);
  }

  private resolvePlannerStopReason(
    verification?: RetrievalVerificationResult,
    evidenceGate?: EvidenceGateResult,
    stopIf?: string,
  ): string {
    if (verification) {
      return `retrieval_verifier:${verification.status}:${verification.recommendedAction}`;
    }
    if (evidenceGate) {
      return `evidence_gate:${evidenceGate.status}:${evidenceGate.recommendedAction}`;
    }
    return stopIf ?? "route_exhausted";
  }

  private estimateStepLatencyMs(action: string, timings?: Record<string, number>): number {
    if (!timings) {
      return 0;
    }
    if (action === "verify") {
      return 0;
    }
    if (action === "expand") {
      return Number(timings.resolveMs ?? 0);
    }
    return Number(timings.planMs ?? 0);
  }

  private candidateMatchesPlannerLayer(source: string, layer: string): boolean {
    switch (layer) {
      case "recent_tail":
        return source === "recent_tail";
      case "memory_items":
        return source === "active_memory";
      case "base_summaries":
        return source === "summary_context";
      case "rag_candidates":
      case "graph_neighbors":
        return source === "summary_context" || source === "active_memory";
      case "rerank":
        return true;
      case "raw_sources":
        return source === "raw_exact_search";
      case "knowledge_export_index":
        return source === "reviewed_asset";
      case "project_registry":
        return source === "active_memory";
      default:
        return false;
    }
  }
}
