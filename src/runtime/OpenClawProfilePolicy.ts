import { estimateTokens } from "../utils/tokenizer";
import type { ContextItem, RawMessageRepository, SummaryRepository, BridgeConfig } from "../types";
import type { LifecycleContext } from "../host/OpenClawPayloadAdapter";
import type { RetrievalDecision } from "../types";
import type { RecallQueryAnalyzer } from "../resolvers/RecallQueryAnalyzer";

export interface OpenClawProfilePolicyDeps {
  buildRecallSystemItem: () => ContextItem;
  recallQueryAnalyzer: RecallQueryAnalyzer;
  referencesCurrentWork: (query: string) => boolean;
}

export class OpenClawProfilePolicy {
  constructor(private readonly deps: OpenClawProfilePolicyDeps) {}

  isLightweight(config: Pick<BridgeConfig, "openClawRuntimeProfile">): boolean {
    return config.openClawRuntimeProfile === "lightweight";
  }

  shouldClassifyKnowledgeIntent(
    payload: Pick<BridgeConfig, "openClawRuntimeProfile">,
    role: string,
  ): boolean {
    return role === "user" && !this.isLightweight(payload);
  }

  shouldIncludeMemoryItemsInAssembly(
    config: Pick<BridgeConfig, "emergencyBrake" | "openClawRuntimeProfile">,
  ): boolean {
    return !config.emergencyBrake && !this.isLightweight(config);
  }

  injectRecallGuidanceIfNeeded(
    items: ContextItem[],
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    context: LifecycleContext,
    config: Pick<BridgeConfig, "openClawRuntimeProfile" | "forceDagOnlyRecall" | "maxFreshTailTurns">,
  ): ContextItem[] {
    if (!this.isLightweight(config)) {
      return items;
    }
    const alreadyHasGuidance = items.some((item) => item.metadata?.layer === "oms_recall_guidance");
    const alreadyHasSystemPolicy = items.some((item) => item.metadata?.layer === "oms_recall_policy");
    if (alreadyHasGuidance && alreadyHasSystemPolicy) {
      return items;
    }
    const prefixed: ContextItem[] = [
      ...(alreadyHasSystemPolicy ? [] : [this.deps.buildRecallSystemItem()]),
      ...items,
    ];
    const summaryCount = summaryStore.getAllSummaries({ sessionId: context.sessionId }).length;
    const rawCount = rawStore.getAll({ sessionId: context.sessionId }).length;
    if (summaryCount > 0 || rawCount < Math.max(config.maxFreshTailTurns * 2, 6)) {
      return prefixed;
    }
    const guidanceText = [
      "[oms_recall_guidance]",
      "Earlier turns may be outside the visible recent tail.",
      config.forceDagOnlyRecall
        ? "For exact prior facts, use memory_retrieve and follow the summary/DAG recall path; direct raw-message grep is disabled in this environment."
        : "For exact prior facts, use memory_retrieve first and oms_grep for direct raw-message lookup.",
      "Do not answer 'not found' until recall has been tried.",
    ].join("\n");
    const guidance: ContextItem = {
      kind: "summary",
      tokenCount: estimateTokens(guidanceText),
      content: guidanceText,
      metadata: {
        layer: "oms_recall_guidance",
        profile: "lightweight",
        rawMessageCount: rawCount,
        summaryCount,
      },
    };
    return [guidance, ...prefixed];
  }

  shouldRunLightweightAfterTurnCompaction(
    config: Pick<BridgeConfig, "openClawRuntimeProfile">,
  ): boolean {
    return this.isLightweight(config);
  }

  shouldSkipProjectRegistryAfterTurn(
    config: Pick<BridgeConfig, "openClawRuntimeProfile">,
  ): boolean {
    return this.isLightweight(config);
  }

  shouldPreferDagOnlyRecall(
    query: string,
    summaryStore: SummaryRepository,
    context: Pick<LifecycleContext, "config">,
  ): boolean {
    if (context.config.forceDagOnlyRecall) {
      return true;
    }
    if (!this.isLightweight(context.config)) {
      return false;
    }
    if (summaryStore.getAllSummaries().length === 0) {
      return false;
    }
    return this.isLosslessStyleFactRecallQuery(query) || this.isDagOnlyKeywordRecallQuery(query);
  }

  applyRecallDecisionOverride(
    query: string,
    context: Pick<LifecycleContext, "config">,
    decision: RetrievalDecision,
    hasHistoricalStore: boolean,
  ): RetrievalDecision {
    if (!this.isLightweight(context.config)) {
      return decision;
    }
    if (!hasHistoricalStore) {
      return decision;
    }
    if (!this.isLosslessStyleFactRecallQuery(query) && !this.isDagOnlyKeywordRecallQuery(query)) {
      return decision;
    }
    if (decision.route === "memory_item") {
      return decision;
    }
    if (decision.route === "summary_tree" && decision.requiresSourceRecall) {
      return decision;
    }
    return {
      ...decision,
      route: "summary_tree",
      reason: "lightweight_fact_qa_forces_summary_tree",
      requiresSourceRecall: true,
      canAnswerDirectly: false,
      routePlan: ["summary_tree", "recent_tail"],
      explanation: "This is a historical fact lookup under the lightweight OpenClaw profile, so OMS should follow the summary/DAG-to-source recall chain instead of answering from volatile context or substrate memory.",
    };
  }

  private isLosslessStyleFactRecallQuery(query: string): boolean {
    return /^(who|what|where|when|which)\b|how\s+(?:long|much|many)\b|(?:什么|哪里|哪儿|何时|什么时候|多久|多长|多少)/i.test(query.trim());
  }

  private isDagOnlyKeywordRecallQuery(query: string): boolean {
    const understanding = this.deps.recallQueryAnalyzer.analyze(query);
    if (understanding.historyQa) {
      return true;
    }
    if (understanding.terms.length === 0 || understanding.terms.length > 8) {
      return false;
    }
    if (this.deps.referencesCurrentWork(query)) {
      return false;
    }
    if (/(status|state|progress|next step|next action|todo|pending|blocker|decision|knowledge|doc|docs|architecture|project|repo|branch|build|test)/i.test(query)) {
      return false;
    }
    return understanding.answerType !== "unknown" || understanding.transcriptLike;
  }
}
