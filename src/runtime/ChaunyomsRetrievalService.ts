import { ContextPlanner, ContextPlannerResult } from "../engines/ContextPlanner";
import { DeterministicReranker, RerankAudit, RetrievalEnhancementRegistry } from "../retrieval/RetrievalEnhancementProviders";
import { BrainPackExporter, BrainPackSnapshotReason } from "../brainpack/BrainPackExporter";
import { BrainPackScheduler } from "../brainpack/BrainPackScheduler";
import { BenchmarkComparisonGuard } from "../evals/benchmark-comparison";
import { MemoryOperationCreator } from "../memory/MemoryOperation";
import { OpenClawNativeAbsorber } from "../native/OpenClawNativeAbsorber";
import { RetrievalVerifier, RetrievalVerificationResult } from "../retrieval/RetrievalVerifier";
import { RecallResolver } from "../resolvers/RecallResolver";
import { EvidenceAnswerResolution, EvidenceAnswerResolver } from "../resolvers/EvidenceAnswerResolver";
import { scoreIntentRoleMatch } from "../resolvers/RecallIntentRoles";
import { EnvironmentDoctor } from "../system/EnvironmentDoctor";
import {
  AnswerCandidate,
  ContextItem,
  EvidenceAtomEntry,
  FixedPrefixProvider,
  MemoryItemEntry,
  ProgressiveRetrievalStepRecord,
  ProjectRecord,
  RecallResult,
  RetrievalDecision,
  RetrievalStrength,
  SemanticCandidate,
  SourceTrace,
  SummaryEntry,
  SummaryRepository,
  DagTraversalStep,
} from "../types";
import {
  LifecycleContext,
  OpenClawPayloadAdapter,
} from "../host/OpenClawPayloadAdapter";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { ChaunyomsSessionRuntime } from "./ChaunyomsSessionRuntime";
import { EvidenceResolutionService } from "./EvidenceResolutionService";
import { RecallExecutionService } from "./RecallExecutionService";
import { RetrievalDecisionService } from "./RetrievalDecisionService";
import { RetrievalPresentationService } from "./RetrievalPresentationService";
import { RetrievalAuditService } from "./RetrievalAuditService";
import {
  AtomEvidenceHealth,
  EvidenceGateResult,
  PlannerAuditContext,
  RecallLayer,
  RecallPresentationOptions,
  RecallTextDiagnostics,
  RetrievalBudgetPlan,
  SemanticExpansionResult,
  ToolResponse,
} from "./RetrievalServiceContracts";
import {
  OmsExpandResult,
  OmsGrepHit,
  RetrievalUsageEventDraft,
  RuntimeEnhancementSearchResult,
  SQLiteRuntimeStore,
} from "../data/SQLiteRuntimeStore";
import { estimateTokens } from "../utils/tokenizer";

export interface RetrievalLayerDependencies {
  fixedPrefixProvider: FixedPrefixProvider;
}

export class ChaunyomsRetrievalService {
  private readonly contextPlanner = new ContextPlanner();
  private readonly recallResolver = new RecallResolver();
  private readonly retrievalDecisionService: RetrievalDecisionService;
  private readonly recallExecutionService: RecallExecutionService;
  private readonly evidenceResolutionService = new EvidenceResolutionService();
  private readonly retrievalAuditService: RetrievalAuditService;
  private readonly retrievalPresentationService: RetrievalPresentationService;
  private readonly retrievalVerifier = new RetrievalVerifier();
  private readonly evidenceAnswerResolver = new EvidenceAnswerResolver();
  private readonly deterministicReranker = new DeterministicReranker();
  private readonly fixedPrefixProvider: FixedPrefixProvider;

  constructor(
    private readonly runtime: ChaunyomsSessionRuntime,
    private readonly payloadAdapter: OpenClawPayloadAdapter,
    dependencies: RetrievalLayerDependencies,
  ) {
    this.retrievalDecisionService = new RetrievalDecisionService(this.runtime, {
      searchMemoryItemHits: this.searchMemoryItemHits.bind(this),
    });
    this.recallExecutionService = new RecallExecutionService(this.runtime, {
      matchProject: this.retrievalDecisionService.matchProject.bind(this.retrievalDecisionService),
      queryTerms: this.queryTerms.bind(this),
      scoreMemoryItemEntry: this.scoreMemoryItemEntry.bind(this),
      scoreSemanticHaystack: this.scoreSemanticHaystack.bind(this),
      scoreSummaryEntry: this.scoreSummaryEntry.bind(this),
      semanticTerms: this.semanticTerms.bind(this),
    });
    this.retrievalAuditService = new RetrievalAuditService(this.runtime);
    this.retrievalPresentationService = new RetrievalPresentationService({
      buildRetrievalEnhancementDiagnostics: this.buildRetrievalEnhancementDiagnostics.bind(this),
      compactDagTrace: (dagTrace) => this.evidenceResolutionService.compactDagTrace({ dagTrace }),
      compactSourceTrace: (sourceTrace) => this.evidenceResolutionService.compactSourceTrace({ sourceTrace }),
      describeConfigGuidanceWarnings: (config) => this.payloadAdapter.describeConfigGuidance(config).warnings,
      describeRetrievalRoute: this.describeRetrievalRoute.bind(this),
      explainAutoRecall: this.explainAutoRecall.bind(this),
      getRetrievalHitType: this.getRetrievalHitType.bind(this),
      isSourceTraceRequired: this.isSourceTraceRequired.bind(this),
      queryTerms: this.queryTerms.bind(this),
      shouldAutoRecall: this.shouldAutoRecall.bind(this),
    });
    this.fixedPrefixProvider = dependencies.fixedPrefixProvider;
  }

