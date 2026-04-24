import { BridgeConfig, SummaryEntry } from "../types";

export interface KnowledgeIntakeDecision {
  accepted: boolean;
  reason: string;
}

export class KnowledgeIntakeGate {
  decide(
    summary: SummaryEntry,
    config: Pick<
      BridgeConfig,
      | "knowledgeIntakeMode"
      | "knowledgeIntakeAllowProjectState"
      | "knowledgeIntakeAllowBranchSummaries"
    >,
  ): KnowledgeIntakeDecision {
    const summaryLevel = summary.summaryLevel ?? 1;
    const nodeKind = summary.nodeKind ?? "leaf";
    const promotionIntent = summary.promotionIntent ?? "candidate";
    const memoryType = summary.memoryType ?? "general";
    const thresholds = this.resolveThresholds(config.knowledgeIntakeMode);

    if ((summary.recordStatus ?? "active") !== "active") {
      return this.reject("summary_not_active");
    }

    if (
      !config.knowledgeIntakeAllowBranchSummaries &&
      (summaryLevel !== 1 || nodeKind !== "leaf")
    ) {
      return this.reject("only_level_one_leaf_summaries_enter_knowledge_raw");
    }

    if (promotionIntent === "navigation_only") {
      return this.reject("navigation_only_summary_stays_in_asset_layer");
    }

    if (!summary.sourceHash || typeof summary.sourceMessageCount !== "number") {
      return this.reject("summary_missing_source_boundary");
    }

    const durableSignalCount = [
      summary.decisions.length > 0,
      summary.constraints.length > 0,
      summary.exactFacts.length > 0,
      (summary.keyEntities ?? []).length > 0,
    ].filter(Boolean).length;
    const hasStrongPromotionIntent =
      promotionIntent === "promote" || promotionIntent === "priority_promote";
    const hasDurableType = [
      "decision",
      "constraint",
      "diagnostic",
      "preference",
      "feedback",
    ].includes(memoryType);

    if (
      memoryType === "project_state" &&
      !config.knowledgeIntakeAllowProjectState &&
      !hasStrongPromotionIntent &&
      durableSignalCount < thresholds.projectStateSignals
    ) {
      return this.reject("project_state_summary_stays_in_asset_layer");
    }

    if (hasStrongPromotionIntent) {
      return this.accept("summary_has_explicit_promotion_intent");
    }

    if (memoryType === "project_state" && config.knowledgeIntakeAllowProjectState) {
      return this.accept("project_state_allowed_by_intake_policy");
    }

    if (hasDurableType && durableSignalCount >= thresholds.durableSignals) {
      return this.accept("summary_has_durable_memory_type_signal");
    }

    if (durableSignalCount >= thresholds.generalSignals) {
      return this.accept("summary_has_sufficient_structured_long_term_signals");
    }

    return this.reject("summary_lacks_long_term_knowledge_signals");
  }

  private accept(reason: string): KnowledgeIntakeDecision {
    return {
      accepted: true,
      reason,
    };
  }

  private reject(reason: string): KnowledgeIntakeDecision {
    return {
      accepted: false,
      reason,
    };
  }

  private resolveThresholds(mode: BridgeConfig["knowledgeIntakeMode"]): {
    generalSignals: number;
    durableSignals: number;
    projectStateSignals: number;
  } {
    switch (mode) {
      case "conservative":
        return {
          generalSignals: 3,
          durableSignals: 2,
          projectStateSignals: 3,
        };
      case "aggressive":
        return {
          generalSignals: 1,
          durableSignals: 1,
          projectStateSignals: 1,
        };
      case "balanced":
      default:
        return {
          generalSignals: 2,
          durableSignals: 1,
          projectStateSignals: 2,
        };
    }
  }
}
