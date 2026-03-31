import { RetrievalDecision } from "../types";

const FACT_RECALL_RE =
  /(原话|原文|精确|准确|参数|细节|约束|配置|当时怎么说|具体怎么说|quote|exact|verbatim|parameter|constraint|detail)/i;
const NAVIGATION_RE =
  /(最近|近况|当前在做|主线|待办|todo|decision|导航|active topic|recent)/i;
const SHARED_INSIGHTS_RE =
  /(shared[- ]?insights|共享沉淀|共享记忆|insight)/i;
const KNOWLEDGE_BASE_RE =
  /(knowledge[- ]?base|知识库|文档|资料|架构文档|v2|v3|版本差异|topic-index)/i;
const DAG_RE =
  /(还记得吗|之前有个|历史对话|旧会话|30天外|压缩前|摘要层|dag|summary)/i;
const FUZZY_SEARCH_RE =
  /(有篇|好像有个|我记得有|类似那个|相关资料|找一下相关|搜一下相关|something about|something related)/i;

export interface RouteContext {
  memorySearchEnabled: boolean;
  hasTopicIndexHit?: boolean;
  hasSharedInsightHint?: boolean;
  hasNavigationHint?: boolean;
}

export class MemoryRetrievalRouter {
  decide(query: string, context: RouteContext): RetrievalDecision {
    const normalized = query.trim();
    if (!normalized) {
      return this.decision("recent_tail", "empty_query_defaults_to_recent_tail", false, false, true);
    }

    const needsFacts = FACT_RECALL_RE.test(normalized);
    const mentionsNavigation = NAVIGATION_RE.test(normalized);
    const mentionsInsights = SHARED_INSIGHTS_RE.test(normalized);
    const mentionsKb = KNOWLEDGE_BASE_RE.test(normalized);
    const mentionsDag = DAG_RE.test(normalized);
    const fuzzyLookup = FUZZY_SEARCH_RE.test(normalized);

    if (mentionsNavigation && !needsFacts) {
      return this.decision("navigation", "recent_workflow_question", false, false, true);
    }

    if (mentionsNavigation && needsFacts) {
      return this.decision("dag", "navigation_hit_but_fact_recall_required", false, true, false);
    }

    if (mentionsInsights && (fuzzyLookup || !context.hasSharedInsightHint)) {
      return this.decision(
        context.memorySearchEnabled ? "vector_search" : "shared_insights",
        context.memorySearchEnabled ? "shared_insights_fuzzy_lookup_with_embeddings" : "shared_insights_fuzzy_lookup_without_embeddings",
        !context.memorySearchEnabled,
        false,
        context.memorySearchEnabled,
      );
    }

    if (mentionsInsights) {
      return this.decision("shared_insights", "shared_insights_route_hit", false, false, true);
    }

    if (mentionsKb && (fuzzyLookup || !context.hasTopicIndexHit)) {
      return this.decision(
        context.memorySearchEnabled ? "vector_search" : "knowledge_base",
        context.memorySearchEnabled ? "knowledge_base_fuzzy_lookup_with_embeddings" : "knowledge_base_fuzzy_lookup_without_embeddings",
        !context.memorySearchEnabled,
        false,
        context.memorySearchEnabled,
      );
    }

    if (mentionsKb) {
      return this.decision("knowledge_base", "knowledge_base_route_hit", false, needsFacts, !needsFacts);
    }

    if (mentionsDag || needsFacts) {
      return this.decision("dag", needsFacts ? "fact_question_requires_source_recall" : "historical_dialog_recall", false, true, false);
    }

    return this.decision("recent_tail", "default_recent_tail", false, false, true);
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
