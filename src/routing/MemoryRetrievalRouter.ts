import { RetrievalDecision } from "../types";

const FACT_RECALL_RE =
  /(原话|原文|精确|准确|参数|细节|约束|配置|当时怎么说|quote|exact|verbatim|parameter|constraint|detail)/i;
const STATE_RE =
  /(当前状态|项目状态|现在在做|在做什么|进度|下一步|待办|未解决|阻塞|卡住|决策|状态|what should we do next|where did we leave off|next step|next action|todo|pending|unresolved|blocker|blocked|decision|status|state|progress|working on|follow[- ]?up|dependency|dependencies|risk)/i;
const NAVIGATION_RE =
  /(active topic|recent|current|navigation|current focus|status|state|progress|todo|decision|next step|blocker)/i;
const SHARED_INSIGHTS_RE =
  /(shared[- ]?insights|共享洞察|共享记忆|insight)/i;
const KNOWLEDGE_BASE_RE =
  /(knowledge[- ]?base|知识库|文档|资料|架构文档|v2|v3|版本差异|topic-index)/i;
const DAG_RE =
  /(还记得吗|之前有个|历史对话|旧对话|压缩前|摘要|dag|summary|history)/i;
const FUZZY_SEARCH_RE =
  /(有篇|好像有个|我记得有|类似那个|相关资料|找一下相关|搜一下相关|something about|something related)/i;
const COMPLEX_TASK_RE =
  /(怎么推进|怎么做|如何处理|怎么拆|计划|方案|顺序|依赖|风险|取舍|tradeoff|compare|versus| vs |plan|sequence|dependency|dependencies|risk|rollout|migration|what's left|what remains|how should)/i;
const CURRENT_WORK_RE =
  /(这个项目|当前任务|这件事|这个问题|我们现在|当前工作|当前主线|this project|current task|current work|our work|we are|we're|what we are doing|where we left off)/i;

export interface RouteContext {
  memorySearchEnabled: boolean;
  hasTopicIndexHit?: boolean;
  hasSharedInsightHint?: boolean;
  hasNavigationHint?: boolean;
  hasStructuredNavigationState?: boolean;
  hasCompactedHistory?: boolean;
  recentAssistantUncertainty?: boolean;
  queryComplexity?: "low" | "medium" | "high";
  referencesCurrentWork?: boolean;
}

export class MemoryRetrievalRouter {
  decide(query: string, context: RouteContext): RetrievalDecision {
    const normalized = query.trim();
    if (!normalized) {
      return this.decision(
        "recent_tail",
        "empty_query_defaults_to_recent_tail",
        false,
        false,
        true,
      );
    }

    const needsFacts = FACT_RECALL_RE.test(normalized);
    const asksForState = STATE_RE.test(normalized);
    const mentionsNavigation = NAVIGATION_RE.test(normalized);
    const mentionsInsights = SHARED_INSIGHTS_RE.test(normalized);
    const mentionsKb = KNOWLEDGE_BASE_RE.test(normalized);
    const mentionsDag = DAG_RE.test(normalized);
    const fuzzyLookup = FUZZY_SEARCH_RE.test(normalized);
    const asksComplexTask = COMPLEX_TASK_RE.test(normalized);
    const referencesCurrentWork =
      context.referencesCurrentWork ?? CURRENT_WORK_RE.test(normalized);
    const queryComplexity =
      context.queryComplexity ?? (asksComplexTask ? "high" : "low");
    const stateAvailable =
      context.hasStructuredNavigationState || context.hasNavigationHint;

    if ((mentionsNavigation || asksForState) && !needsFacts) {
      return this.decision(
        "navigation",
        asksForState ? "project_state_question" : "recent_workflow_question",
        false,
        false,
        true,
      );
    }

    if ((mentionsNavigation || asksForState) && needsFacts) {
      return this.decision(
        "dag",
        asksForState
          ? "state_question_but_fact_recall_required"
          : "navigation_hit_but_fact_recall_required",
        false,
        true,
        false,
      );
    }

    if (
      stateAvailable &&
      referencesCurrentWork &&
      (queryComplexity === "high" || asksComplexTask)
    ) {
      return this.decision(
        "navigation",
        "complex_task_state_upgrade",
        false,
        false,
        true,
      );
    }

    if (
      context.recentAssistantUncertainty &&
      stateAvailable &&
      (referencesCurrentWork || context.hasCompactedHistory)
    ) {
      return this.decision(
        "navigation",
        "assistant_uncertainty_state_upgrade",
        false,
        false,
        true,
      );
    }

    if (mentionsInsights && (fuzzyLookup || !context.hasSharedInsightHint)) {
      return this.decision(
        context.memorySearchEnabled ? "vector_search" : "shared_insights",
        context.memorySearchEnabled
          ? "shared_insights_fuzzy_lookup_with_embeddings"
          : "shared_insights_fuzzy_lookup_without_embeddings",
        !context.memorySearchEnabled,
        false,
        context.memorySearchEnabled,
      );
    }

    if (mentionsInsights) {
      return this.decision(
        "shared_insights",
        "shared_insights_route_hit",
        false,
        false,
        true,
      );
    }

    if (mentionsKb && (fuzzyLookup || !context.hasTopicIndexHit)) {
      return this.decision(
        context.memorySearchEnabled ? "vector_search" : "knowledge_base",
        context.memorySearchEnabled
          ? "knowledge_base_fuzzy_lookup_with_embeddings"
          : "knowledge_base_fuzzy_lookup_without_embeddings",
        !context.memorySearchEnabled,
        false,
        context.memorySearchEnabled,
      );
    }

    if (mentionsKb) {
      return this.decision(
        "knowledge_base",
        "knowledge_base_route_hit",
        false,
        needsFacts,
        !needsFacts,
      );
    }

    if (mentionsDag || needsFacts) {
      return this.decision(
        "dag",
        needsFacts
          ? "fact_question_requires_source_recall"
          : "historical_dialog_recall",
        false,
        true,
        false,
      );
    }

    return this.decision(
      "recent_tail",
      "default_recent_tail",
      false,
      false,
      true,
    );
  }

  private decision(
    route: RetrievalDecision["route"],
    reason: string,
    requiresEmbeddings: boolean,
    requiresSourceRecall: boolean,
    canAnswerDirectly: boolean,
  ): RetrievalDecision {
    return {
      route,
      reason,
      requiresEmbeddings,
      requiresSourceRecall,
      canAnswerDirectly,
    };
  }
}
