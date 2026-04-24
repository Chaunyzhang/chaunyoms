import { RetrievalDecision, RetrievalLayerScore, RetrievalRoute } from "../types";

const FACT_RECALL_RE = /(原话|原文|精确|准确|参数|细节|约束|配置|quote|exact|verbatim|parameter|constraint|detail)/i;
const CURRENT_FACT_RE = /(current|latest|now|currently|updated|correction|after correction|现在|当前|最新|修正后|更新后)/i;
const PROJECT_STATE_RE = /(当前状态|项目状态|进度|下一步|待办|未解决|阻塞|决策|status|state|progress|next step|next action|todo|pending|blocker|blocked|decision|where we left off)/i;
const CURRENT_WORK_RE = /(这个项目|当前任务|当前工作|这件事|我们现在|当前主线|this project|current task|current work|our work|what we are doing)/i;
const HISTORY_RE = /(历史|之前|回溯|回忆|原文|历史对话|summary|history|what happened earlier|why did we)/i;
const DURABLE_RE = /(长期约束|长期决策|约束|限制|配置|规则|记住|must|constraint|decision|rule|setting|config)/i;
const KNOWLEDGE_BASE_RE = /(knowledge[- ]?base|知识库|文档|资料|topic-index|architecture docs?)/i;
const RAW_KNOWLEDGE_RE = /(raw knowledge|raw notes|manual knowledge|manual notes|原始知识|原始资料|手动知识|手动资料|手动笔记)/i;
const FUZZY_SEARCH_RE = /(类似|相关|找一下|搜一下|something about|something related|fuzzy)/i;
const COMPLEX_TASK_RE = /(怎么推进|怎么做|计划|方案|顺序|依赖|风险|tradeoff|compare|versus| vs |plan|sequence|dependency|risk|rollout|migration|what's left|what remains)/i;

export interface RouteContext {
  hasKnowledgeHits?: boolean;
  hasKnowledgeRawHint?: boolean;
  hasCompactedHistory?: boolean;
  hasProjectRegistry?: boolean;
  hasDurableHits?: boolean;
  recentAssistantUncertainty?: boolean;
  queryComplexity?: "low" | "medium" | "high";
  referencesCurrentWork?: boolean;
  matchedProjectId?: string;
  matchedProjectTitle?: string;
}

export class MemoryRetrievalRouter {
  private currentLayerScores: RetrievalLayerScore[] = [];

  decide(query: string, context: RouteContext): RetrievalDecision {
    const normalized = query.trim();
    this.currentLayerScores = this.scoreLayers(normalized, context);
    if (!normalized) {
      return this.decision("recent_tail", "empty_query_defaults_to_recent_tail", false, false, true, ["recent_tail"], "Empty query defaults to the recent conversational tail.");
    }

    const needsFacts = FACT_RECALL_RE.test(normalized);
    const asksCurrentFact = CURRENT_FACT_RE.test(normalized);
    const asksProjectState = PROJECT_STATE_RE.test(normalized);
    const referencesCurrentWork = context.referencesCurrentWork ?? CURRENT_WORK_RE.test(normalized);
    const asksHistory = HISTORY_RE.test(normalized);
    const asksDurable = DURABLE_RE.test(normalized);
    const mentionsKnowledge = KNOWLEDGE_BASE_RE.test(normalized);
    const asksRawKnowledge = RAW_KNOWLEDGE_RE.test(normalized);
    const fuzzyLookup = FUZZY_SEARCH_RE.test(normalized);
    const complexTask = COMPLEX_TASK_RE.test(normalized) || context.queryComplexity === "high";
    const explicitProjectState = this.isExplicitProjectStateQuery(normalized);

    if (asksDurable && context.hasDurableHits) {
      return this.decision(
        "durable_memory",
        context.matchedProjectId ? "matched_project_durable_memory_query" : "durable_memory_query",
        false,
        false,
        true,
        ["durable_memory", "project_registry", "summary_tree"],
        context.matchedProjectTitle
          ? `The query asks for stable constraints/decisions, so durable memory is the primary layer for the matched project (${context.matchedProjectTitle}).`
          : "The query asks for stable constraints/decisions, so durable memory is the primary layer.",
        context.matchedProjectId,
        context.matchedProjectTitle,
      );
    }

    if (needsFacts && asksCurrentFact && context.hasDurableHits) {
      return this.decision(
        "durable_memory",
        "current_fact_prefers_active_durable_memory",
        false,
        false,
        true,
        ["durable_memory", "summary_tree", "project_registry"],
        "The query asks for the current/latest fact value, so active durable memory should outrank older summary recall.",
        context.matchedProjectId,
        context.matchedProjectTitle,
      );
    }

    if (needsFacts || asksHistory) {
      return this.decision(
        "summary_tree",
        needsFacts ? "fact_question_requires_source_recall" : "historical_recall_query",
        false,
        true,
        false,
        ["summary_tree", "recent_tail"],
        "The query needs historical detail, so use the compressed history map only to navigate back to source messages.",
        context.matchedProjectId,
        context.matchedProjectTitle,
      );
    }

    if ((referencesCurrentWork || (asksProjectState && explicitProjectState)) && context.hasProjectRegistry) {
      return this.decision(
        "project_registry",
        context.matchedProjectId ? "matched_project_state_query" : "project_state_query",
        false,
        false,
        true,
        ["project_registry", "durable_memory", "recent_tail"],
        context.matchedProjectTitle
          ? `The query is about project state, so route to the project registry first (matched project: ${context.matchedProjectTitle}).`
          : "The query is about project state, so route to the project registry first.",
        context.matchedProjectId,
        context.matchedProjectTitle,
      );
    }

    if ((complexTask || context.recentAssistantUncertainty) && referencesCurrentWork && context.hasProjectRegistry) {
      return this.decision(
        "project_registry",
        complexTask ? "complex_task_state_upgrade" : "assistant_uncertainty_state_upgrade",
        false,
        false,
        true,
        ["project_registry", "durable_memory", "recent_tail"],
        "The query is coordinating current work, so prefer structured project state before raw history.",
        context.matchedProjectId,
        context.matchedProjectTitle,
      );
    }

    if (asksRawKnowledge && mentionsKnowledge) {
      return this.decision(
        "knowledge",
        "explicit_raw_knowledge_query",
        false,
        false,
        true,
        ["knowledge", "summary_tree"],
        "The query explicitly mentions raw/manual knowledge, which is retrieved through the same unified knowledge corpus.",
      );
    }

    if (mentionsKnowledge && context.hasKnowledgeHits) {
      return this.decision(
        "knowledge",
        "knowledge_route_hit",
        false,
        false,
        true,
        ["knowledge", "summary_tree"],
        "The query asks for long-term knowledge, so retrieve from the unified knowledge corpus.",
      );
    }

    if (mentionsKnowledge && (fuzzyLookup || context.hasKnowledgeRawHint || !context.hasKnowledgeHits)) {
      return this.decision(
        "knowledge",
        "knowledge_query_requires_unified_lookup",
        false,
        false,
        true,
        ["knowledge", "recent_tail"],
        "The query targets long-term knowledge, so use the unified knowledge corpus and preserve provenance in the returned hits.",
      );
    }

    if (mentionsKnowledge) {
      return this.decision("knowledge", "knowledge_layer_route_hit", false, false, true, ["knowledge", "summary_tree"], "The query explicitly asks for the knowledge layer, so route to the unified knowledge corpus.");
    }

    if (context.hasDurableHits && /(remember|constraint|decision|config|rule|长期|约束|决策|配置)/i.test(normalized)) {
      return this.decision("durable_memory", "fallback_durable_memory_match", false, false, true, ["durable_memory", "recent_tail"], "Durable memory contains matching stable facts, so use it before the volatile recent tail.", context.matchedProjectId, context.matchedProjectTitle);
    }

    return this.decision("recent_tail", "default_recent_tail", false, false, true, ["recent_tail"], "No higher-priority structured route matched, so answer from the recent tail.");
  }

  private decision(
    route: RetrievalRoute,
    reason: string,
    requiresEmbeddings: boolean,
    requiresSourceRecall: boolean,
    canAnswerDirectly: boolean,
    routePlan: RetrievalRoute[],
    explanation: string,
    matchedProjectId?: string,
    matchedProjectTitle?: string,
  ): RetrievalDecision {
    return {
      route,
      reason,
      requiresEmbeddings,
      requiresSourceRecall,
      canAnswerDirectly,
      routePlan,
      explanation,
      matchedProjectId,
      matchedProjectTitle,
      layerScores: this.currentLayerScores,
    };
  }

  private scoreLayers(query: string, context: RouteContext): RetrievalLayerScore[] {
    const scores = new Map<RetrievalRoute, { score: number; reasons: string[] }>();
    const add = (route: RetrievalRoute, score: number, reason: string) => {
      const current = scores.get(route) ?? { score: 0, reasons: [] };
      current.score += score;
      current.reasons.push(reason);
      scores.set(route, current);
    };

    if (!query) {
      add("recent_tail", 5, "empty_query");
      return this.sortedScores(scores);
    }

    const needsFacts = FACT_RECALL_RE.test(query);
    const asksCurrentFact = CURRENT_FACT_RE.test(query);
    const asksProjectState = PROJECT_STATE_RE.test(query);
    const referencesCurrentWork = context.referencesCurrentWork ?? CURRENT_WORK_RE.test(query);
    const asksHistory = HISTORY_RE.test(query);
    const asksDurable = DURABLE_RE.test(query);
    const mentionsKnowledge = KNOWLEDGE_BASE_RE.test(query);
    const asksRawKnowledge = RAW_KNOWLEDGE_RE.test(query);
    const explicitProjectState = this.isExplicitProjectStateQuery(query);

    if (needsFacts) add("summary_tree", 8, "fact_or_exact_recall_terms");
    if (needsFacts && asksCurrentFact) add("durable_memory", 6, "current_fact_terms");
    if (asksHistory) add("summary_tree", 7, "historical_recall_terms");
    if (context.hasCompactedHistory) add("summary_tree", 2, "compacted_history_available");

    if (asksProjectState && (referencesCurrentWork || explicitProjectState)) add("project_registry", 7, "project_state_terms");
    if (referencesCurrentWork) add("project_registry", 4, "references_current_work");
    if (context.hasProjectRegistry) add("project_registry", 2, "project_registry_available");
    if (context.matchedProjectId) add("project_registry", 3, "matched_project");

    if (asksDurable) add("durable_memory", 7, "durable_terms");
    if (context.hasDurableHits) add("durable_memory", 4, "durable_hits_available");
    if (context.matchedProjectId && context.hasDurableHits) add("durable_memory", 2, "matched_project_durable_hits");

    if (mentionsKnowledge) add("knowledge", 8, "knowledge_terms");
    if (asksRawKnowledge) add("knowledge", 3, "raw_knowledge_terms");
    if (context.hasKnowledgeHits) add("knowledge", 4, "knowledge_hits_available");
    if (context.hasKnowledgeRawHint) add("knowledge", 3, "knowledge_raw_hint");

    add("recent_tail", 1, "default_available");
    if (!needsFacts && !asksHistory && !mentionsKnowledge && !asksDurable && !asksProjectState) {
      add("recent_tail", 3, "no_structured_signal");
    }

    return this.sortedScores(scores);
  }

  private sortedScores(scores: Map<RetrievalRoute, { score: number; reasons: string[] }>): RetrievalLayerScore[] {
    return [...scores.entries()]
      .map(([route, item]) => ({
        route,
        score: item.score,
        reasons: [...new Set(item.reasons)],
      }))
      .sort((left, right) => right.score - left.score || left.route.localeCompare(right.route));
  }

  private isExplicitProjectStateQuery(query: string): boolean {
    return /(project|repo|repository|task|work|branch|build|test|plugin|implementation|release|status of project|项目|仓库|任务|构建|测试|插件|分支|发布)/i.test(query);
  }
}
