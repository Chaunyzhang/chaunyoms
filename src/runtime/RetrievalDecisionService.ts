import { LLMPlanner } from "../planner/LLMPlanner";
import { PlanValidator } from "../planner/PlanValidator";
import { RetrievalRuntime } from "../retrieval/RetrievalRuntime";
import { MemoryRetrievalRouter } from "../routing/MemoryRetrievalRouter";
import { RecallQueryAnalyzer } from "../resolvers/RecallQueryAnalyzer";
import { LifecycleContext } from "../host/OpenClawPayloadAdapter";
import {
  MemoryItemEntry,
  ProjectRecord,
  RetrievalDecision,
  SummaryEntry,
  SummaryRepository,
} from "../types";
import { ChaunyomsSessionRuntime } from "./ChaunyomsSessionRuntime";

export interface RetrievalDecisionServiceDeps {
  searchMemoryItemHits: (
    entries: MemoryItemEntry[],
    query: string,
    projectId?: string,
    limit?: number,
  ) => MemoryItemEntry[];
}

export class RetrievalDecisionService {
  private readonly retrievalRouter = new MemoryRetrievalRouter();
  private readonly llmPlanner = new LLMPlanner(() => this.runtime.getLlmCaller());
  private readonly planValidator = new PlanValidator();
  private readonly retrievalRuntime = new RetrievalRuntime();
  private readonly recallQueryAnalyzer = new RecallQueryAnalyzer();

  constructor(
    private readonly runtime: ChaunyomsSessionRuntime,
    private readonly deps: RetrievalDecisionServiceDeps,
  ) {}

  async resolve(
    query: string,
    context: LifecycleContext,
  ): Promise<{ decision: RetrievalDecision }> {
    const { rawStore, summaryStore, projectStore } = await this.runtime.getSessionStores(context);
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const projects = projectStore.getAll().filter((project) => project.status !== "archived");
    const matchedProject = this.matchProject(query, projects);
    const scopedMemoryItemHits = this.shouldProbeMemoryItems(query)
      ? this.deps.searchMemoryItemHits(
          runtimeStore.listMemoryItems({ agentId: context.config.agentId }),
          query,
          matchedProject?.id,
          3,
        )
      : [];
    const hasKnowledgeHits = false;
    const routeContext = {
      hasKnowledgeHits,
      hasKnowledgeRawHint: false,
      hasCompactedHistory: summaryStore.getAllSummaries().length > 0,
      hasProjectRegistry: projects.length > 0,
      hasMemoryItemHits: scopedMemoryItemHits.length > 0,
      recentAssistantUncertainty: this.hasRecentAssistantUncertainty(rawStore),
      queryComplexity: this.classifyQueryComplexity(query),
      referencesCurrentWork: this.referencesCurrentWork(query),
      matchedProjectId: matchedProject?.id,
      matchedProjectTitle: matchedProject?.title,
    };
    const deterministicDecision = this.retrievalRouter.decide(query, routeContext);
    const plannerResult = await this.llmPlanner.plan({
      query,
      deterministicDecision,
      signals: {
        retrievalStrength: context.config.retrievalStrength,
        llmPlannerMode: context.config.llmPlannerMode,
        hasLlmCaller: Boolean(this.runtime.getLlmCaller()),
        hasCompactedHistory: routeContext.hasCompactedHistory,
        hasProjectRegistry: routeContext.hasProjectRegistry,
        hasMemoryItemHits: routeContext.hasMemoryItemHits,
        hasKnowledgeHits: routeContext.hasKnowledgeHits,
        hasKnowledgeRawHint: routeContext.hasKnowledgeRawHint,
        recentAssistantUncertainty: routeContext.recentAssistantUncertainty,
        queryComplexity: routeContext.queryComplexity,
        referencesCurrentWork: routeContext.referencesCurrentWork,
        matchedProjectId: routeContext.matchedProjectId,
        matchedProjectTitle: routeContext.matchedProjectTitle,
        autoRecallEnabled: context.config.autoRecallEnabled,
        emergencyBrake: context.config.emergencyBrake,
        memoryItemEnabled: context.config.memoryItemEnabled,
        totalBudget: context.totalBudget,
        llmPlannerModel: context.config.llmPlannerModel,
        heavyRetrievalPolicy: context.config.heavyRetrievalPolicy,
        ragPlannerPolicy: context.config.ragPlannerPolicy,
        graphPlannerPolicy: context.config.graphPlannerPolicy,
        rerankPlannerPolicy: context.config.rerankPlannerPolicy,
        graphEnabled: context.config.graphEnabled,
        ragEnabled: context.config.ragEnabled,
        rerankEnabled: context.config.rerankEnabled,
        graphProvider: context.config.graphProvider,
        ragProvider: context.config.ragProvider,
        rerankProvider: context.config.rerankProvider,
        candidateRerankThreshold: context.config.candidateRerankThreshold,
        laneCandidateRerankThreshold: context.config.laneCandidateRerankThreshold,
        candidateAmbiguityMargin: context.config.candidateAmbiguityMargin,
        strictModeRequiresRerankOnConflict: context.config.strictModeRequiresRerankOnConflict,
        estimatedCandidateCount: scopedMemoryItemHits.length + (routeContext.hasCompactedHistory ? 1 : 0),
        candidateOverload: scopedMemoryItemHits.length >= context.config.laneCandidateRerankThreshold,
        dagExpansionMode: context.config.dagExpansionMode,
        dagExpansionAgentProvider: context.config.dagExpansionAgentProvider,
      },
    });
    const validation = this.planValidator.validate(plannerResult.plan);
    const usePlanner =
      context.config.llmPlannerMode === "auto" &&
      plannerResult.plan.activation.mode === "llm_planner" &&
      validation.accepted;
    const decision = this.applyOpenClawRecallOverride(
      query,
      context,
      this.retrievalRuntime.decisionFromPlan({
        plan: plannerResult.plan,
        validation,
        deterministicDecision,
        usePlanner,
      }),
      routeContext.hasCompactedHistory || rawStore.getAll({ sessionId: context.sessionId }).length > 0,
    );
    return { decision };
  }