  async executeMemoryRoute(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const stores = await this.runtime.getSessionStores(context);
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const query = this.getQuery(args);
    const scope = this.getScopeArg(args);
    const scopedSessionId = scope === "session" ? context.sessionId : undefined;
    const { decision } = await this.retrievalDecisionService.resolve(query, context);
    const recallSearchQueries = this.retrievalDecisionService.buildRecallSearchQueries(query);
    const semanticExpansion = await this.recallExecutionService.collectSemanticExpansion({
      query,
      context,
      decision,
      runtimeStore,
      allowIndexing: false,
      memoryItems: runtimeStore.listMemoryItems({ agentId: context.config.agentId }),
      summaryHits: this.retrievalDecisionService.collectSummarySearchHits(stores.summaryStore, recallSearchQueries, scopedSessionId),
      projects: stores.projectStore.getAll().filter((project) => project.status !== "archived"),
      matchedProject: decision.matchedProjectId
        ? stores.projectStore.findById(decision.matchedProjectId)
        : null,
    });
    const configGuidance = this.payloadAdapter.describeConfigGuidance(context.config);
    const diagnostics = this.retrievalPresentationService.buildDiagnosticsEnvelope(
      query,
      context,
      decision,
      false,
      semanticExpansion,
      configGuidance.warnings,
    );
    if (decision.route === "knowledge") {
      diagnostics.route = "recent_tail";
      diagnostics.originalRoute = "knowledge";
      diagnostics.explanation = "Knowledge/Markdown assets are export-only in authoritative ChaunyOMS mode; retrieval falls back to Source/BaseSummary/MemoryItem layers.";
      diagnostics.fallbackTrace = [
        {
          from: "knowledge",
          to: "recent_tail",
          reason: "markdown_assets_not_hot_path",
        },
      ];
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(diagnostics, null, 2),
        },
      ],
      details: diagnostics,
    };
  }

  async executeMemoryRetrieve(args: unknown): Promise<ToolResponse> {
    const resolvedContext = this.resolveContext(args);
    const retrievalStrength = this.resolveRetrievalStrength(args, resolvedContext.config.retrievalStrength);
    const context: LifecycleContext = {
      ...resolvedContext,
      config: {
        ...resolvedContext.config,
        retrievalStrength,
      },
    };
    const query = this.getQuery(args);
    if (!query) {
      return this.buildMissingQueryResponse("memory_retrieve");
    }
    if (
      !context.config.forceDagOnlyRecall &&
      (
        this.getBooleanArg(args, "losslessFastPath", false) ||
        this.getBooleanArg(args, "directGrep", false)
      )
    ) {
      const direct = await this.executeOmsGrep({
        ...(this.isRecord(args) ? args : {}),
        query,
      });
      return {
        ...direct,
        details: {
          ...(this.isRecord(direct.details) ? direct.details : {}),
          ok: true,
          query,
          retrievalHitType: "raw_exact_search",
          recallStrategy: "lossless_direct_grep",
          losslessFastPath: true,
          autoRecall: false,
          autoRecallReason: "losslessFastPath/directGrep requested; bypassed planner/rerank/evidence-answer stack.",
        },
      };
    }

    const stores = await this.runtime.getSessionStores(context);
    const { rawStore, summaryStore, projectStore } = stores;
    const scope = this.getScopeArg(args);
    const scopedSessionId = scope === "session" ? context.sessionId : undefined;
    const { decision } = await this.retrievalDecisionService.resolve(query, context);
    const recallSearchQueries = this.retrievalDecisionService.buildRecallSearchQueries(query);
    if (this.isPlannerValidationBlocked(decision)) {
      await this.retrievalAuditService.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_planner_blocked", {
        validationBlocked: true,
      });
      return this.retrievalPresentationService.attachDiagnostics(
        this.retrievalPresentationService.buildPlannerValidationBlockedResponse(query, decision),
        query,
        context,
        decision,
        this.recallExecutionService.emptySemanticExpansion(null),
      );
    }
    const activeProjects = projectStore.getAll().filter((project) => project.status !== "archived");
    const matchedProject = this.retrievalDecisionService.matchProject(query, activeProjects);
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const shouldProbeMemoryItems = decision.route === "memory_item" ||
      ((decision.requiresSourceRecall || decision.route === "summary_tree") &&
        (!context.config.autoRecallEnabled || context.config.emergencyBrake));
    const memoryItemHits = shouldProbeMemoryItems
      ? this.searchMemoryItemHits(
        runtimeStore.listMemoryItems({
          agentId: context.config.agentId,
          includeRetrievalUsage: context.config.usageFeedbackEnabled,
        }),
        query,
        matchedProject?.id,
        3,
      )
      : [];
    const semanticExpansion = await this.recallExecutionService.collectSemanticExpansion({
      query,
      context,
      decision,
      runtimeStore,
      allowIndexing: true,
      memoryItems: runtimeStore.listMemoryItems({
        agentId: context.config.agentId,
        includeRetrievalUsage: context.config.usageFeedbackEnabled,
      }),
      summaryHits: this.retrievalDecisionService.collectSummarySearchHits(summaryStore, recallSearchQueries, scopedSessionId),
      projects: activeProjects,
      matchedProject,
    });
    if ((decision.requiresSourceRecall || decision.route === "summary_tree") && (!context.config.autoRecallEnabled || context.config.emergencyBrake)) {
      await this.retrievalAuditService.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_source_recall_disabled", {
        sourceRecallDisabled: true,
      });
      return this.retrievalPresentationService.attachDiagnostics(
        this.buildRecallDisabledResponse(query, memoryItemHits, context, decision),
        query,
        context,
        decision,
        semanticExpansion,
      );
    }

    if (decision.route === "project_registry") {
      const project = this.retrievalDecisionService.matchProject(query, projectStore.getAll());
      await this.retrievalAuditService.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_project_registry", {
        matchedProjectId: project?.id ?? decision.matchedProjectId ?? null,
      });
      return this.retrievalPresentationService.attachDiagnostics(
        this.buildProjectRegistryResult(project, decision, query),
        query,
        context,
        decision,
        semanticExpansion,
      );
    }

    if (
      decision.route === "memory_item" &&
      memoryItemHits.length > 0 &&
      !this.isHardSourceTraceRequired(context)
    ) {
      this.recordDirectMemoryItemUsage(runtimeStore, memoryItemHits, query, context, decision);
      await this.retrievalAuditService.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_memory_item", {
        memoryItemHitCount: memoryItemHits.length,
      });
      return this.retrievalPresentationService.attachDiagnostics({
        content: [{ type: "text", text: this.retrievalPresentationService.formatMemoryItemText(query, memoryItemHits) }],
        details: {
          ok: true,
          route: decision.route,
          routePlan: decision.routePlan,
          layerScores: decision.layerScores ?? [],
          explanation: decision.explanation,
          retrievalLabel: this.describeRetrievalRoute(decision),
          query,
          hitCount: memoryItemHits.length,
          memoryItemHitCount: memoryItemHits.length,
          topRecordType: "memory_item",
          retrievalHitType: "memory_item",
          autoRecall: false,
          autoRecallReason: null,
          matchedProjectId: decision.matchedProjectId ?? null,
          matchedProjectTitle: decision.matchedProjectTitle ?? null,
        },
      }, query, context, decision, semanticExpansion);
    }

    if (this.shouldAutoRecall(decision, context)) {
      if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
        await this.retrievalAuditService.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_source_recall_disabled", {
          sourceRecallDisabled: true,
        });
        return this.retrievalPresentationService.attachDiagnostics(
          this.buildRecallDisabledResponse(query, memoryItemHits, context, decision),
          query,
          context,
          decision,
          semanticExpansion,
        );
      }

      const timings: Record<string, number> = {};
      const startedAt = Date.now();
      const ftsStartedAt = Date.now();
      const rawFtsHints = this.recallExecutionService.shouldUseFtsRecallHints(args, context)
        ? await this.recallExecutionService.collectRawFtsHints(
          context,
          this.retrievalDecisionService.buildRecallSearchQueries(query),
          scopedSessionId,
          this.recallExecutionService.resolveRawFtsHintLimit(args),
        )
        : [];
      timings.ftsMs = Date.now() - ftsStartedAt;
      const retrievalBudget = this.recallExecutionService.resolveRetrievalBudgetPlan(args, context.totalBudget);
      const recallBudget = retrievalBudget.total;
      const rawFtsMessageIds = rawFtsHints.map((hit) => hit.message.id);
      const recallStartedAt = Date.now();
      const dagOnlyRecall = this.retrievalDecisionService.shouldPreferDagOnlyRecall(query, summaryStore, context);
      const result = await this.recallResolver.resolveAsync(query, summaryStore, rawStore, recallBudget, {
        sessionId: scopedSessionId,
        rawHintMessageIds: rawFtsMessageIds,
        rawCandidateMessageIds: rawFtsMessageIds,
        allowRawFirst: dagOnlyRecall ? false : decision.reason !== "keyword_query_with_compacted_history",
        allowWideFallback: dagOnlyRecall ? false : this.recallExecutionService.allowWideRawFallback(args, decision),
        includeSummaryItems: true,
        requireRawSource: this.isHardSourceTraceRequired(context),
        dagExpansion: {
          mode: decision.planner?.dagExpansion.mode ?? "deterministic",
          agentProvider: decision.planner?.dagExpansion.agentProvider ?? context.config.dagExpansionAgentProvider,
          fallbackMode: decision.planner?.dagExpansion.fallbackMode ?? "deterministic",
          model: context.config.dagExpansionAgentModel,
          timeoutMs: context.config.dagExpansionAgentTimeoutMs,
          llmCaller: this.runtime.getLlmCaller(),
        },
      });
      timings.resolveMs = Date.now() - recallStartedAt;
      const atomStartedAt = Date.now();
      const atomResult = this.evidenceResolutionService.withPersistentEvidenceAtomHits({
        result,
        atoms: this.evidenceResolutionService.queryNeedsRawSource(query)
          ? []
          : stores.evidenceAtomStore.search(query, {
              sessionId: scopedSessionId,
              limit: 8,
            }),
        recallBudget,
      });
      timings.atomMs = Date.now() - atomStartedAt;
      const planStartedAt = Date.now();
      const enhancedResult = this.recallExecutionService.mergeEnhancementCandidatesIntoRecallResult(
        atomResult,
        semanticExpansion,
        recallBudget,
      );
      const planned = await this.recallExecutionService.planRecallItems(query, enhancedResult, retrievalBudget, context.config, decision);
      timings.planMs = Date.now() - planStartedAt;
      const evidenceGate = this.evidenceResolutionService.evaluateEvidenceGate(query, planned.items, enhancedResult);
      const retrievalVerification = this.retrievalVerifier.verify({
        retrievalStrength,
        items: planned.items,
        sourceTrace: enhancedResult.sourceTrace,
        answerCandidates: enhancedResult.answerCandidates,
        recallResult: enhancedResult,
      });
      const evidenceAnswer = await this.evidenceAnswerResolver.resolve({
        query,
        items: planned.items,
        sourceTrace: enhancedResult.sourceTrace,
        answerCandidates: enhancedResult.answerCandidates,
        retrievalStrength,
        config: {
          enabled: context.config.evidenceAnswerResolverEnabled,
          provider: context.config.evidenceAnswerResolverProvider,
          model: context.config.evidenceAnswerResolverModel,
          timeoutMs: context.config.evidenceAnswerResolverTimeoutMs,
          fallbackToDeterministic: context.config.evidenceAnswerResolverFallbackToDeterministic,
        },
        llmCaller: this.runtime.getLlmCaller(),
      });
      const persistentEvidenceAtomHitCount = atomResult.items.filter((item) =>
        item.metadata?.persistentEvidenceAtom === true,
      ).length;
      const transientEvidenceAtomHitCount = atomResult.items.filter((item) =>
        (item.metadata?.evidenceAtom === true || typeof item.metadata?.atomId === "string") &&
        item.metadata?.persistentEvidenceAtom !== true,
      ).length;
      const progressiveRetrievalSteps = this.retrievalAuditService.buildProgressiveRetrievalSteps({
        query,
        decision,
        planned,
        recallResult: enhancedResult,
        retrievalVerification,
        evidenceGate,
        rerankAudit: planned.rerankAudit,
        timings,
      });
      await this.runtime.recordRetrievalPlan(context, "memory_retrieve", planned.plan, recallBudget, {
        query,
        route: decision.route,
        retrievalStrength,
        usageFeedbackEnabled: context.config.usageFeedbackEnabled,
        answerUsed: evidenceAnswer.status === "answered",
        verifiedAnswerUsed: evidenceAnswer.status === "answered" && evidenceAnswer.sourceVerified,
        planner: decision.planner ?? null,
        plannerRunId: decision.planner?.runId ?? null,
        plannerIntent: decision.planner?.intent.primary ?? null,
        selectedPlan: decision.planner?.selectedPlan ?? "deterministic",
        sourceTraceRequired: this.isSourceTraceRequired(decision, context),
        retrievalVerification,
        evidenceAnswer,
        evidenceGate,
        progressiveRetrievalSteps,
        rerankAudit: planned.rerankAudit,
      });
      const presentation = this.retrievalPresentationService.resolveRecallPresentationOptions(
        args,
        context.config.retrievalStrength,
        this.getOptionalNumberArg.bind(this),
        this.getBooleanArg.bind(this),
        this.isRecord.bind(this),
      );
      timings.totalMs = Date.now() - startedAt;
      if (this.isRetrievalVerifierBlocked(retrievalVerification)) {
        return this.retrievalPresentationService.attachDiagnostics(
          this.retrievalPresentationService.buildRetrievalVerifierBlockedResponse({
            query,
            decision,
            recallResult: enhancedResult,
            retrievalVerification,
            evidenceGate,
            diagnostics: {
              retrievalBudget,
              persistentEvidenceAtomHitCount,
              transientEvidenceAtomHitCount,
            },
            progressiveRetrievalSteps,
          }),
          query,
          context,
          decision,
          semanticExpansion,
        );
      }
      return this.retrievalPresentationService.attachDiagnostics({
        content: [{ type: "text", text: this.retrievalPresentationService.formatRecallText({
          query,
          items: planned.items,
          sourceTrace: enhancedResult.sourceTrace,
          answerCandidates: enhancedResult.answerCandidates,
          presentation,
          evidenceGate,
          diagnostics: {
            retrievalBudget,
            persistentEvidenceAtomHitCount,
            transientEvidenceAtomHitCount,
            retrievalVerification,
            evidenceAnswer,
          },
        }) }],
        details: {
          ok: true,
          route: decision.route,
          retrievalLabel: this.describeRetrievalRoute(decision),
          query,
          consumedTokens: planned.consumedTokens,
          hitCount: planned.items.length,
          retrievalHitType: enhancedResult.strategy === "raw_first" ? "raw_history_recall" : "summary_tree_recall",
          recallStrategy: enhancedResult.strategy ?? "summary_navigation",
          rawCandidateCount: enhancedResult.rawCandidateCount ?? 0,
          persistentEvidenceAtomHitCount,
          transientEvidenceAtomHitCount,
          evidenceGate,
          retrievalVerification,
          evidenceAnswer,
          dagExpansion: enhancedResult.dagExpansion ?? null,
          progressiveRetrievalSteps,
          rerankAudit: planned.rerankAudit,
          rawFtsHintCount: rawFtsHints.length,
          autoRecall: true,
          autoRecallReason: this.explainAutoRecall(decision, context),
          routePlan: decision.routePlan,
          layerScores: decision.layerScores ?? [],
          explanation: decision.explanation,
          timings,
          recallBudget,
          retrievalBudget,
          rawFtsHintLimit: this.recallExecutionService.resolveRawFtsHintLimit(args),
          scope,
          sessionId: scopedSessionId ?? null,
          dagTrace: presentation.includeFullTrace ? enhancedResult.dagTrace : this.evidenceResolutionService.compactDagTrace({ dagTrace: enhancedResult.dagTrace }),
          sourceTrace: presentation.includeFullTrace ? enhancedResult.sourceTrace : this.evidenceResolutionService.compactSourceTrace({ sourceTrace: enhancedResult.sourceTrace }),
          answerCandidates: this.retrievalPresentationService.compactAnswerCandidates(enhancedResult.answerCandidates ?? [], presentation),
          ragSearch: semanticExpansion.ragSearch ?? null,
          graphSearch: semanticExpansion.graphSearch ?? null,
          plannerRunId: planned.plan.runId,
          plannerRejectedCount: planned.plan.rejected.length,
        },
      }, query, context, decision, semanticExpansion);
    }

    if (decision.route === "knowledge") {
      await this.retrievalAuditService.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_knowledge_export_only", {
        markdownHotPath: false,
      });
      return this.retrievalPresentationService.attachDiagnostics({
        content: [{
          type: "text",
          text: `Knowledge/Markdown assets are export-only in authoritative ChaunyOMS mode; query "${query}" was not answered from Markdown. Promote/import source-backed MemoryItems first.`,
        }],
        details: {
          ok: true,
          route: decision.route,
          retrievalLabel: this.describeRetrievalRoute(decision),
          query,
          hitCount: 0,
          knowledgeHitCount: 0,
          topRecordType: null,
          retrievalHitType: "knowledge_export_only",
          autoRecall: false,
          autoRecallReason: null,
          routePlan: decision.routePlan,
          layerScores: decision.layerScores ?? [],
          explanation: decision.explanation,
          fallbackTrace: [{
            from: decision.route,
            to: "none",
            reason: "markdown_assets_not_hot_path",
          }],
        },
      }, query, context, decision, semanticExpansion);
    }

    const recentTail = rawStore.getRecentTail(3, { sessionId: context.sessionId });
    await this.retrievalAuditService.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_recent_tail", {
      recentTailCount: recentTail.length,
    });
    return this.retrievalPresentationService.attachDiagnostics({
      content: [{ type: "text", text: this.retrievalPresentationService.formatRecentTailText(query, recentTail) }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        hitCount: recentTail.length,
        retrievalHitType: "recent_tail",
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        fallbackTrace: [{
          from: decision.route,
          to: "recent_tail",
          reason: "standard_path_no_authoritative_hit",
        }],
      },
    }, query, context, decision, semanticExpansion);
  }

  async executeOpenClawMemorySearch(args: unknown): Promise<ToolResponse> {
    const normalizedArgs = this.normalizeOpenClawSearchArgs(args);
    const result = await this.executeMemoryRetrieve(normalizedArgs);
    return this.withOpenClawCompatibility(result, "memory_search", "memory_retrieve", {
      markdownHotPath: false,
      authoritativeSource: "ChaunyOMS SQLite MemoryItem/BaseSummary/Source",
    });
  }

  async executeOpenClawMemoryGet(args: unknown): Promise<ToolResponse> {
    const record = this.isRecord(args) ? { ...args } : {};
    const ref =
      this.getStringArg(record, "ref") ||
      this.getStringArg(record, "id") ||
      this.getStringArg(record, "memory_id") ||
      this.getStringArg(record, "path");
    if (!ref) {
      return this.withOpenClawCompatibility(
        this.buildMissingIdResponse("memory_get"),
        "memory_get",
        "oms_expand",
        { markdownHotPath: false },
      );
    }

    const normalizedArgs = {
      ...record,
      id: this.normalizeOpenClawMemoryRef(ref),
      kind: this.resolveOpenClawMemoryRefKind(record, ref),
    };
    const result = await this.executeOmsExpand(normalizedArgs);
    return this.withOpenClawCompatibility(result, "memory_get", "oms_expand", {
      markdownHotPath: false,
      authoritativeSource: "ChaunyOMS source_edges",
      ref,
    });
  }

  async executeOpenClawMemoryStatus(args: unknown): Promise<ToolResponse> {
    const result = await this.executeOmsStatus(args);
    return this.withOpenClawCompatibility(result, "memory_status", "oms_status", {
      markdownHotPath: false,
    });
  }

  async executeOpenClawMemoryIndex(args: unknown): Promise<ToolResponse> {
    const result = await this.executeOmsAssetReindex(args);
    return this.withOpenClawCompatibility(result, "memory_index", "oms_asset_reindex", {
      markdownHotPath: false,
      sourceRegenerated: false,
      note: "Rebuilds SQLite asset indexes only; Source remains the canonical raw-message ledger.",
    });
  }

  async executeOpenClawMemoryPromote(args: unknown): Promise<ToolResponse> {
    if (this.getBooleanArg(args, "apply", false) && this.getStringArg(args, "id")) {
      const result = await this.executeOmsKnowledgeReview({
        ...(this.isRecord(args) ? args : {}),
        action: "approve",
      });
      return this.withOpenClawCompatibility(result, "memory_promote", "oms_knowledge_review", {
        markdownHotPath: false,
        promotionGate: "manual_approval",
      });
    }

    const result = await this.executeOmsKnowledgeCandidates(args);
    return this.withOpenClawCompatibility(result, "memory_promote", "oms_knowledge_candidates", {
      markdownHotPath: false,
      applyRequires: "id + apply=true",
    });
  }

  async executeOpenClawMemoryPromoteExplain(args: unknown): Promise<ToolResponse> {
    const result = await this.executeOmsKnowledgeCandidates(args);
    return this.withOpenClawCompatibility(result, "memory_promote_explain", "oms_knowledge_candidates", {
      markdownHotPath: false,
      explains: ["score", "recommendation", "status", "reviewState"],
    });
  }

  async executeOmsGrep(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    if (context.config.forceDagOnlyRecall) {
      return {
        content: [{
          type: "text",
          text: "oms_grep is disabled in this environment because forceDagOnlyRecall=true. Use memory_retrieve so OMS stays on the summary/DAG navigation path.",
        }],
        details: {
          ok: false,
          reason: "forceDagOnlyRecall_enabled",
          query: this.getQuery(args),
        },
      };
    }
    const query = this.getQuery(args);
    if (!query) {
      return this.buildMissingQueryResponse("oms_grep");
    }
    const assumeRuntimeFresh = this.getBooleanArg(args, "assumeRuntimeFresh", false) ||
      this.getBooleanArg(args, "skipRuntimeMirror", false);
    const runtimeStore = await this.runtime.getRuntimeStore(context, {
      ensure: !assumeRuntimeFresh,
      mirror: !assumeRuntimeFresh,
    });
    const limit = this.getNumberArg(args, "limit", 10);
    const contextTurns = this.getNumberArg(args, "contextTurns", 1);
    const scope = this.getScopeArg(args);
    const fastOnly = this.getBooleanArg(args, "fastOnly", false) ||
      this.getBooleanArg(args, "losslessFastPath", false) ||
      this.getBooleanArg(args, "directGrep", false);
    const includeFreshTail = this.getBooleanArg(args, "includeFreshTail", false) ||
      this.getBooleanArg(args, "losslessFastPath", false);
    const recentTailTurns = Math.max(0, Math.min(16, Math.floor(this.getNumberArg(args, "recentTailTurns", 8))));
    const maxCharsPerHit = Math.max(240, Math.min(20000, Math.floor(this.getNumberArg(args, "maxCharsPerHit", fastOnly ? 1600 : 4000))));
    const maxCharsPerFreshTail = Math.max(240, Math.min(20000, Math.floor(this.getNumberArg(args, "maxCharsPerFreshTail", fastOnly ? 1200 : 4000))));
    const startedAt = Date.now();
    const scopedSessionId = scope === "session" ? context.sessionId : undefined;
    const freshTail = includeFreshTail
      ? runtimeStore.getAssemblyRecentTailByTokens(9000, recentTailTurns, scopedSessionId)
      : [];
    const hits = runtimeStore.grepMessages(query, {
      sessionId: scopedSessionId,
      limit,
      contextTurns,
      fastOnly,
    });
    const grepMs = Date.now() - startedAt;
    const freshTailText = freshTail.length > 0
      ? ["## Fresh tail", ...freshTail.map((message) => `${message.role}: ${this.truncateText(message.content, maxCharsPerFreshTail)}`)].join("\n")
      : "";
    const hitText = hits.length > 0
      ? ["## Grep hits", hits.map((hit, index) => this.formatGrepHit(index + 1, hit, maxCharsPerHit)).join("\n\n---\n\n")].join("\n")
      : `No raw message hit found for query: ${query}`;
    return {
      content: [{
        type: "text",
        text: [freshTailText, hitText].filter(Boolean).join("\n\n"),
      }],
      details: {
        ok: true,
        query,
        scope,
        runtimeStore: runtimeStore.isEnabled() ? "sqlite" : "disabled",
        dbPath: runtimeStore.getPath(),
        assumeRuntimeFresh,
        hitCount: hits.length,
        freshTailCount: freshTail.length,
        includeFreshTail,
        fastOnly,
        maxCharsPerHit,
        maxCharsPerFreshTail,
        grepMs,
        retrievalHitType: "raw_exact_search",
      },
    };
  }

  async executeOmsExpand(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const id = this.getStringArg(args, "id");
    const kind = this.getStringArg(args, "kind") || "auto";
    if (!id) {
      return this.buildMissingIdResponse("oms_expand");
    }
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const result = runtimeStore.expand(kind, id);
    return {
      content: [{
        type: "text",
        text: this.formatExpandResult(kind, id, result, {
          full: this.getBooleanArg(args, "full", false),
          maxMessages: Math.max(1, Math.min(40, Math.floor(this.getOptionalNumberArg(args, "maxMessages") ?? 8))),
          maxCharsPerMessage: Math.max(300, Math.min(4000, Math.floor(this.getOptionalNumberArg(args, "maxCharsPerMessage") ?? 1200))),
        }),
      }],
      details: {
        ok: true,
        id,
        kind,
        runtimeStore: runtimeStore.isEnabled() ? "sqlite" : "disabled",
        dbPath: runtimeStore.getPath(),
        targetFound: Boolean(result.target),
        messageCount: result.messages.length,
        summaryCount: result.summaries.length,
        edgeCount: result.edges.length,
        sourceTrace: result.edges.slice(0, this.getBooleanArg(args, "full", false) ? result.edges.length : 20),
      },
    };
  }

  async executeOmsTrace(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const id = this.getStringArg(args, "id");
    const kind = this.getStringArg(args, "kind") || "auto";
    if (!id) {
      return this.buildMissingIdResponse("oms_trace");
    }
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const edges = runtimeStore.trace(kind, id);
    return {
      content: [{
        type: "text",
        text: edges.length > 0
          ? edges.map((edge) => `${edge.sourceKind}:${edge.sourceId} --${edge.relation}--> ${edge.targetKind}:${edge.targetId}`).join("\n")
          : `No source trace edges found for ${kind}:${id}`,
      }],
      details: {
        ok: true,
        id,
        kind,
        runtimeStore: runtimeStore.isEnabled() ? "sqlite" : "disabled",
        dbPath: runtimeStore.getPath(),
        edgeCount: edges.length,
        sourceTrace: edges,
      },
    };
  }

  async executeOmsReplay(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const startTurn = this.getOptionalNumberArg(args, "startTurn");
    const endTurn = this.getOptionalNumberArg(args, "endTurn");
    const limit = this.getNumberArg(args, "limit", 200);
    const scope = this.getScopeArg(args);
    const messages = runtimeStore.replay({
      sessionId: scope === "session" ? context.sessionId : undefined,
      startTurn,
      endTurn,
      limit,
    });
    return {
      content: [{
        type: "text",
        text: messages.length > 0
          ? messages.map((message) => `[turn ${message.turnNumber}] ${message.role}: ${message.content}`).join("\n\n")
          : "No raw messages found for this replay range.",
      }],
      details: {
        ok: true,
        scope,
        runtimeStore: runtimeStore.isEnabled() ? "sqlite" : "disabled",
        dbPath: runtimeStore.getPath(),
        sessionId: scope === "session" ? context.sessionId : null,
        startTurn: startTurn ?? null,
        endTurn: endTurn ?? null,
        messageCount: messages.length,
      },
    };
  }

  async executeOmsStatus(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const status = await this.runtime.getStatus(context, { scope: this.getScopeArg(args) });
    const openClawCompatibility = this.payloadAdapter.inspectOpenClawCompatibility();
    return this.jsonToolResponse(
      "oms_status",
      { ...status, openClawCompatibility },
      status.ok && openClawCompatibility.ok,
    );
  }

  async executeOmsBrainPackExport(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const reason = this.resolveBrainPackReason(this.getStringArg(args, "reason"));
    const outputDir = this.getStringArg(args, "outputDir") || undefined;
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const result = await new BrainPackExporter(runtimeStore, context.config).export({ reason, outputDir });
    return this.jsonToolResponse(
      "oms_brainpack_export",
      result,
      result.ok && result.redactionReport.okForGit,
    );
  }

  async executeOmsBrainPackStatus(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const scheduler = new BrainPackScheduler();
    const currentTurn = this.getNumberArg(args, "currentTurn", 0);
    const lastSnapshotTurn = this.getNumberArg(args, "lastSnapshotTurn", 0);
    const lastSnapshotAt = this.getStringArg(args, "lastSnapshotAt") || undefined;
    const decision = scheduler.shouldExport(context.config, {
      manual: this.getBooleanArg(args, "manual", false),
      currentTurn,
      lastSnapshotTurn,
      lastSnapshotAt,
    });
    return this.jsonToolResponse("oms_brainpack_status", {
      ok: true,
      enabled: context.config.brainPackEnabled,
      mode: context.config.brainPackMode,
      outputDir: context.config.brainPackOutputDir,
      gitEnabled: context.config.brainPackGitEnabled,
      redactionMode: context.config.brainPackRedactionMode,
      includeRawTranscript: context.config.brainPackIncludeRawTranscript,
      includeToolOutputs: context.config.brainPackIncludeToolOutputs,
      schedule: decision,
    }, true);
  }

  async executeOmsNativePolicyStatus(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const compatibility = this.payloadAdapter.inspectOpenClawCompatibility();
    return this.jsonToolResponse("oms_native_policy_status", {
      ok: compatibility.ok,
      mode: context.config.openClawNativeMode,
      featurePolicy: {
        defaultMode: context.config.openClawNativeMode,
        memoryCore: context.config.openClawNativeMemoryCoreMode ?? context.config.openClawNativeMode,
        activeMemory: context.config.openClawNativeActiveMemoryMode ?? context.config.openClawNativeMode,
        memoryWiki: context.config.openClawNativeMemoryWikiMode ?? context.config.openClawNativeMode,
        dreaming: context.config.openClawNativeDreamingMode ?? context.config.openClawNativeMode,
      },
      compatibility,
    }, compatibility.ok);
  }

  async executeOmsNativeAbsorb(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const content = this.getStringArg(args, "content") ||
      this.getStringArg(args, "text") ||
      this.getStringArg(args, "output");
    const metadata = this.isRecord(args) && this.isRecord(args.metadata)
      ? args.metadata
      : {};
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const result = await new OpenClawNativeAbsorber(runtimeStore, context.config).absorb({
      feature: this.getStringArg(args, "feature") || undefined,
      pluginId: this.getStringArg(args, "pluginId") || undefined,
      sourceId: this.getStringArg(args, "sourceId") ||
        this.getStringArg(args, "nativeEventId") ||
        this.getStringArg(args, "eventId") ||
        undefined,
      content,
      createdBy: this.resolveOperationCreator(this.getStringArg(args, "createdBy")),
      confidence: this.getOptionalNumberArg(args, "confidence"),
      apply: this.getBooleanArg(args, "apply", false),
      metadata,
    });
    return this.jsonToolResponse("oms_native_absorb", result, result.ok);
  }

  async executeOmsBenchmarkReport(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const guard = new BenchmarkComparisonGuard();
    const scope = this.getStringArg(args, "scope") === "standard_public"
      ? "standard_public"
      : "development_sample";
    const systems = this.readStringArrayArg(args, "systems");
    const metrics = this.isRecord(args) && this.isRecord(args.metrics)
      ? args.metrics
      : {};
    const report = guard.buildReport({
      suite: this.getStringArg(args, "suite") || "unspecified",
      scope,
      systems: systems.length > 0 ? systems : ["chaunyoms"],
      metrics,
      generatedAt: this.getStringArg(args, "generatedAt") || undefined,
    });
    return this.jsonToolResponse("oms_benchmark_report", {
      ...report,
      publicComparableAllowed: guard.canClaimPublicComparison(report),
      enforcement: report.claimLevel === "public_comparable"
        ? "public_comparison_allowed"
        : "regression_only_do_not_publish_as_public_ranking",
      contextAgentId: context.config.agentId,
    }, true);
  }

  async executeOmsRecallFeedback(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    if (!context.config.usageFeedbackEnabled) {
      return this.jsonToolResponse("oms_recall_feedback", {
        ok: true,
        recorded: false,
        reason: "usage_feedback_disabled",
      }, true);
    }
    const targetId = this.getStringArg(args, "targetId") || this.getStringArg(args, "id");
    if (!targetId) {
      return this.buildMissingIdResponse("oms_recall_feedback");
    }
    const requestedEventType = this.getStringArg(args, "eventType") || this.getStringArg(args, "action") || "negative_feedback";
    const eventType = this.resolveUsageEventType(requestedEventType);
    if (!eventType) {
      return {
        content: [{ type: "text", text: "oms_recall_feedback eventType must be candidate_seen, context_selected, answer_used, verified_answer_used, rejected, or negative_feedback." }],
        details: { ok: false, tool: "oms_recall_feedback", reason: "invalid_event_type" },
      };
    }
    const targetKind = this.getStringArg(args, "targetKind") || this.getStringArg(args, "kind") || "memory_item";
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    runtimeStore.recordRetrievalUsageEvents([{
      eventType,
      targetKind,
      targetId,
      sessionId: context.sessionId,
      agentId: context.config.agentId,
      projectId: this.getStringArg(args, "projectId") || undefined,
      query: this.getStringArg(args, "query") || undefined,
      route: this.getStringArg(args, "route") || "manual_feedback",
      retrievalStrength: context.config.retrievalStrength,
      sourceVerified: this.getBooleanArg(args, "sourceVerified", false),
      answerUsed: eventType === "answer_used" || eventType === "verified_answer_used",
      metadata: {
        note: this.getStringArg(args, "note") || undefined,
        feedbackSource: "oms_recall_feedback",
      },
    }]);
    return this.jsonToolResponse("oms_recall_feedback", {
      ok: true,
      recorded: true,
      eventType,
      targetKind,
      targetId,
    }, true);
  }

  async executeOmsSetupGuide(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const status = await this.runtime.getStatus(context);
    const configGuidance = this.payloadAdapter.describeConfigGuidance(context.config);
    const openClawCompatibility = this.payloadAdapter.inspectOpenClawCompatibility();
    const recommendedConfig = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: false,
          },
        },
      },
      plugins: {
        slots: {
          memory: "oms",
          contextEngine: "oms",
        },
        entries: {
          oms: {
            enabled: true,
            config: {
              mode: "authoritative",
              configPreset: context.config.configPreset,
              enableTools: true,
              runtimeCaptureEnabled: true,
              memoryItemEnabled: true,
              autoRecallEnabled: context.config.configPreset !== "safe",
              retrievalStrength: context.config.retrievalStrength,
              llmPlannerMode: context.config.llmPlannerMode,
              plannerDebugEnabled: context.config.plannerDebugEnabled,
              knowledgePromotionEnabled: false,
              knowledgePromotionManualReviewEnabled: true,
              kbCandidateEnabled: true,
              kbWriteEnabled: false,
              kbPromotionMode: context.config.kbPromotionMode,
              kbPromotionStrictness: context.config.kbPromotionStrictness,
              kbExportEnabled: true,
              knowledgeIntakeMode: context.config.knowledgeIntakeMode,
              sqliteJournalMode: context.config.sqliteJournalMode,
              ragEnabled: false,
              ragProvider: "sqlite_vec",
              ragFallbackToBruteForce: true,
              graphEnabled: false,
              graphProvider: "sqlite_graph",
              rerankEnabled: false,
              rerankProvider: "deterministic",
              featureIsolationMode: "isolate_optional",
            },
          },
          "memory-core": { enabled: false },
          "active-memory": { enabled: false },
          "memory-wiki": { enabled: false },
        },
      },
    };
    const setup = {
      ok: status.ok,
      purpose: "Configure ChaunyOMS as a SQLite-first runtime with Markdown assets as reviewed human-readable output.",
      openClawCompatibility,
      runtime: {
        adapter: status.runtimeStore.adapter,
        sqliteEnabled: status.runtimeStore.enabled,
        nodeVersion: process.version,
        journalMode: status.runtimeStore.journalMode,
        dbPath: status.runtimeStore.dbPath,
      },
      paths: {
        dataDir: context.config.dataDir,
        workspaceDir: context.config.workspaceDir,
        knowledgeBaseDir: context.config.knowledgeBaseDir,
        memoryVaultDir: context.config.memoryVaultDir,
      },
      recommendedConfig,
      checklist: [
        "Run oms_doctor after install; it verifies config, SQLite availability, source edges, and asset governance.",
        "Bind both plugins.slots.memory and plugins.slots.contextEngine to oms before enabling authoritative mode.",
        "Disable OpenClaw memory-core, active-memory, and memory-wiki so no Markdown-first fact source coexists with ChaunyOMS; if a future Dream/Dreaming plugin is installed, leave it disabled or route it through OMS absorbed mode.",
        "Disable OpenClaw native agents.defaults.memorySearch.enabled in authoritative OMS mode; otherwise OpenClaw doctor can still probe the disabled memory-core facade.",
        "Keep sqliteJournalMode=delete unless the deployment needs concurrent reads/writes and supports WAL files reliably.",
        "Leave knowledgePromotionEnabled=false until raw recall/compaction are stable for the project.",
        "Enable knowledgePromotionManualReviewEnabled=true when promotion is enabled and the UI wants a review queue.",
        "Use oms_backup before restore/migration and oms_verify after large data operations.",
        "Use oms_wipe_session for privacy-driven session cleanup; use oms_wipe_agent only when you intend to remove the entire agent runtime state.",
      ],
      warnings: [
        ...configGuidance.warnings,
        ...openClawCompatibility.warnings,
        ...openClawCompatibility.errors,
        ...(status.runtimeStore.enabled ? [] : ["node:sqlite is unavailable; pin a compatible Node version before production use."]),
        ...(context.config.knowledgePromotionEnabled && !context.config.knowledgePromotionManualReviewEnabled
          ? ["Automatic knowledge promotion is enabled without manual review; this is faster but gives the user less control."]
          : []),
      ],
    };
    return this.jsonToolResponse("oms_setup_guide", setup, setup.ok);
  }

  async executeOmsVerify(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const report = await this.runtime.verify(context, { scope: this.getScopeArg(args) });
    return this.jsonToolResponse("oms_verify", report, report.ok);
  }

  async executeOmsDoctor(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const status = await this.runtime.getStatus(context);
    const verify = await this.runtime.verify(context);
    const configGuidance = this.payloadAdapter.describeConfigGuidance(context.config);
    const openClawCompatibility = this.payloadAdapter.inspectOpenClawCompatibility();
    const environment = EnvironmentDoctor.run({
      vectorExtensionPath: context.config.vectorExtensionPath,
      vectorExtensionEntryPoint: context.config.vectorExtensionEntryPoint,
    });
    const warnings = [
      ...environment.warnings,
      ...configGuidance.warnings,
      ...openClawCompatibility.warnings,
      ...verify.warnings,
      ...(context.config.emergencyBrake ? ["emergencyBrake is enabled: automatic compaction/promotion paths are intentionally conservative."] : []),
      ...(status.runtimeStore.enabled ? [] : ["SQLite runtime is disabled; source recall tools will fall back to no-op results."]),
      ...(status.runtimeStore.ftsStatus === "lazy_not_initialized"
        ? ["SQLite FTS is lazy and has not been initialized yet; this is expected until oms_grep/deep raw recall needs full-text anchors."]
        : []),
      ...(status.runtimeStore.experimentalAdapter ? ["SQLite runtime is using Node's experimental node:sqlite adapter; pin a compatible Node version for production deployments."] : []),
      ...(context.config.knowledgePromotionEnabled ? [] : ["knowledgePromotionEnabled is false; Markdown asset promotion is opt-in/disabled."]),
    ];
    const errors = [
      ...verify.errors,
      ...openClawCompatibility.errors,
      ...environment.checks
        .filter((check) => check.required && !check.ok)
        .map((check) => check.message),
    ];
    const doctor = {
      ok: errors.length === 0,
      engineId: "oms",
      activeRuntime: "sqlite-first runtime, markdown export-only assets",
      status,
      verify,
      environment,
      configGuidance,
      openClawCompatibility,
      warnings,
      errors,
      nextActions: errors.length > 0
        ? ["Run oms_verify for details, then restore from backup or repair source bindings before trusting recalled evidence."]
        : ["Runtime is healthy. Use oms_inspect_context/oms_why_recalled when you need explainability."],
    };
    return this.jsonToolResponse("oms_doctor", doctor, doctor.ok);
  }

  async executeOmsBackup(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const label = this.getStringArg(args, "label");
    const result = await this.runtime.backup(context, label);
    return this.jsonToolResponse("oms_backup", result, result.ok);
  }

  async executeOmsAgentExport(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const result = await this.runtime.exportAgentCapsule(context, {
      agentId: this.getStringArg(args, "agentId") || undefined,
      label: this.getStringArg(args, "label") || undefined,
    });
    return this.jsonToolResponse("oms_agent_export", result, Boolean(result.ok));
  }

  async executeOmsAgentVerify(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const capsulePath = this.getStringArg(args, "capsulePath");
    if (!capsulePath) {
      return {
        content: [{ type: "text", text: "oms_agent_verify requires capsulePath." }],
        details: { ok: false, tool: "oms_agent_verify", reason: "missing_capsulePath" },
      };
    }
    const result = await this.runtime.verifyAgentCapsule(context, capsulePath);
    return this.jsonToolResponse("oms_agent_verify", result, Boolean(result.ok));
  }

  async executeOmsAgentImport(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const capsulePath = this.getStringArg(args, "capsulePath");
    if (!capsulePath) {
      return {
        content: [{ type: "text", text: "oms_agent_import requires capsulePath." }],
        details: { ok: false, tool: "oms_agent_import", reason: "missing_capsulePath" },
      };
    }
    const apply = this.getBooleanArg(args, "apply", false);
    const result = await this.runtime.importAgentCapsule(context, capsulePath, apply);
    return this.jsonToolResponse("oms_agent_import", result, Boolean(result.ok));
  }

  async executeOmsRestore(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const backupDir = this.getStringArg(args, "backupDir");
    if (!backupDir) {
      return {
        content: [{ type: "text", text: "oms_restore requires backupDir." }],
        details: { ok: false, tool: "oms_restore", reason: "missing_backupDir" },
      };
    }
    const apply = this.getBooleanArg(args, "apply", false);
    const result = await this.runtime.restore(context, backupDir, apply);
    return this.jsonToolResponse("oms_restore", result, result.ok);
  }

  async executeOmsMigrateJsonToSqlite(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const result = await this.runtime.migrateJsonToSqlite(context);
    return this.jsonToolResponse("oms_migrate_json_to_sqlite", result, Boolean(result.ok));
  }

  async executeOmsVerifyMigration(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const result = await this.runtime.verifyMigration(context);
    return this.jsonToolResponse("oms_verify_migration", result, Boolean(result.ok));
  }

  async executeOmsExportJsonBackup(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const label = this.getStringArg(args, "label");
    const result = await this.runtime.exportJsonBackup(context, label);
    return this.jsonToolResponse("oms_export_json_backup", result, Boolean(result.ok));
  }

  async executeOmsCleanupLegacyJson(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const apply = this.getBooleanArg(args, "apply", false);
    const result = await this.runtime.cleanupLegacyJson(context, apply);
    return this.jsonToolResponse("oms_cleanup_legacy_json", result, Boolean(result.ok));
  }

  async executeOmsWipeSession(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const apply = this.getBooleanArg(args, "apply", false);
    const backupBeforeApply = this.getBooleanArg(args, "backupBeforeApply", true);
    const result = await this.runtime.wipeSession(context, {
      apply,
      backupBeforeApply,
    });
    return this.jsonToolResponse("oms_wipe_session", result, result.ok);
  }

  async executeOmsWipeAgent(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const apply = this.getBooleanArg(args, "apply", false);
    const backupBeforeApply = this.getBooleanArg(args, "backupBeforeApply", true);
    const result = await this.runtime.wipeAgent(context, {
      apply,
      backupBeforeApply,
      wipeKnowledgeBase: this.getBooleanArg(args, "wipeKnowledgeBase", false),
      wipeWorkspaceMemory: this.getBooleanArg(args, "wipeWorkspaceMemory", false),
      wipeBackups: this.getBooleanArg(args, "wipeBackups", false),
    });
    return this.jsonToolResponse("oms_wipe_agent", result, result.ok);
  }

  async executeOmsInspectContext(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const runId = this.getStringArg(args, "runId") || undefined;
    const inspection = runtimeStore.inspectContextRun(runId);
    const details = {
      ok: Boolean(inspection.run),
      runtimeStore: runtimeStore.isEnabled() ? "sqlite" : "disabled",
      dbPath: runtimeStore.getPath(),
      ...inspection,
    };
    return {
      content: [{ type: "text", text: this.formatContextInspection(details) }],
      details: { tool: "oms_inspect_context", ...details },
    };
  }

  async executeOmsWhyRecalled(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const report = runtimeStore.whyRecalled({
      targetId: this.getStringArg(args, "id") || this.getStringArg(args, "targetId") || undefined,
      query: this.getStringArg(args, "query") || undefined,
      runId: this.getStringArg(args, "runId") || undefined,
      limit: this.getNumberArg(args, "limit", 10),
    });
    const details = {
      ok: report.matches.length > 0,
      runtimeStore: runtimeStore.isEnabled() ? "sqlite" : "disabled",
      dbPath: runtimeStore.getPath(),
      ...report,
    };
    return {
      content: [{ type: "text", text: this.formatWhyRecalled(details) }],
      details: { tool: "oms_why_recalled", ...details },
    };
  }

  async executeOmsPlannerDebug(args: unknown): Promise<ToolResponse> {
    const resolvedContext = this.resolveContext(args);
    const retrievalStrength = this.resolveRetrievalStrength(args, resolvedContext.config.retrievalStrength);
    const context: LifecycleContext = {
      ...resolvedContext,
      config: {
        ...resolvedContext.config,
        retrievalStrength,
      },
    };
    const query = this.getQuery(args);
    const { decision } = await this.retrievalDecisionService.resolve(query, context);
    const planner = decision.planner ?? null;
    const details = {
      ok: Boolean(planner),
      query,
      route: decision.route,
      routePlan: decision.routePlan,
      layerScores: decision.layerScores ?? [],
      planner,
      plannerIntent: planner?.intent.primary ?? null,
      routerRoute: planner?.deterministicRoute ?? decision.route,
      selectedPlan: planner?.selectedPlan ?? "deterministic",
      reason: planner?.selectedPlan === "planner"
        ? decision.explanation
        : planner?.fallback?.reason ?? decision.explanation,
    };
    return {
      content: [{
        type: "text",
        text: [
          `Planner debug for: ${query || "-"}`,
          `plannerIntent: ${String(details.plannerIntent ?? "-")}`,
          `routerRoute: ${String(details.routerRoute)}`,
          `selectedPlan: ${details.selectedPlan}`,
          `routePlan: ${details.routePlan.join(" -> ")}`,
          `reason: ${details.reason}`,
          planner?.validation.violations.length
            ? `violations: ${planner.validation.violations.map((violation) => `${violation.severity}:${violation.code}`).join(", ")}`
            : "violations: none",
        ].join("\n"),
      }],
      details: { tool: "oms_planner_debug", ...details },
    };
  }

  async executeOmsKnowledgeCurate(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const apply = this.getBooleanArg(args, "apply", false);
    const result = await this.runtime.curateKnowledge(context, apply);
    return this.jsonToolResponse("oms_knowledge_curate", result, result.ok);
  }

  async executeOmsAssetSync(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const result = await this.runtime.syncKnowledgeAssets(context, "sync");
    return this.jsonToolResponse("oms_asset_sync", result, result.ok);
  }

  async executeOmsAssetReindex(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const result = await this.runtime.syncKnowledgeAssets(context, "reindex");
    return this.jsonToolResponse("oms_asset_reindex", result, result.ok);
  }

  async executeOmsAssetVerify(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const result = await this.runtime.verifyKnowledgeAssets(context);
    return this.jsonToolResponse("oms_asset_verify", result, result.ok);
  }

  async executeOmsKnowledgeCandidates(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const status = this.getStringArg(args, "status") || undefined;
    const limit = this.getNumberArg(args, "limit", 20);
    const result = await this.runtime.listKnowledgeCandidates(context, { status, limit });
    return {
      content: [{
        type: "text",
        text: result.candidates.length > 0
          ? result.candidates.map((candidate) =>
            `${candidate.score ?? "--"} ${candidate.recommendation ?? "unknown"} ${candidate.status}/${candidate.reviewState ?? "-"} ${candidate.id}: ${candidate.oneLineSummary}`).join("\n")
          : "No knowledge raw candidates matched this filter.",
      }],
      details: { tool: "oms_knowledge_candidates", ...result },
    };
  }

  async executeOmsKnowledgeReview(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const id = this.getStringArg(args, "id");
    const action = this.getStringArg(args, "action");
    if (!id || !["approve", "reject"].includes(action)) {
      return {
        content: [{ type: "text", text: "oms_knowledge_review requires id and action=approve|reject." }],
        details: { ok: false, tool: "oms_knowledge_review", reason: "missing_or_invalid_review_args" },
      };
    }
    const result = await this.runtime.reviewKnowledgeCandidate(context, {
      id,
      action: action as "approve" | "reject",
      reviewer: this.getStringArg(args, "reviewer") || undefined,
      note: this.getStringArg(args, "note") || undefined,
    });
    return this.jsonToolResponse("oms_knowledge_review", result, result.ok);
  }

  async executeOmsBackfillAtoms(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const apply = this.getBooleanArg(args, "apply", false);
    const scope = this.getScopeArg(args);
    const limit = this.getNumberArg(args, "limit", 200);
    const result = await this.runtime.backfillEvidenceAtoms(context, { apply, scope, limit });
    return {
      content: [{
        type: "text",
        text: [
          `Atom backfill ${result.apply ? "applied" : "dry-run"} (${result.scope} scope).`,
          `Summaries: total=${result.totalSummaries}, eligible=${result.eligibleSummaries}, skippedExisting=${result.skippedExistingSummaries}, skippedNoAtoms=${result.skippedNoAtomSummaries}.`,
          `Atoms: existing=${result.existingAtoms}, generated=${result.generatedAtoms}, written=${result.writtenAtoms}.`,
          result.sourceSummaryIds.length > 0
            ? `Source summaries: ${result.sourceSummaryIds.slice(0, 20).join(", ")}${result.sourceSummaryIds.length > 20 ? " ..." : ""}`
            : "Source summaries: none.",
          ...result.warnings,
        ].filter(Boolean).join("\n"),
      }],
      details: { tool: "oms_backfill_atoms", ...result },
    };
  }

  private resolveUsageEventType(value: string): RetrievalUsageEventDraft["eventType"] | null {
    const normalized = value.trim().toLowerCase();
    return ["candidate_seen", "context_selected", "answer_used", "verified_answer_used", "rejected", "negative_feedback"].includes(normalized)
      ? normalized as RetrievalUsageEventDraft["eventType"]
      : null;
  }

  private resolveBrainPackReason(value: string): BrainPackSnapshotReason {
    const normalized = value.trim().toLowerCase();
    return ["manual", "turn_count", "interval", "major_change", "before_upgrade", "before_wipe", "release_gate"].includes(normalized)
      ? normalized as BrainPackSnapshotReason
      : "manual";
  }

  private resolveContext(args: unknown): LifecycleContext {
    return this.payloadAdapter.resolveLifecycleContext(args, this.runtime.getConfig());
  }

  private getQuery(args: unknown): string {
    return this.isRecord(args) && typeof args.query === "string"
      ? args.query.trim()
      : "";
  }

  private getStringArg(args: unknown, key: string): string {
    if (!this.isRecord(args)) {
      return "";
    }
    const value = args[key];
    return typeof value === "string" ? value.trim() : "";
  }

  private resolveRetrievalStrength(args: unknown, fallback: RetrievalStrength): RetrievalStrength {
    const value = this.getStringArg(args, "retrievalStrength").toLowerCase();
    switch (value) {
      case "low":
      case "medium":
      case "high":
      case "xhigh":
      case "custom":
        return value;
      case "off":
      case "light":
        return "low";
      case "auto":
        return "medium";
      case "strict":
        return "high";
      case "forensic":
        return "xhigh";
      default:
        return fallback;
    }
  }

  private getNumberArg(args: unknown, key: string, fallback: number): number {
    const value = this.getOptionalNumberArg(args, key);
    return typeof value === "number" ? value : fallback;
  }

  private getBooleanArg(args: unknown, key: string, fallback: boolean): boolean {
    if (!this.isRecord(args)) {
      return fallback;
    }
    const value = args[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "y", "on"].includes(normalized)) {
        return true;
      }
      if (["0", "false", "no", "n", "off"].includes(normalized)) {
        return false;
      }
    }
    return fallback;
  }

  private readStringArrayArg(args: unknown, key: string): string[] {
    if (!this.isRecord(args)) {
      return [];
    }
    const value = args[key];
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private resolveOperationCreator(value: string): MemoryOperationCreator | undefined {
    const normalized = value.trim().toLowerCase();
    return ["llm", "rule", "user", "system"].includes(normalized)
      ? normalized as MemoryOperationCreator
      : undefined;
  }

  private getOptionalNumberArg(args: unknown, key: string): number | undefined {
    if (!this.isRecord(args)) {
      return undefined;
    }
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private allowWideRawFallback(args: unknown, decision: RetrievalDecision): boolean {
    if (this.isRecord(args) && args.wideRawFallback === true) {
      return true;
    }
    // Keyword lookups over compacted corpora should stay summary-guided by default.
    // Wide raw scans are still available for explicit deep/quality recall.
    return decision.reason !== "keyword_query_with_compacted_history" ||
      (this.isRecord(args) && (args.deepRecall === true || args.qualityMode === true));
  }

  private getScopeArg(args: unknown): "session" | "agent" {
    const value = this.getStringArg(args, "scope").toLowerCase();
    return value === "session" ? "session" : "agent";
  }

  private jsonToolResponse(tool: string, details: object, ok = true): ToolResponse {
    const payload = details as Record<string, unknown>;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ tool, ...payload }, null, 2),
      }],
      details: {
        tool,
        ok,
        ...payload,
      },
    };
  }

  private formatContextInspection(details: Record<string, unknown>): string {
    const run = details.run as Record<string, unknown> | null | undefined;
    if (!run) {
      return "No ContextPlanner run has been recorded yet. Run assemble or memory_retrieve first.";
    }
    const metadata = this.isRecord(run.metadata) ? run.metadata : {};
    const progressiveSteps = Array.isArray(metadata.progressiveRetrievalSteps)
      ? metadata.progressiveRetrievalSteps as Array<Record<string, unknown>>
      : [];
    const selected = Array.isArray(details.selected) ? details.selected as Array<Record<string, unknown>> : [];
    const rejected = Array.isArray(details.rejected) ? details.rejected as Array<Record<string, unknown>> : [];
    const lines = [
      `Context run: ${String(run.id ?? "")}`,
      `Intent: ${String(run.intent ?? "")}`,
      `Budget: selected ${Number(run.selectedTokens ?? 0)} / total ${Number(run.totalBudget ?? 0)} tokens`,
      `Selected: ${selected.length}; Rejected: ${rejected.length}`,
      progressiveSteps.length > 0 ? `Planner run: ${String(metadata.plannerRunId ?? "-")} intent=${String(metadata.plannerIntent ?? "-")} selectedPlan=${String(metadata.selectedPlan ?? "-")}` : "",
      progressiveSteps.length > 0 ? "Progressive planner steps:" : "",
      ...progressiveSteps.slice(0, 12).map((step, index) =>
        `${index + 1}. ${String(step.layer ?? "-")}/${String(step.action ?? "-")} candidates=${Number(step.candidatesFound ?? 0)} selected=${Number(step.selectedCount ?? 0)} verified=${Number(step.sourceVerifiedCount ?? 0)} stop=${String(step.stopTriggered ?? false)} reason=${String(step.reason ?? step.stopReason ?? "")}`),
      ...(progressiveSteps.length > 12 ? [`... ${progressiveSteps.length - 12} more planner step(s)`] : []),
      "",
      "Selected candidates:",
      ...selected.slice(0, 12).map((candidate, index) =>
        `${index + 1}. ${candidate.source}/${candidate.authority} ${candidate.targetKind}:${candidate.targetId ?? "-"} score=${candidate.score} tokens=${candidate.tokenCount} reasons=${this.formatReasonList(candidate.reasons)}`),
      ...(selected.length > 12 ? [`... ${selected.length - 12} more selected candidates`] : []),
      "",
      "Rejected candidates:",
      ...rejected.slice(0, 8).map((candidate, index) =>
        `${index + 1}. ${candidate.source}/${candidate.authority} ${candidate.targetKind}:${candidate.targetId ?? "-"} rejected=${candidate.rejectedReason ?? "budget_or_authority"} reasons=${this.formatReasonList(candidate.reasons)}`),
      ...(rejected.length > 8 ? [`... ${rejected.length - 8} more rejected candidates`] : []),
    ];
    return lines.join("\n");
  }

  private formatWhyRecalled(details: Record<string, unknown>): string {
    const matches = Array.isArray(details.matches) ? details.matches as Array<Record<string, unknown>> : [];
    const header = [
      `Why recalled query: ${String(details.query ?? "-")}`,
      `Target: ${String(details.targetId ?? "-")}`,
      `Context run: ${String(details.inspectedRunId ?? "-")}`,
      String(details.explanation ?? ""),
      "",
    ];
    const latestRun = this.isRecord(details.latestRun) ? details.latestRun : undefined;
    const latestMetadata = this.isRecord(latestRun?.metadata) ? latestRun.metadata : undefined;
    const progressiveSteps = Array.isArray(latestMetadata?.progressiveRetrievalSteps)
      ? latestMetadata.progressiveRetrievalSteps as Array<Record<string, unknown>>
      : [];
    if (matches.length === 0) {
      return [
        ...header,
        progressiveSteps.length > 0 ? `Planner run: ${String(latestMetadata?.plannerRunId ?? "-")}` : "",
        ...progressiveSteps.slice(0, 6).map((step, index) =>
          `Planner step ${index + 1}: ${String(step.layer ?? "-")}/${String(step.action ?? "-")} candidates=${Number(step.candidatesFound ?? 0)} verified=${Number(step.sourceVerifiedCount ?? 0)} stop=${String(step.stopTriggered ?? false)}`),
        "No matching candidate audit rows were found.",
      ].filter((line) => line.length > 0).join("\n");
    }
    return [
      ...header,
      progressiveSteps.length > 0 ? `Planner run: ${String(latestMetadata?.plannerRunId ?? "-")}` : "",
      ...progressiveSteps.slice(0, 6).map((step, index) =>
        `Planner step ${index + 1}: ${String(step.layer ?? "-")}/${String(step.action ?? "-")} candidates=${Number(step.candidatesFound ?? 0)} verified=${Number(step.sourceVerifiedCount ?? 0)} stop=${String(step.stopTriggered ?? false)}`),
      ...matches.map((candidate, index) =>
        `${index + 1}. ${candidate.status} ${candidate.source}/${candidate.authority} ${candidate.targetKind}:${candidate.targetId ?? "-"} score=${candidate.score} tokens=${candidate.tokenCount} reasons=${this.formatReasonList(candidate.reasons)}${candidate.rejectedReason ? ` rejected=${candidate.rejectedReason}` : ""}`),
    ].filter((line) => line.length > 0).join("\n");
  }

  private formatReasonList(value: unknown): string {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").join(",")
      : "";
  }

  private isPlannerValidationBlocked(decision: RetrievalDecision): boolean {
    return decision.planner?.validation.accepted === false &&
      decision.planner.validation.fallbackRoute === "safe_no_answer";
  }

  private isRetrievalVerifierBlocked(result: RetrievalVerificationResult): boolean {
    return (result.sourceTraceRequired || result.fullRawTraceRequired) && result.status !== "sufficient";
  }

  private searchMemoryItemHits(
    entries: MemoryItemEntry[],
    query: string,
    projectId?: string,
    limit = 5,
  ): MemoryItemEntry[] {
    const terms = this.queryTerms(query);
    if (terms.length === 0) {
      return [];
    }

    const scored = entries
      .filter((entry) => entry.status === "active" && entry.contextPolicy !== "never")
      .map((entry) => ({
        entry,
        score: this.scoreMemoryItemEntry(entry, terms, query) +
          (projectId && entry.projectId === projectId ? 5 : 0),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
      });

    const scoped = projectId
      ? scored.filter((item) => item.entry.projectId === projectId)
      : [];
    const source = scoped.length > 0 ? scoped : scored;
    return source.slice(0, Math.max(limit, 1)).map((item) => item.entry);
  }

  private recordDirectMemoryItemUsage(
    runtimeStore: { recordRetrievalUsageEvents(events: RetrievalUsageEventDraft[]): void },
    hits: MemoryItemEntry[],
    query: string,
    context: LifecycleContext,
    decision: RetrievalDecision,
  ): void {
    if (!context.config.usageFeedbackEnabled || hits.length === 0) {
      return;
    }
    const events: RetrievalUsageEventDraft[] = [];
    hits.forEach((hit, index) => {
      const sourceVerified = hit.evidenceLevel === "source_verified" && !hit.inferred;
      const common = {
        targetKind: "memory_item",
        targetId: hit.id,
        sessionId: context.sessionId,
        agentId: context.config.agentId,
        projectId: hit.projectId,
        query,
        route: decision.route,
        retrievalStrength: context.config.retrievalStrength,
        selectedRank: index + 1,
        sourceVerified,
        metadata: { sourceTable: hit.sourceTable, sourceId: hit.sourceId },
      } satisfies Omit<RetrievalUsageEventDraft, "eventType">;
      events.push({ ...common, eventType: "candidate_seen" });
      events.push({ ...common, eventType: "context_selected" });
      events.push({
        ...common,
        eventType: sourceVerified ? "verified_answer_used" : "answer_used",
        answerUsed: true,
      });
    });
    try {
      runtimeStore.recordRetrievalUsageEvents(events);
    } catch {
      // Usage feedback must never make retrieval fail.
    }
  }

  private buildRetrievalEnhancementDiagnostics(config: LifecycleContext["config"]): Record<string, unknown> {
    return RetrievalEnhancementRegistry.status(config) as unknown as Record<string, unknown>;
  }

  private scoreBoundedRetrievalUsage(value: unknown): number {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return 0;
    }
    const record = value as Record<string, unknown>;
    const decayed = this.numberFromRecord(record, "decayedUsageScore");
    const authority = this.numberFromRecord(record, "authorityUsageScore");
    const negative = this.numberFromRecord(record, "negativeFeedbackCount") * 2.5;
    const rejected = this.numberFromRecord(record, "rejectedCount") * 0.35;
    const raw = (decayed * 0.6) + (authority * 0.4) - negative - rejected;
    return Math.max(-4, Math.min(6, raw));
  }

  private numberFromRecord(record: Record<string, unknown>, key: string): number {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  private scoreMemoryItemEntry(
    entry: MemoryItemEntry,
    terms: string[],
    query: string,
  ): number {
    const metadata = entry.metadata ?? {};
    const haystack = [
      entry.kind,
      entry.status,
      entry.scope,
      entry.evidenceLevel,
      entry.contextPolicy,
      entry.sourceTable,
      entry.projectId ?? "",
      entry.topicId ?? "",
      ...entry.tags,
      typeof metadata.factKey === "string" ? metadata.factKey : "",
      typeof metadata.factValue === "string" ? metadata.factValue : "",
      typeof metadata.draftKind === "string" ? metadata.draftKind : "",
      typeof metadata.evidenceDraftType === "string" ? metadata.evidenceDraftType : "",
      entry.content ?? entry.text,
    ].join(" ").toLowerCase();
    let score = this.scoreHaystack(haystack, terms);
    if (entry.evidenceLevel === "source_verified") {
      score += 3;
    } else if (entry.inferred) {
      score -= 1;
    }
    if (entry.contextPolicy === "strict_only" || entry.contextPolicy === "always_core") {
      score += 2;
    }
    if (/(current|latest|now|currently)/i.test(query) && typeof metadata.factKey === "string") {
      score += 4;
    }
    score += this.scoreBoundedRetrievalUsage(metadata.retrievalUsage);
    return score;
  }

  private queryTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
  }

  private semanticTerms(query: string): string[] {
    const baseTerms = this.queryTerms(query);
    const synonyms = new Map<string, string[]>([
      ["retry", ["backoff", "retries", "retrying"]],
      ["backoff", ["retry", "retries"]],
      ["constraint", ["must", "requirement", "limit", "rule"]],
      ["config", ["setting", "parameter", "configuration"]],
      ["decision", ["decide", "chose", "choice"]],
      ["state", ["status", "progress", "current"]],
      ["next", ["step", "action", "todo"]],
      ["knowledge", ["docs", "documentation", "reference", "manual"]],
      ["summary", ["history", "earlier", "recall"]],
      ["原文", ["细节", "参数", "准确"]],
      ["状态", ["进度", "当前", "项目"]],
      ["下一步", ["下一项", "后续", "todo"]],
      ["知识库", ["文档", "资料", "参考"]],
    ]);
    const expanded = [...baseTerms];
    for (const term of baseTerms) {
      expanded.push(...(synonyms.get(term) ?? []));
    }
    return [...new Set(expanded)];
  }

  private scoreSummaryEntry(
    entry: SummaryEntry,
    terms: string[],
    query: string,
  ): number {
    return this.scoreSemanticHaystack(
      [
        entry.summary,
        ...entry.keywords,
        ...(entry.constraints ?? []),
        ...(entry.decisions ?? []),
        ...(entry.blockers ?? []),
        ...(entry.nextSteps ?? []),
        ...(entry.keyEntities ?? []),
        ...(entry.exactFacts ?? []),
      ].join(" "),
      terms,
      query,
    ) + (entry.summaryLevel === 1 ? 2 : 0);
  }

  private scoreHaystack(haystack: string, terms: string[]): number {
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += term.length >= 6 ? 3 : 2;
      }
    }
    if (terms.length > 0 && terms.every((term) => haystack.includes(term))) {
      score += 4;
    }
    return score;
  }

  private scoreSemanticHaystack(
    haystack: string,
    terms: string[],
    query: string,
  ): number {
    const normalizedHaystack = haystack.toLowerCase();
    let score = this.scoreHaystack(normalizedHaystack, terms);
    const similarity = this.computeTrigramSimilarity(query.toLowerCase(), normalizedHaystack);
    if (similarity >= 0.12) {
      score += Math.round(similarity * 20);
    }
    return score;
  }

  private computeTrigramSimilarity(left: string, right: string): number {
    const leftSet = this.buildTrigramSet(left);
    const rightSet = this.buildTrigramSet(right);
    if (leftSet.size === 0 || rightSet.size === 0) {
      return 0;
    }
    let intersection = 0;
    for (const item of leftSet) {
      if (rightSet.has(item)) {
        intersection += 1;
      }
    }
    return intersection / Math.max(leftSet.size, rightSet.size);
  }

  private buildTrigramSet(value: string): Set<string> {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length < 3) {
      return new Set(normalized ? [normalized] : []);
    }
    const grams = new Set<string>();
    for (let index = 0; index <= normalized.length - 3; index += 1) {
      grams.add(normalized.slice(index, index + 3));
    }
    return grams;
  }

  private buildBudgetAwareRecallItem(
    query: string,
    item: ContextItem,
    recallBudget: number,
  ): ContextItem {
    return (this.getRecallExecutionCompatService() as unknown as {
      buildBudgetAwareRecallItem(query: string, item: ContextItem, recallBudget: number): ContextItem;
    }).buildBudgetAwareRecallItem(query, item, recallBudget);
  }

  private async planRecallItems(
    query: string,
    result: RecallResult,
    retrievalBudget: RetrievalBudgetPlan,
    config: LifecycleContext["config"] = DEFAULT_BRIDGE_CONFIG,
    decision?: RetrievalDecision,
  ): Promise<{
    items: ContextItem[];
    consumedTokens: number;
    plan: ContextPlannerResult;
    rerankAudit: RerankAudit;
  }> {
    return this.getRecallExecutionCompatService().planRecallItems(query, result, retrievalBudget, config, decision);
  }

  private evaluateEvidenceGate(
    query: string,
    items: ContextItem[],
    result: RecallResult,
  ): EvidenceGateResult {
    return this.getEvidenceResolutionCompatService().evaluateEvidenceGate(query, items, result);
  }

  private formatRecallText(
    query: string,
    items: ContextItem[],
    sourceTrace: Array<{ summaryId?: string; strategy: string; verified: boolean; resolvedMessageCount: number }> = [],
    answerCandidates: AnswerCandidate[] = [],
    presentation: RecallPresentationOptions = {
      maxItems: 4,
      maxCharsPerItem: 700,
      includeFullTrace: false,
    },
    evidenceGate?: EvidenceGateResult,
    diagnostics: RecallTextDiagnostics = {},
  ): string {
    return this.getPresentationCompatService().formatRecallText({
      query,
      items,
      sourceTrace,
      answerCandidates,
      presentation,
      evidenceGate,
      diagnostics,
    });
  }

  private getRecallExecutionCompatService(): RecallExecutionService {
    if (this.recallExecutionService) {
      return this.recallExecutionService;
    }
    const service = new RecallExecutionService(
      {
        getLlmCaller: () => null,
      } as unknown as ChaunyomsSessionRuntime,
      {
        matchProject: this.retrievalDecisionService?.matchProject?.bind(this.retrievalDecisionService) ?? this.matchProjectFallback.bind(this),
        queryTerms: this.queryTerms.bind(this),
        scoreMemoryItemEntry: this.scoreMemoryItemEntry.bind(this),
        scoreSemanticHaystack: this.scoreSemanticHaystack.bind(this),
        scoreSummaryEntry: this.scoreSummaryEntry.bind(this),
        semanticTerms: this.semanticTerms.bind(this),
      },
    );
    const compatContextPlanner = (this as unknown as { contextPlanner?: ContextPlanner }).contextPlanner;
    if (compatContextPlanner) {
      (service as unknown as { contextPlanner: ContextPlanner }).contextPlanner = compatContextPlanner;
    }
    return service;
  }

  private getEvidenceResolutionCompatService(): EvidenceResolutionService {
    return this.evidenceResolutionService ?? new EvidenceResolutionService();
  }

  private getPresentationCompatService(): RetrievalPresentationService {
    if (this.retrievalPresentationService) {
      return this.retrievalPresentationService;
    }
    return new RetrievalPresentationService({
      buildRetrievalEnhancementDiagnostics: this.buildRetrievalEnhancementDiagnostics.bind(this),
      compactDagTrace: (dagTrace) => this.getEvidenceResolutionCompatService().compactDagTrace({ dagTrace }),
      compactSourceTrace: (sourceTrace) => this.getEvidenceResolutionCompatService().compactSourceTrace({ sourceTrace }),
      describeConfigGuidanceWarnings: () => [],
      describeRetrievalRoute: this.describeRetrievalRoute.bind(this),
      explainAutoRecall: this.explainAutoRecall.bind(this),
      getRetrievalHitType: this.getRetrievalHitType.bind(this),
      isSourceTraceRequired: this.isSourceTraceRequired.bind(this),
      queryTerms: this.queryTerms.bind(this),
      shouldAutoRecall: this.shouldAutoRecall.bind(this),
    });
  }

  private matchProjectFallback(query: string, projects: ProjectRecord[]): ProjectRecord | null {
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

  private buildMissingQueryResponse(toolName: string): ToolResponse {
    return {
      content: [
        {
          type: "text",
          text: `${toolName} requires a non-empty \`query\`.`,
        },
      ],
      details: { ok: false, missingParam: "query" },
    };
  }

  private buildMissingIdResponse(toolName: string): ToolResponse {
    return {
      content: [
        {
          type: "text",
          text: `${toolName} requires a non-empty \`id\`.`,
        },
      ],
      details: { ok: false, missingParam: "id" },
    };
  }

  private truncateText(value: string, maxChars: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd()} ... [truncated]`;
  }

  private formatGrepHit(index: number, hit: OmsGrepHit, maxCharsPerMessage = 4000): string {
    const before = hit.before.map((message) =>
      `  before [turn ${message.turnNumber}] ${message.role}: ${this.truncateText(message.content, maxCharsPerMessage)}`,
    );
    const after = hit.after.map((message) =>
      `  after [turn ${message.turnNumber}] ${message.role}: ${this.truncateText(message.content, maxCharsPerMessage)}`,
    );
    return [
      `${index}. [score ${hit.score}] [turn ${hit.message.turnNumber}] ${hit.message.role} ${hit.message.id}`,
      this.truncateText(hit.message.content, maxCharsPerMessage),
      ...before,
      ...after,
    ].join("\n");
  }

  private formatExpandResult(
    kind: string,
    id: string,
    result: OmsExpandResult,
    options: { full: boolean; maxMessages: number; maxCharsPerMessage: number },
  ): string {
    if (!result.target) {
      return `No runtime target found for ${kind}:${id}`;
    }
    const visibleMessages = options.full ? result.messages : result.messages.slice(0, options.maxMessages);
    const messages = visibleMessages.map((message) =>
      `[turn ${message.turnNumber}] ${message.role}: ${options.full ? message.content : this.truncateText(message.content, options.maxCharsPerMessage)}`,
    );
    const summaries = result.summaries.map((summary) =>
      `[summary ${summary.id}] turns ${summary.startTurn}-${summary.endTurn}: ${this.truncateText(summary.summary, options.full ? 10000 : 1200)}`,
    );
    const edges = result.edges.map((edge) =>
      `${edge.sourceKind}:${edge.sourceId} --${edge.relation}--> ${edge.targetKind}:${edge.targetId}`,
    );
    return [
      `Expanded ${kind}:${id}`,
      "",
      "Source edges:",
      edges.length > 0 ? edges.join("\n") : "(none)",
      "",
      "Summaries:",
      summaries.length > 0 ? summaries.join("\n\n") : "(none)",
      "",
      "Raw messages:",
      messages.length > 0 ? messages.join("\n\n") : "(none)",
      !options.full && result.messages.length > visibleMessages.length
        ? `\n... ${result.messages.length - visibleMessages.length} more raw message(s) omitted. Re-run oms_expand with full=true if you need the whole source window.`
        : "",
    ].join("\n");
  }

  private buildRecallDisabledResponse(
    query: string,
    memoryItemHits: MemoryItemEntry[],
    context: LifecycleContext,
    decision: RetrievalDecision,
  ): ToolResponse {
    if (this.isSourceTraceRequired(decision, context)) {
      return {
        content: [{
          type: "text",
          text: [
            `Source recall is required for: ${query}`,
            context.config.emergencyBrake
              ? "Emergency brake is enabled, so OMS refuses to answer from unsupported memory or summary hints."
              : "Automatic source recall is disabled, so OMS refuses to answer from unsupported memory or summary hints.",
          ].join("\n"),
        }],
        details: {
          ok: true,
          route: decision.route,
          retrievalLabel: this.describeRetrievalRoute(decision),
          query,
          hitCount: 0,
          blockedHitCount: memoryItemHits.length,
          memoryItemHitCount: memoryItemHits.length,
          topRecordType: null,
          retrievalHitType: "insufficient_source_evidence",
          evidencePresentation: "no_answer",
          autoRecall: false,
          autoRecallReason: context.config.emergencyBrake ? "emergency_brake_enabled" : "auto_recall_disabled",
          emergencyBrake: context.config.emergencyBrake,
          autoRecallEnabled: context.config.autoRecallEnabled,
          routePlan: decision.routePlan,
          layerScores: decision.layerScores ?? [],
          explanation: decision.explanation,
          fallbackTrace: [{
            from: decision.route,
            to: "none",
            reason: "source_trace_required_but_recall_disabled",
          }],
        },
      };
    }
    const text = memoryItemHits.length > 0
      ? `${this.retrievalPresentationService.formatMemoryItemText(query, memoryItemHits)}\n\nSource recall is currently disabled by safety policy.`
      : `Source recall is currently disabled${context.config.emergencyBrake ? " because emergency brake is enabled" : " by configuration"}.`;
    const hitCount = memoryItemHits.length;
    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        hitCount,
        memoryItemHitCount: memoryItemHits.length,
        topRecordType: memoryItemHits.length > 0 ? "memory_item" : null,
        retrievalHitType: hitCount > 0 ? "memory_item" : this.getRetrievalHitType(decision),
        autoRecall: false,
        autoRecallReason: context.config.emergencyBrake ? "emergency_brake_enabled" : "auto_recall_disabled",
        emergencyBrake: context.config.emergencyBrake,
        autoRecallEnabled: context.config.autoRecallEnabled,
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        fallbackTrace: [{
          from: decision.route,
          to: memoryItemHits.length > 0 ? "memory_item" : "none",
          reason: context.config.emergencyBrake ? "emergency_brake_enabled" : "auto_recall_disabled",
        }],
      },
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  private normalizeOpenClawSearchArgs(args: unknown): Record<string, unknown> {
    const record = this.isRecord(args) ? { ...args } : {};
    const query =
      this.getStringArg(record, "query") ||
      this.getStringArg(record, "q") ||
      this.getStringArg(record, "text");
    return {
      ...record,
      query,
    };
  }

  private normalizeOpenClawMemoryRef(ref: string): string {
    const normalized = ref.trim();
    return normalized
      .replace(/^memory_id:/i, "")
      .replace(/^summary_id:/i, "")
      .replace(/^source_id:/i, "")
      .replace(/^message_id:/i, "")
      .replace(/^asset_id:/i, "");
  }

  private resolveOpenClawMemoryRefKind(
    args: Record<string, unknown>,
    ref: string,
  ): string {
    const explicitKind = this.getStringArg(args, "kind").toLowerCase();
    if (explicitKind === "message" || explicitKind === "summary" || explicitKind === "asset") {
      return explicitKind;
    }
    if (explicitKind === "memory" || explicitKind === "memory_item") {
      return "memory_item";
    }
    if (/^(memory_id:|memory-item:|mem_)/i.test(ref)) {
      return "memory_item";
    }
    if (/^(summary_id:|summary-|summary_)/i.test(ref)) {
      return "summary";
    }
    if (/^(asset_id:|asset:|doc_)/i.test(ref)) {
      return "asset";
    }
    return "auto";
  }

  private withOpenClawCompatibility(
    result: ToolResponse,
    openClawTool: string,
    canonicalTool: string,
    metadata: Record<string, unknown> = {},
  ): ToolResponse {
    return {
      ...result,
      details: {
        ...result.details,
        toolCompatibility: {
          openClawTool,
          canonicalTool,
          compatibilityLayer: "chaunyoms-openclaw-memory",
          ...metadata,
        },
      },
    };
  }

  private shouldAutoRecall(decision: RetrievalDecision, context: LifecycleContext): boolean {
    if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
      return false;
    }
    return this.isSourceTraceRequired(decision, context) || decision.requiresSourceRecall || decision.route === "summary_tree";
  }

  private isSourceTraceRequired(decision: RetrievalDecision, context: LifecycleContext): boolean {
    return decision.planner?.sourceTraceRequired === true ||
      context.config.retrievalStrength === "high" ||
      context.config.retrievalStrength === "xhigh";
  }

  private isHardSourceTraceRequired(context: LifecycleContext): boolean {
    return context.config.retrievalStrength === "high" ||
      context.config.retrievalStrength === "xhigh";
  }

  private explainAutoRecall(decision: RetrievalDecision, context: LifecycleContext): string | null {
    if (context.config.emergencyBrake) {
      return "emergency_brake_enabled";
    }
    if (!context.config.autoRecallEnabled) {
      return "auto_recall_disabled";
    }
    if (!this.shouldAutoRecall(decision, context)) {
      return null;
    }
    if (decision.requiresSourceRecall) {
      return "fact_or_constraint_query_requires_source_recall";
    }
    if (decision.route === "summary_tree") {
      return "historical_summary_tree_route_requires_recall";
    }
    return "route_policy_requires_recall";
  }

  private getRetrievalHitType(
    decision: RetrievalDecision,
  ): "route_hit" | "summary_tree_recall" | "recent_tail" | "project_registry" | "memory_item" | "knowledge" {
    if (decision.route === "project_registry") {
      return "project_registry";
    }
    if (decision.route === "memory_item") {
      return "memory_item";
    }
    if (decision.route === "knowledge") {
      return "knowledge";
    }
    if (decision.route === "summary_tree") {
      return "summary_tree_recall";
    }
    return "recent_tail";
  }

  private describeRetrievalRoute(decision: RetrievalDecision): string {
    switch (decision.route) {
      case "recent_tail":
        return "recent-tail direct context";
      case "project_registry":
        return "project registry state";
      case "memory_item":
        return "MemoryItem";
      case "summary_tree":
        return "summary tree -> raw recall";
      case "knowledge":
        return "unified knowledge";
      default:
        return decision.route;
    }
  }

  private buildProjectRegistryResult(
    project: ProjectRecord | null,
    decision: RetrievalDecision,
    query: string,
  ): ToolResponse {
    const text = project
      ? [
          `Project: ${project.title}`,
          `Status: ${project.status}`,
          `Summary: ${project.summary}`,
          `Active focus: ${project.activeFocus}`,
          `Current decision: ${project.currentDecision}`,
          `Next step: ${project.nextStep}`,
          `Todo: ${project.todo}`,
          `Blocker: ${project.blocker}`,
          `Risk: ${project.risk}`,
        ].join("\n")
      : `No matching project registry entry found for query: ${query}`;

    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        retrievalHitType: "project_registry",
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        matchedProjectId: project?.id ?? decision.matchedProjectId ?? null,
        matchedProjectTitle: project?.title ?? decision.matchedProjectTitle ?? null,
        autoRecall: false,
        autoRecallReason: null,
      },
    };
  }

}