  buildRecallSearchQueries(query: string): string[] {
    const understanding = this.recallQueryAnalyzer.analyze(query);
    const variants = new Set<string>();
    const trimmed = query.trim();
    if (trimmed) {
      variants.add(trimmed);
    }
    const termLine = understanding.terms.slice(0, 6).join(" ").trim();
    if (termLine) {
      variants.add(termLine);
    }
    const hintLine = understanding.eventHints
      .filter((hint, index, array) => hint.length >= 3 && array.indexOf(hint) === index)
      .slice(0, 6)
      .join(" ")
      .trim();
    if (hintLine) {
      variants.add(hintLine);
    }
    return [...variants];
  }

  collectSummarySearchHits(
    summaryStore: SummaryRepository,
    queries: string[],
    sessionId?: string,
  ): SummaryEntry[] {
    const byId = new Map<string, SummaryEntry>();
    for (const query of queries) {
      for (const hit of summaryStore.search(query, { sessionId })) {
        if (!byId.has(hit.id)) {
          byId.set(hit.id, hit);
        }
      }
    }
    return [...byId.values()];
  }

  matchProject(query: string, projects: ProjectRecord[]): ProjectRecord | null {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return projects[0] ?? null;
    }

    let best: { project: ProjectRecord; score: number } | null = null;
    for (const project of projects) {
      const haystack = [
        project.title,
        project.canonicalKey,
        project.summary,
        project.activeFocus,
        ...project.tags,
        ...project.topicIds,
      ].join(" ").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) {
          score += term.length >= 6 ? 3 : 2;
        }
      }
      if (project.title && query.toLowerCase().includes(project.title.toLowerCase())) {
        score += 6;
      }
      if (score <= 0) {
        continue;
      }
      if (!best || score > best.score) {
        best = { project, score };
      }
    }
    return best?.project ?? null;
  }

  shouldPreferDagOnlyRecall(
    query: string,
    summaryStore: SummaryRepository,
    context: LifecycleContext,
  ): boolean {
    if (context.config.forceDagOnlyRecall) {
      return true;
    }
    if (context.config.openClawRuntimeProfile !== "lightweight") {
      return false;
    }
    if (summaryStore.getAllSummaries().length === 0) {
      return false;
    }
    return this.isLosslessStyleFactRecallQuery(query) || this.isDagOnlyKeywordRecallQuery(query);
  }

  private shouldProbeMemoryItems(query: string): boolean {
    return /(current|latest|now|currently|updated|correction|after correction|exact|parameter|constraint|decision|rule|setting|config|remember|must|当前|最新|修正后|参数|约束|决策|规则|配置|记住)/i.test(query);
  }

  private applyOpenClawRecallOverride(
    query: string,
    context: LifecycleContext,
    decision: RetrievalDecision,
    hasHistoricalStore: boolean,
  ): RetrievalDecision {
    if (context.config.openClawRuntimeProfile !== "lightweight") {
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
    const understanding = this.recallQueryAnalyzer.analyze(query);
    if (understanding.historyQa) {
      return true;
    }
    if (understanding.terms.length === 0 || understanding.terms.length > 8) {
      return false;
    }
    if (this.referencesCurrentWork(query)) {
      return false;
    }
    if (/(status|state|progress|next step|next action|todo|pending|blocker|decision|knowledge|doc|docs|architecture|project|repo|branch|build|test)/i.test(query)) {
      return false;
    }
    return understanding.answerType !== "unknown" || understanding.transcriptLike;
  }

  private classifyQueryComplexity(query: string): "low" | "medium" | "high" {
    const normalized = query.toLowerCase();
    const highSignals = [
      /how should/i,
      /tradeoff/i,
      /compare/i,
      /versus/i,
      /\bvs\b/i,
      /sequence/i,
      /migration/i,
      /dependency/i,
      /dependencies/i,
      /rollout/i,
      /取舍|方案|顺序|依赖|风险|怎么推进|怎么做/i,
    ];
    if (
      normalized.length > 120 ||
      highSignals.some((pattern) => pattern.test(query)) ||
      (query.match(/\?/g)?.length ?? 0) >= 2
    ) {
      return "high";
    }

    if (
      normalized.length > 60 ||
      /(next|status|state|blocker|pending|decision|plan|steps|progress|当前|状态|下一步)/i.test(
        query,
      )
    ) {
      return "medium";
    }

    return "low";
  }

  private referencesCurrentWork(query: string): boolean {
    return /(this project|current task|current work|our work|what we are doing|where we left off|这个项目|当前任务|当前工作|这件事|我们现在|当前主线)/i.test(
      query,
    );
  }

  private hasRecentAssistantUncertainty(
    rawStore: { getAll(args?: unknown): Array<{ role: string; content: string }> },
  ): boolean {
    return rawStore
      .getAll()
      .slice(-6)
      .some(
        (message) =>
          message.role === "assistant" &&
          /(not sure|unclear|need more context|need context|I may be missing|might need|不确定|不清楚|需要更多上下文|可能需要更多信息)/i.test(
            message.content,
          ),
      );
  }
}
