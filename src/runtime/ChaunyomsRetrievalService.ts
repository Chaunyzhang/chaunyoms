import { ContextPlanner, ContextPlannerResult } from "../engines/ContextPlanner";
import { LLMPlanner } from "../planner/LLMPlanner";
import { PlanValidator } from "../planner/PlanValidator";
import { RetrievalRuntime } from "../retrieval/RetrievalRuntime";
import { DeterministicReranker, RerankAudit, RetrievalEnhancementRegistry } from "../retrieval/RetrievalEnhancementProviders";
import { BrainPackExporter, BrainPackSnapshotReason } from "../brainpack/BrainPackExporter";
import { BrainPackScheduler } from "../brainpack/BrainPackScheduler";
import { BenchmarkComparisonGuard } from "../evals/benchmark-comparison";
import { MemoryOperationCreator } from "../memory/MemoryOperation";
import { OpenClawNativeAbsorber } from "../native/OpenClawNativeAbsorber";
import { RetrievalVerifier, RetrievalVerificationResult } from "../retrieval/RetrievalVerifier";
import { MemoryRetrievalRouter } from "../routing/MemoryRetrievalRouter";
import { RecallResolver } from "../resolvers/RecallResolver";
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
  DagTraversalStep,
} from "../types";
import {
  LifecycleContext,
  OpenClawPayloadAdapter,
} from "../host/OpenClawPayloadAdapter";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { ChaunyomsSessionRuntime } from "./ChaunyomsSessionRuntime";
import {
  OmsExpandResult,
  OmsGrepHit,
  RetrievalUsageEventDraft,
  RuntimeEnhancementSearchResult,
  SQLiteRuntimeStore,
} from "../data/SQLiteRuntimeStore";
import { estimateTokens } from "../utils/tokenizer";

interface ToolResponse {
  content: Array<Record<string, unknown>>;
  details: Record<string, unknown>;
}

interface SemanticExpansionResult {
  candidates: SemanticCandidate[];
  memoryItemHits: MemoryItemEntry[];
  summaryHits: SummaryEntry[];
  projectHit: ProjectRecord | null;
  ragSearch?: RuntimeEnhancementSearchResult;
  graphSearch?: RuntimeEnhancementSearchResult;
}

interface RecallPresentationOptions {
  maxItems: number;
  maxCharsPerItem: number;
  includeFullTrace: boolean;
}

interface EvidenceGateResult {
  status: "sufficient" | "needs_expansion" | "insufficient";
  reason: string;
  atomHitCount: number;
  usableAtomCount: number;
  verifiedTraceCount: number;
  recommendedAction: "answer" | "expand_l1" | "trace_raw" | "no_answer";
  nextActionHint?: string;
  targetIds: string[];
}

interface AtomEvidenceHealth {
  atomHitCount: number;
  usableAtomCount: number;
  blockedReasons: string[];
}

type RecallLayer = "atom" | "summary" | "raw";

interface RetrievalBudgetPlan {
  total: number;
  atom: number;
  summary: number;
  raw: number;
  perItem: {
    atom: number;
    summary: number;
    raw: number;
  };
}

interface RecallTextDiagnostics {
  retrievalBudget?: RetrievalBudgetPlan;
  persistentEvidenceAtomHitCount?: number;
  transientEvidenceAtomHitCount?: number;
  retrievalVerification?: RetrievalVerificationResult;
}

interface PlannerAuditContext {
  query: string;
  decision: RetrievalDecision;
  planned?: {
    plan: ContextPlannerResult;
    items: ContextItem[];
  };
  recallResult?: RecallResult;
  retrievalVerification?: RetrievalVerificationResult;
  evidenceGate?: EvidenceGateResult;
  rerankAudit?: RerankAudit;
  timings?: Record<string, number>;
}

export interface RetrievalLayerDependencies {
  fixedPrefixProvider: FixedPrefixProvider;
}

export class ChaunyomsRetrievalService {
  private readonly contextPlanner = new ContextPlanner();
  private readonly recallResolver = new RecallResolver();
  private readonly retrievalRouter = new MemoryRetrievalRouter();
  private readonly llmPlanner = new LLMPlanner(() => this.runtime.getLlmCaller());
  private readonly planValidator = new PlanValidator();
  private readonly retrievalRuntime = new RetrievalRuntime();
  private readonly retrievalVerifier = new RetrievalVerifier();
  private readonly deterministicReranker = new DeterministicReranker();
  private readonly fixedPrefixProvider: FixedPrefixProvider;

  constructor(
    private readonly runtime: ChaunyomsSessionRuntime,
    private readonly payloadAdapter: OpenClawPayloadAdapter,
    dependencies: RetrievalLayerDependencies,
  ) {
    this.fixedPrefixProvider = dependencies.fixedPrefixProvider;
  }

  async executeMemoryRoute(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const stores = await this.runtime.getSessionStores(context);
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const query = this.getQuery(args);
    const scope = this.getScopeArg(args);
    const scopedSessionId = scope === "session" ? context.sessionId : undefined;
    const { decision } = await this.resolveRetrievalDecision(query, context);
    const semanticExpansion = await this.collectSemanticExpansion({
      query,
      context,
      decision,
      runtimeStore,
      allowIndexing: false,
      memoryItems: runtimeStore.listMemoryItems({ agentId: context.config.agentId }),
      summaryHits: stores.summaryStore.search(query, { sessionId: scopedSessionId }),
      projects: stores.projectStore.getAll().filter((project) => project.status !== "archived"),
      matchedProject: decision.matchedProjectId
        ? stores.projectStore.findById(decision.matchedProjectId)
        : null,
    });
    const configGuidance = this.payloadAdapter.describeConfigGuidance(context.config);
    const diagnostics = this.buildDiagnosticsEnvelope(
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
    const stores = await this.runtime.getSessionStores(context);
    const { rawStore, summaryStore, projectStore } = stores;
    const query = this.getQuery(args);
    if (!query) {
      return this.buildMissingQueryResponse("memory_retrieve");
    }

    if (retrievalStrength === "off") {
      return {
        content: [{
          type: "text",
          text: "ChaunyOMS retrieval is off for this request; no memory, summary, knowledge, or source recall layers were consulted.",
        }],
        details: {
          ok: true,
          query,
          route: "recent_tail",
          retrievalStrength,
          retrievalHitType: "disabled",
          sourceTraceRequired: false,
          evidencePresentation: "none",
          consultedLayers: [],
        },
      };
    }

    const scope = this.getScopeArg(args);
    const scopedSessionId = scope === "session" ? context.sessionId : undefined;
    const { decision } = await this.resolveRetrievalDecision(query, context);
    if (this.isPlannerValidationBlocked(decision)) {
      await this.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_planner_blocked", {
        validationBlocked: true,
      });
      return this.attachDiagnostics(
        this.buildPlannerValidationBlockedResponse(query, decision),
        query,
        context,
        decision,
        this.emptySemanticExpansion(null),
      );
    }
    const activeProjects = projectStore.getAll().filter((project) => project.status !== "archived");
    const matchedProject = this.matchProject(query, activeProjects);
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
    const semanticExpansion = await this.collectSemanticExpansion({
      query,
      context,
      decision,
      runtimeStore,
      allowIndexing: true,
      memoryItems: runtimeStore.listMemoryItems({
        agentId: context.config.agentId,
        includeRetrievalUsage: context.config.usageFeedbackEnabled,
      }),
      summaryHits: summaryStore.search(query, { sessionId: scopedSessionId }),
      projects: activeProjects,
      matchedProject,
    });
    if ((decision.requiresSourceRecall || decision.route === "summary_tree") && (!context.config.autoRecallEnabled || context.config.emergencyBrake)) {
      await this.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_source_recall_disabled", {
        sourceRecallDisabled: true,
      });
      return this.attachDiagnostics(
        this.buildRecallDisabledResponse(query, memoryItemHits, context, decision),
        query,
        context,
        decision,
        semanticExpansion,
      );
    }

    if (decision.route === "project_registry") {
      const project = this.matchProject(query, projectStore.getAll());
      await this.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_project_registry", {
        matchedProjectId: project?.id ?? decision.matchedProjectId ?? null,
      });
      return this.attachDiagnostics(
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
      await this.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_memory_item", {
        memoryItemHitCount: memoryItemHits.length,
      });
      return this.attachDiagnostics({
        content: [{ type: "text", text: this.formatMemoryItemText(query, memoryItemHits) }],
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
        await this.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_source_recall_disabled", {
          sourceRecallDisabled: true,
        });
        return this.attachDiagnostics(
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
      const rawFtsHints = this.shouldUseFtsRecallHints(args, context)
        ? (await this.runtime.getRuntimeStore(context)).grepMessages(query, {
            sessionId: scopedSessionId,
            limit: this.resolveRawFtsHintLimit(args),
            contextTurns: 0,
          })
        : [];
      timings.ftsMs = Date.now() - ftsStartedAt;
      const retrievalBudget = this.resolveRetrievalBudgetPlan(args, context.totalBudget);
      const recallBudget = retrievalBudget.total;
      const rawFtsMessageIds = rawFtsHints.map((hit) => hit.message.id);
      const recallStartedAt = Date.now();
      const result = this.recallResolver.resolve(query, summaryStore, rawStore, recallBudget, {
        sessionId: scopedSessionId,
        rawHintMessageIds: rawFtsMessageIds,
        rawCandidateMessageIds: rawFtsMessageIds,
        allowRawFirst: decision.reason !== "keyword_query_with_compacted_history",
        allowWideFallback: this.allowWideRawFallback(args, decision),
        includeSummaryItems: true,
      });
      timings.resolveMs = Date.now() - recallStartedAt;
      const atomStartedAt = Date.now();
      const atomResult = this.withPersistentEvidenceAtomHits(
        result,
        this.queryNeedsRawSource(query)
          ? []
          : stores.evidenceAtomStore.search(query, {
              sessionId: scopedSessionId,
              limit: 8,
            }),
        recallBudget,
      );
      timings.atomMs = Date.now() - atomStartedAt;
      const planStartedAt = Date.now();
      const enhancedResult = this.mergeEnhancementCandidatesIntoRecallResult(
        atomResult,
        semanticExpansion,
        recallBudget,
      );
      const planned = this.planRecallItems(query, enhancedResult, retrievalBudget, context.config, decision);
      timings.planMs = Date.now() - planStartedAt;
      const evidenceGate = this.evaluateEvidenceGate(query, planned.items, enhancedResult);
      const retrievalVerification = this.retrievalVerifier.verify({
        retrievalStrength,
        items: planned.items,
        sourceTrace: enhancedResult.sourceTrace,
        answerCandidates: enhancedResult.answerCandidates,
        recallResult: enhancedResult,
      });
      const persistentEvidenceAtomHitCount = atomResult.items.filter((item) =>
        item.metadata?.persistentEvidenceAtom === true,
      ).length;
      const transientEvidenceAtomHitCount = atomResult.items.filter((item) =>
        (item.metadata?.evidenceAtom === true || typeof item.metadata?.atomId === "string") &&
        item.metadata?.persistentEvidenceAtom !== true,
      ).length;
      const progressiveRetrievalSteps = this.buildProgressiveRetrievalSteps({
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
        answerUsed: retrievalVerification.status === "sufficient" && retrievalVerification.recommendedAction === "answer",
        verifiedAnswerUsed: retrievalVerification.verifiedTraceCount > 0 || retrievalVerification.verifiedAnswerCount > 0,
        planner: decision.planner ?? null,
        plannerRunId: decision.planner?.runId ?? null,
        plannerIntent: decision.planner?.intent.primary ?? null,
        selectedPlan: decision.planner?.selectedPlan ?? "deterministic",
        sourceTraceRequired: this.isSourceTraceRequired(decision, context),
        retrievalVerification,
        evidenceGate,
        progressiveRetrievalSteps,
        rerankAudit: planned.rerankAudit,
      });
      const presentation = this.resolveRecallPresentationOptions(args, context.config.retrievalStrength);
      timings.totalMs = Date.now() - startedAt;
      if (this.isRetrievalVerifierBlocked(retrievalVerification)) {
        return this.attachDiagnostics(
          this.buildRetrievalVerifierBlockedResponse(
            query,
            decision,
            enhancedResult,
            retrievalVerification,
            evidenceGate,
            {
              retrievalBudget,
              persistentEvidenceAtomHitCount,
              transientEvidenceAtomHitCount,
            },
            progressiveRetrievalSteps,
          ),
          query,
          context,
          decision,
          semanticExpansion,
        );
      }
      return this.attachDiagnostics({
        content: [{ type: "text", text: this.formatRecallText(query, planned.items, enhancedResult.sourceTrace, enhancedResult.answerCandidates, presentation, evidenceGate, {
          retrievalBudget,
          persistentEvidenceAtomHitCount,
          transientEvidenceAtomHitCount,
          retrievalVerification,
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
          rawFtsHintLimit: this.resolveRawFtsHintLimit(args),
          scope,
          sessionId: scopedSessionId ?? null,
          dagTrace: presentation.includeFullTrace ? enhancedResult.dagTrace : this.compactDagTrace(enhancedResult.dagTrace),
          sourceTrace: presentation.includeFullTrace ? enhancedResult.sourceTrace : this.compactSourceTrace(enhancedResult.sourceTrace),
          answerCandidates: this.compactAnswerCandidates(enhancedResult.answerCandidates ?? [], presentation),
          ragSearch: semanticExpansion.ragSearch ?? null,
          graphSearch: semanticExpansion.graphSearch ?? null,
          plannerRunId: planned.plan.runId,
          plannerRejectedCount: planned.plan.rejected.length,
        },
      }, query, context, decision, semanticExpansion);
    }

    if (decision.route === "knowledge") {
      await this.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_knowledge_export_only", {
        markdownHotPath: false,
      });
      return this.attachDiagnostics({
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
    await this.recordPlannerAuditOnly(context, query, decision, "memory_retrieve_recent_tail", {
      recentTailCount: recentTail.length,
    });
    return this.attachDiagnostics({
      content: [{ type: "text", text: this.formatRecentTailText(query, recentTail) }],
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
    const query = this.getQuery(args);
    if (!query) {
      return this.buildMissingQueryResponse("oms_grep");
    }
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const limit = this.getNumberArg(args, "limit", 10);
    const contextTurns = this.getNumberArg(args, "contextTurns", 1);
    const scope = this.getScopeArg(args);
    const hits = runtimeStore.grepMessages(query, {
      sessionId: scope === "session" ? context.sessionId : undefined,
      limit,
      contextTurns,
    });
    return {
      content: [{
        type: "text",
        text: hits.length > 0
          ? hits.map((hit, index) => this.formatGrepHit(index + 1, hit)).join("\n\n---\n\n")
          : `No raw message hit found for query: ${query}`,
      }],
      details: {
        ok: true,
        query,
        scope,
        runtimeStore: runtimeStore.isEnabled() ? "sqlite" : "disabled",
        dbPath: runtimeStore.getPath(),
        hitCount: hits.length,
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
          dreaming: { enabled: false },
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
        "Disable OpenClaw memory-core, active-memory, memory-wiki, and dreaming so no Markdown-first fact source coexists with ChaunyOMS.",
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
    const { decision } = await this.resolveRetrievalDecision(query, context);
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

  private attachDiagnostics(
    response: ToolResponse,
    query: string,
    context: LifecycleContext,
    decision: RetrievalDecision,
    semanticExpansion: SemanticExpansionResult,
    promptForApi = false,
  ): ToolResponse {
    const configGuidance = this.payloadAdapter.describeConfigGuidance(context.config);
    return {
      ...response,
      details: {
        ...this.buildDiagnosticsEnvelope(
          query,
          context,
          decision,
          promptForApi,
          semanticExpansion,
          configGuidance.warnings,
        ),
        ...response.details,
      },
    };
  }

  private buildDiagnosticsEnvelope(
    query: string,
    context: LifecycleContext,
    decision: RetrievalDecision,
    promptForApi: boolean,
    semanticExpansion: SemanticExpansionResult,
    configWarnings: string[],
  ): Record<string, unknown> {
    return {
      ok: true,
      query,
      route: decision.route,
      retrievalLabel: this.describeRetrievalRoute(decision),
      reason: decision.reason,
      requiresEmbeddings: decision.requiresEmbeddings,
      requiresSourceRecall: decision.requiresSourceRecall,
      canAnswerDirectly: decision.canAnswerDirectly,
      routePlan: decision.routePlan,
      layerScores: decision.layerScores ?? [],
      explanation: decision.explanation,
      retrievalHitType: this.getRetrievalHitType(decision),
      matchedProjectId: decision.matchedProjectId ?? null,
      matchedProjectTitle: decision.matchedProjectTitle ?? null,
      shouldAutoRecall: this.shouldAutoRecall(decision, context),
      autoRecallReason: this.explainAutoRecall(decision, context),
      promptForApi,
      apiPrompt: null,
      autoRecallEnabled: context.config.autoRecallEnabled,
      retrievalStrength: context.config.retrievalStrength,
      usageFeedbackEnabled: context.config.usageFeedbackEnabled,
      retrievalEnhancements: this.buildRetrievalEnhancementDiagnostics(context.config),
      openClawNativeMode: context.config.openClawNativeMode,
      sourceTraceRequired: this.isSourceTraceRequired(decision, context),
      evidencePresentation: context.config.retrievalStrength === "forensic"
        ? "show_source_trace"
        : context.config.retrievalStrength === "strict"
          ? "show_when_needed"
          : "hidden_by_default",
      emergencyBrake: context.config.emergencyBrake,
      configPreset: context.config.configPreset,
      configWarnings,
      semanticCandidateExpansionEnabled: context.config.semanticCandidateExpansionEnabled,
      semanticCandidateLimit: context.config.semanticCandidateLimit,
      llmPlannerMode: context.config.llmPlannerMode,
      plannerDebugEnabled: context.config.plannerDebugEnabled,
      planner: decision.planner ?? null,
      plannerIntent: decision.planner?.intent.primary ?? null,
      plannerActivationMode: decision.planner?.activationMode ?? null,
      plannerSelectedPlan: decision.planner?.selectedPlan ?? "deterministic",
      plannerValidation: decision.planner?.validation ?? null,
      candidateExpansionMode:
        context.config.semanticCandidateExpansionEnabled
          ? semanticExpansion.ragSearch || semanticExpansion.graphSearch
            ? "planner_guided_rag_graph_plus_heuristic"
            : "heuristic_only"
          : "disabled",
      embeddingsReady: Boolean(semanticExpansion.ragSearch?.providerAvailable || semanticExpansion.ragSearch?.candidates.length),
      ragSearch: semanticExpansion.ragSearch ?? null,
      graphSearch: semanticExpansion.graphSearch ?? null,
      semanticCandidates: semanticExpansion.candidates.map((candidate) => ({
        kind: candidate.kind,
        id: candidate.id,
        title: candidate.title,
        score: candidate.score,
        reasons: candidate.reasons,
        authority: candidate.authority,
        sourceRoute: candidate.sourceRoute,
        requiresSourceRecall: candidate.requiresSourceRecall ?? false,
        matchedProjectId: candidate.matchedProjectId ?? null,
        matchedProjectTitle: candidate.matchedProjectTitle ?? null,
      })),
      semanticAuthorityAvailable: semanticExpansion.candidates.some(
        (candidate) => candidate.authority === "authoritative",
      ),
      semanticHintAvailable: false,
    };
  }

  private async collectSemanticExpansion(args: {
    query: string;
    context: LifecycleContext;
    decision: RetrievalDecision;
    runtimeStore: SQLiteRuntimeStore;
    allowIndexing?: boolean;
    memoryItems: MemoryItemEntry[];
    summaryHits: SummaryEntry[];
    projects: ProjectRecord[];
    matchedProject: ProjectRecord | null;
  }): Promise<SemanticExpansionResult> {
    const expansionEnabled = args.context.config.semanticCandidateExpansionEnabled;
    const shouldUseRag = args.context.config.ragEnabled &&
      args.context.config.ragProvider !== "none" &&
      args.decision.planner?.routeSteps.some((step) => step.layer === "rag_candidates") === true;
    const shouldUseGraph = args.context.config.graphEnabled &&
      args.context.config.graphProvider !== "none" &&
      args.decision.planner?.routeSteps.some((step) => step.layer === "graph_neighbors") === true;
    if (!expansionEnabled && !shouldUseRag && !shouldUseGraph) {
      return {
        candidates: [],
        memoryItemHits: [],
        summaryHits: [],
        projectHit: args.matchedProject,
      };
    }
    const terms = this.semanticTerms(args.query);
    const candidates: SemanticCandidate[] = [];
    const indexReport = (shouldUseRag || shouldUseGraph) && args.allowIndexing !== false
      ? args.runtimeStore.indexRetrievalEnhancements(args.context.config, {
          sessionId: args.context.sessionId,
          agentId: args.context.config.agentId,
        })
      : null;
    const ragSearch = shouldUseRag
      ? args.runtimeStore.searchVectorCandidates(args.query, args.context.config, {
          sessionId: args.context.sessionId,
          agentId: args.context.config.agentId,
          limit: args.context.config.vectorSearchMaxCandidates,
        })
      : undefined;
    const graphSearch = shouldUseGraph
      ? args.runtimeStore.searchGraphCandidates(args.query, args.context.config, {
          sessionId: args.context.sessionId,
          agentId: args.context.config.agentId,
          seedIds: ragSearch?.candidates
            .map((candidate) => typeof candidate.metadata?.sourceId === "string" ? `node:${candidate.metadata.sourceKind}:${candidate.metadata.sourceId}` : "")
            .filter(Boolean),
          limit: args.context.config.graphCandidateLimit,
        })
      : undefined;
    for (const search of [ragSearch, graphSearch].filter(Boolean) as RuntimeEnhancementSearchResult[]) {
      for (const candidate of search.candidates) {
        const sourceKind = typeof candidate.metadata?.sourceKind === "string"
          ? candidate.metadata.sourceKind
          : candidate.kind;
        candidates.push({
          kind: (candidate.kind === "raw_message"
            ? "summary"
            : candidate.kind === "evidence_atom"
              ? "memory_item"
              : candidate.kind) as SemanticCandidate["kind"],
          id: typeof candidate.metadata?.sourceId === "string" ? candidate.metadata.sourceId : candidate.id,
          title: candidate.title ?? candidate.content?.slice(0, 80) ?? candidate.id,
          score: candidate.score,
          reasons: [
            `${search.mode}:${candidate.reason}`,
            ...(indexReport?.warnings ?? []),
            ...(search.warnings ?? []),
          ],
          authority: candidate.sourceVerified ? "authoritative" : "hint",
          sourceRoute: "semantic_candidate_expansion",
          requiresSourceRecall: sourceKind === "summary",
          matchedProjectId: typeof candidate.metadata?.projectId === "string" ? candidate.metadata.projectId : undefined,
        });
      }
    }

    const memoryItemHits = [...args.memoryItems]
      .filter((entry) => entry.status === "active" && entry.contextPolicy !== "never")
      .map((entry) => ({
        entry,
        score: this.scoreMemoryItemEntry(entry, terms, args.query) +
          (args.matchedProject?.id && entry.projectId === args.matchedProject.id ? 4 : 0),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
      .slice(0, Math.max(args.context.config.semanticCandidateLimit, 1));
    for (const item of memoryItemHits) {
      const matchedProjectTitle = args.matchedProject && args.matchedProject.id === item.entry.projectId
        ? args.matchedProject.title
        : undefined;
      candidates.push({
        kind: "memory_item",
        id: item.entry.id,
        title: `[${item.entry.kind}] ${item.entry.text.slice(0, 72)}`,
        score: item.score,
        reasons: [
          `memory_item:${item.entry.kind}`,
          `source:${item.entry.sourceTable}`,
          `evidence:${item.entry.evidenceLevel}`,
          ...(args.matchedProject?.id && item.entry.projectId === args.matchedProject.id
            ? ["matched_project"]
            : []),
        ],
        authority: item.entry.inferred ? "hint" : "authoritative",
        sourceRoute: "semantic_candidate_expansion",
        matchedProjectId: item.entry.projectId,
        matchedProjectTitle,
      });
    }

    const summaryHits = [...args.summaryHits]
      .map((entry) => ({
        entry,
        score: this.scoreSummaryEntry(entry, terms, args.query),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.createdAt.localeCompare(left.entry.createdAt))
      .slice(0, Math.max(args.context.config.semanticCandidateLimit, 1));
    for (const item of summaryHits) {
      const matchedProjectTitle = args.matchedProject && args.matchedProject.id === item.entry.projectId
        ? args.matchedProject.title
        : undefined;
      candidates.push({
        kind: "summary",
        id: item.entry.id,
        title: item.entry.summary.slice(0, 80),
        score: item.score,
        reasons: [
          `summary_level:${item.entry.summaryLevel ?? 1}`,
          `memory_type:${item.entry.memoryType ?? "general"}`,
        ],
        authority: "authoritative",
        sourceRoute: "semantic_candidate_expansion",
        requiresSourceRecall: true,
        matchedProjectId: item.entry.projectId,
        matchedProjectTitle,
      });
    }

    const projectHit = args.matchedProject ?? this.matchProject(args.query, args.projects);
    if (projectHit) {
      const projectScore = this.scoreSemanticHaystack(
        [
          projectHit.title,
          projectHit.summary,
          projectHit.activeFocus,
          projectHit.currentDecision,
          projectHit.nextStep,
          projectHit.todo,
          projectHit.blocker,
          projectHit.risk,
          ...projectHit.tags,
        ].join(" "),
        terms,
        args.query,
      );
      if (projectScore > 0) {
        candidates.push({
          kind: "project_registry",
          id: projectHit.id,
          title: projectHit.title,
          score: projectScore + 2,
          reasons: ["project_registry", "matched_project_state"],
          authority: "authoritative",
          sourceRoute: "semantic_candidate_expansion",
          matchedProjectId: projectHit.id,
          matchedProjectTitle: projectHit.title,
        });
      }
    }

    return {
      candidates: [...candidates]
        .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
        .slice(0, Math.max(args.context.config.semanticCandidateLimit, 1)),
      memoryItemHits: memoryItemHits.map((item) => item.entry),
      summaryHits: summaryHits.map((item) => item.entry),
      projectHit,
      ragSearch,
      graphSearch,
    };
  }

  private emptySemanticExpansion(projectHit: ProjectRecord | null = null): SemanticExpansionResult {
    return {
      candidates: [],
      memoryItemHits: [],
      summaryHits: [],
      projectHit,
      ragSearch: undefined,
      graphSearch: undefined,
    };
  }

  private mergeEnhancementCandidatesIntoRecallResult(
    result: RecallResult,
    semanticExpansion: SemanticExpansionResult,
    tokenBudget: number,
  ): RecallResult {
    const existing = new Set(
      result.items.map((item) =>
        [
          item.kind,
          item.summaryId ?? item.metadata?.messageId ?? "",
          item.content.slice(0, 120),
        ].join("|"),
      ),
    );
    const enhancementCandidates = [
      ...(semanticExpansion.ragSearch?.candidates ?? []),
      ...(semanticExpansion.graphSearch?.candidates ?? []),
    ].sort((left, right) => right.score - left.score);
    const enhancementItems: ContextItem[] = [];
    let consumed = result.consumedTokens;
    for (const candidate of enhancementCandidates) {
      const content = candidate.content?.trim();
      if (!content) {
        continue;
      }
      const tokenCount = Math.max(candidate.tokenCount ?? estimateTokens(content), 1);
      if (consumed + tokenCount > tokenBudget) {
        break;
      }
      const sourceKind = typeof candidate.metadata?.sourceKind === "string"
        ? candidate.metadata.sourceKind
        : candidate.kind;
      const sourceId = typeof candidate.metadata?.sourceId === "string"
        ? candidate.metadata.sourceId
        : candidate.id;
      const key = ["enhancement", sourceKind, sourceId, content.slice(0, 120)].join("|");
      if (existing.has(key)) {
        continue;
      }
      existing.add(key);
      consumed += tokenCount;
      enhancementItems.push({
        kind: "summary",
        summaryId: candidate.kind === "summary" ? sourceId : undefined,
        tokenCount,
        content,
        metadata: {
          retrievalEnhancement: true,
          enhancementReason: candidate.reason,
          enhancementScore: candidate.score,
          sourceKind,
          sourceId,
          sourceVerified: candidate.sourceVerified === true,
          ...(candidate.metadata ?? {}),
        },
      });
    }
    if (enhancementItems.length === 0) {
      return result;
    }
    return {
      ...result,
      items: [...enhancementItems, ...result.items],
      consumedTokens: consumed,
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
    return ["off", "light", "auto", "strict", "forensic"].includes(value)
      ? value as RetrievalStrength
      : fallback;
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

  private resolveRecallPresentationOptions(args: unknown, retrievalStrength: RetrievalStrength): RecallPresentationOptions {
    const deepRecall = this.isRecord(args) && (args.deepRecall === true || args.qualityMode === true);
    const maxItems = this.getOptionalNumberArg(args, "maxItems");
    const maxCharsPerItem = this.getOptionalNumberArg(args, "maxCharsPerItem");
    const forcedTrace = retrievalStrength === "strict" || retrievalStrength === "forensic";
    return {
      maxItems: Math.max(1, Math.min(12, Math.floor(maxItems ?? (deepRecall ? 8 : 4)))),
      maxCharsPerItem: Math.max(240, Math.min(2000, Math.floor(maxCharsPerItem ?? (deepRecall ? 1200 : 700)))),
      includeFullTrace: forcedTrace || this.getBooleanArg(args, "debugTrace", false) || this.getBooleanArg(args, "verbose", false),
    };
  }

  private compactAnswerCandidates(
    candidates: AnswerCandidate[],
    presentation: RecallPresentationOptions,
  ): AnswerCandidate[] {
    if (presentation.includeFullTrace) {
      return candidates;
    }
    return candidates.slice(0, 5).map((candidate) => ({
      ...candidate,
      evidenceMessageIds: candidate.evidenceMessageIds.slice(0, 3),
    }));
  }

  private withPersistentEvidenceAtomHits(
    result: RecallResult,
    atoms: EvidenceAtomEntry[],
    recallBudget: number,
  ): RecallResult {
    if (atoms.length === 0) {
      return result;
    }
    const atomBudget = Math.max(300, Math.min(1600, Math.floor(recallBudget * 0.3)));
    const atomItems: ContextItem[] = [];
    let consumed = 0;
    for (const atom of atoms) {
      const item = this.buildPersistentEvidenceAtomItem(atom);
      if (consumed + item.tokenCount > atomBudget && atomItems.length > 0) {
        break;
      }
      atomItems.push(item);
      consumed += item.tokenCount;
    }
    if (atomItems.length === 0) {
      return result;
    }

    const existingAtomIds = new Set(
      result.items
        .map((item) => item.metadata?.atomId)
        .filter((value): value is string => typeof value === "string"),
    );
    const prependedItems = atomItems.filter((item) => {
      const atomId = item.metadata?.atomId;
      return typeof atomId !== "string" || !existingAtomIds.has(atomId);
    });
    if (prependedItems.length === 0) {
      return result;
    }

    return {
      ...result,
      items: [...prependedItems, ...result.items],
      consumedTokens: result.consumedTokens + prependedItems.reduce((sum, item) => sum + item.tokenCount, 0),
      sourceTrace: [
        ...prependedItems.map((item) => this.buildPersistentEvidenceAtomTrace(item)),
        ...result.sourceTrace,
      ],
      strategy: result.strategy ?? "summary_navigation",
    };
  }

  private buildPersistentEvidenceAtomItem(atom: EvidenceAtomEntry): ContextItem {
    const content = [
      `[evidence_atom:${atom.type}] ${atom.text}`,
      `sourceSummaryId: ${atom.sourceSummaryId}`,
      atom.sourceMessageIds && atom.sourceMessageIds.length > 0
        ? `sourceMessageIds: ${atom.sourceMessageIds.slice(0, 6).join(", ")}`
        : "",
    ].filter(Boolean).join("\n");
    return {
      kind: "summary",
      summaryId: atom.sourceSummaryId,
      tokenCount: Math.max(estimateTokens(content), 1),
      content,
      metadata: {
        atomId: atom.id,
        sessionId: atom.sessionId,
        evidenceAtom: atom.text,
        persistentEvidenceAtom: true,
        evidenceType: atom.type,
        sourceSummaryId: atom.sourceSummaryId,
        sourceBinding: atom.sourceBinding,
        sourceHash: atom.sourceHash,
        sourceMessageCount: atom.sourceMessageCount,
        sourceVerified: Boolean(atom.sourceBinding || atom.sourceHash),
        sourceMessageIds: atom.sourceMessageIds ?? [],
        confidence: atom.confidence,
        importance: atom.importance,
        stability: atom.stability,
        atomStatus: atom.atomStatus ?? "candidate",
        sourceTraceComplete: atom.sourceTraceComplete,
      },
    };
  }

  private buildPersistentEvidenceAtomTrace(item: ContextItem): SourceTrace {
    const sourceMessageIds = Array.isArray(item.metadata?.sourceMessageIds)
      ? item.metadata.sourceMessageIds.filter((value): value is string => typeof value === "string")
      : [];
    return {
      route: "summary_tree",
      summaryId: item.summaryId,
      sessionId: typeof item.metadata?.sessionId === "string" ? item.metadata.sessionId : "",
      strategy: sourceMessageIds.length > 0 ? "message_ids" : "none",
      verified: item.metadata?.sourceVerified === true,
      reason: "persistent_evidence_atom_hit",
      sourceHash: typeof item.metadata?.sourceHash === "string" ? item.metadata.sourceHash : undefined,
      sourceMessageCount: typeof item.metadata?.sourceMessageCount === "number" ? item.metadata.sourceMessageCount : undefined,
      resolvedMessageCount: sourceMessageIds.length,
      messageIds: sourceMessageIds,
    };
  }

  private queryNeedsRawSource(query: string): boolean {
    return /(quote|verbatim|exact wording|original text|raw source|source span|trace raw|原文|原话|逐字|引用|精确出处|源消息|源码片段)/i.test(query);
  }

  private evaluateEvidenceGate(
    query: string,
    items: ContextItem[],
    result: RecallResult,
  ): EvidenceGateResult {
    const atomHealth = this.evaluateAtomEvidenceHealth(items);
    const { atomHitCount, usableAtomCount } = atomHealth;
    const verifiedTraceCount = result.sourceTrace.filter((trace) => trace.verified).length;
    const verifiedAnswerCount = (result.answerCandidates ?? []).filter((candidate) => candidate.sourceVerified).length;
    if (items.length === 0 && verifiedAnswerCount === 0) {
      return {
        status: "insufficient",
        reason: "no selected context item or verified answer candidate",
        atomHitCount,
        usableAtomCount,
        verifiedTraceCount,
        recommendedAction: "no_answer",
        nextActionHint: "Do not answer from memory; ask a targeted clarification or report not found.",
        targetIds: [],
      };
    }
    if (this.queryNeedsRawSource(query)) {
      const targetIds = this.extractTraceTargetIds(items, result);
      return {
        status: verifiedTraceCount > 0 ? "sufficient" : "needs_expansion",
        reason: verifiedTraceCount > 0
          ? "raw-source-sensitive query has verified trace"
          : "raw-source-sensitive query should trace raw spans before answering",
        atomHitCount,
        usableAtomCount,
        verifiedTraceCount,
        recommendedAction: verifiedTraceCount > 0 ? "answer" : "trace_raw",
        nextActionHint: verifiedTraceCount > 0
          ? "Answer, but cite the traced source handle when precision matters."
          : "Call oms_trace/oms_expand on a listed atomId, summaryId, or messageId before answering.",
        targetIds,
      };
    }
    if (usableAtomCount > 0 || verifiedAnswerCount > 0) {
      return {
        status: "sufficient",
        reason: usableAtomCount > 0
          ? "selected context includes usable evidence atoms"
          : "selected answer candidates have verified source evidence",
        atomHitCount,
        usableAtomCount,
        verifiedTraceCount,
        recommendedAction: "answer",
        nextActionHint: "Answer from the selected evidence atoms; expand only if the user asks for exact wording.",
        targetIds: this.extractTraceTargetIds(items, result),
      };
    }
    if (atomHitCount > 0 && atomHealth.blockedReasons.length > 0) {
      const reason = `evidence atoms are not directly usable: ${[...new Set(atomHealth.blockedReasons)].join(", ")}`;
      return {
        status: verifiedTraceCount > 0 ? "needs_expansion" : "insufficient",
        reason,
        atomHitCount,
        usableAtomCount,
        verifiedTraceCount,
        recommendedAction: verifiedTraceCount > 0 ? "expand_l1" : "no_answer",
        nextActionHint: verifiedTraceCount > 0
          ? "Expand the listed summary/source before answering because the atom quality gate blocked direct use."
          : "Do not answer from blocked evidence atoms; run a narrower query or report not found.",
        targetIds: this.extractTraceTargetIds(items, result),
      };
    }
    if (verifiedTraceCount > 0) {
      return {
        status: "needs_expansion",
        reason: "verified summary/source trace exists, but no evidence atom was selected",
        atomHitCount,
        usableAtomCount,
        verifiedTraceCount,
        recommendedAction: "expand_l1",
        nextActionHint: "Expand the listed summaryId before making a specific claim.",
        targetIds: this.extractTraceTargetIds(items, result),
      };
    }
    return {
      status: "insufficient",
      reason: "selected hits are not source-verified enough for grounded answer",
      atomHitCount,
      usableAtomCount,
      verifiedTraceCount,
      recommendedAction: "no_answer",
      nextActionHint: "Do not answer from weak similarity alone; run a narrower query or report not found.",
      targetIds: this.extractTraceTargetIds(items, result),
    };
  }

  private evaluateAtomEvidenceHealth(items: ContextItem[]): AtomEvidenceHealth {
    const atomItems = items.filter((item) =>
      item.metadata?.persistentEvidenceAtom === true || item.metadata?.evidenceAtom === true || typeof item.metadata?.atomId === "string",
    );
    const blockedReasons: string[] = [];
    let usableAtomCount = 0;
    for (const item of atomItems) {
      const reasons = this.atomBlockReasons(item);
      if (reasons.length === 0) {
        usableAtomCount += 1;
      } else {
        blockedReasons.push(...reasons);
      }
    }
    return {
      atomHitCount: atomItems.length,
      usableAtomCount,
      blockedReasons,
    };
  }

  private atomBlockReasons(item: ContextItem): string[] {
    const reasons: string[] = [];
    const status = typeof item.metadata?.atomStatus === "string" ? item.metadata.atomStatus : "candidate";
    if (status === "conflicted" || status === "expired" || status === "superseded") {
      reasons.push(status);
    }
    if (item.metadata?.sourceTraceComplete === false || item.metadata?.sourceVerified === false) {
      reasons.push("source_trace_incomplete");
    }
    const confidence = typeof item.metadata?.confidence === "number" ? item.metadata.confidence : undefined;
    if (typeof confidence === "number" && confidence < 0.55) {
      reasons.push("low_confidence");
    }
    const stability = typeof item.metadata?.stability === "number" ? item.metadata.stability : undefined;
    if (typeof stability === "number" && stability < 0.35) {
      reasons.push("low_stability");
    }
    return reasons;
  }

  private extractTraceTargetIds(items: ContextItem[], result: RecallResult): string[] {
    const ids = new Set<string>();
    for (const item of items) {
      const atomId = item.metadata?.atomId;
      if (typeof atomId === "string" && atomId.trim()) {
        ids.add(`atom:${atomId}`);
      }
      const summaryId = item.summaryId ?? item.metadata?.sourceSummaryId;
      if (typeof summaryId === "string" && summaryId.trim()) {
        ids.add(`summary:${summaryId}`);
      }
      const messageId = item.metadata?.messageId;
      if (typeof messageId === "string" && messageId.trim()) {
        ids.add(`message:${messageId}`);
      }
    }
    for (const trace of result.sourceTrace) {
      if (trace.summaryId) {
        ids.add(`summary:${trace.summaryId}`);
      }
      for (const messageId of trace.messageIds ?? []) {
        ids.add(`message:${messageId}`);
        if (ids.size >= 8) {
          break;
        }
      }
      if (ids.size >= 8) {
        break;
      }
    }
    return [...ids].slice(0, 8);
  }

  private compactSourceTrace(sourceTrace: SourceTrace[]): Array<Record<string, unknown>> {
    return sourceTrace.slice(0, 6).map((trace) => ({
      route: trace.route,
      summaryId: trace.summaryId,
      strategy: trace.strategy,
      verified: trace.verified,
      reason: trace.reason,
      resolvedMessageCount: trace.resolvedMessageCount,
      turnStart: trace.turnStart,
      turnEnd: trace.turnEnd,
      sequenceMin: trace.sequenceMin,
      sequenceMax: trace.sequenceMax,
      messageIds: trace.messageIds?.slice(0, 3),
      messageIdCount: trace.messageIds?.length ?? 0,
    }));
  }

  private compactDagTrace(dagTrace: DagTraversalStep[]): Array<Record<string, unknown>> {
    return dagTrace.slice(0, 8).map((step) => ({
      summaryId: step.summaryId,
      summaryLevel: step.summaryLevel,
      nodeKind: step.nodeKind,
      score: step.score,
      action: step.action,
      reasons: step.reasons.slice(0, 6),
      childCount: step.childSummaryIds?.length ?? 0,
    }));
  }

  private planRecallItems(
    query: string,
    result: RecallResult,
    retrievalBudget: RetrievalBudgetPlan,
    config: LifecycleContext["config"] = DEFAULT_BRIDGE_CONFIG,
    decision?: RetrievalDecision,
  ): {
    items: ContextItem[];
    consumedTokens: number;
    plan: ReturnType<ContextPlanner["plan"]>;
    rerankAudit: RerankAudit;
  } {
    const answerEvidenceIds = new Set((result.answerCandidates ?? []).flatMap((candidate) => candidate.evidenceMessageIds));
    const recallItems = result.items.map((item) =>
      this.buildBudgetAwareRecallItem(query, item, this.layerPerItemBudget(this.classifyRecallLayer(item), retrievalBudget)),
    );
    const candidates = recallItems.map((item, index) => {
      const source = this.contextSourceForRecallItem(item, result);
      const candidate = this.contextPlanner.buildCandidate(item, source, index);
      const messageId = typeof item.metadata?.messageId === "string" ? item.metadata.messageId : null;
      if (messageId && answerEvidenceIds.has(messageId)) {
        candidate.score += 120;
        candidate.reasons.push("answer_evidence");
      }
      const layer = this.classifyRecallLayer(item);
      if (layer === "atom") {
        candidate.score += 40;
        candidate.reasons.push("evidence_atom_first");
      } else if (layer === "raw" && this.queryNeedsRawSource(query)) {
        candidate.score += 30;
        candidate.reasons.push("raw_source_requested");
      }
      return candidate;
    });
    const forceRerank = Boolean(decision?.planner?.routeSteps.some((step) => step.layer === "rerank" && step.action === "order"));
    const reranker = this.deterministicReranker ?? new DeterministicReranker();
    const reranked = reranker.rerank(
      candidates.map((candidate) => ({
        id: candidate.id,
        lane: this.classifyRecallLayer(candidate.item),
        score: candidate.score,
        sourceVerified: candidate.authority === "raw_evidence" || candidate.authority === "source_backed_summary",
        authority: candidate.authority,
        tokenCount: candidate.item.tokenCount,
        payload: candidate,
      })),
      config,
      {
        force: forceRerank,
        strictConflict: this.hasStrictCandidateConflict(config.retrievalStrength, result),
      },
    );
    const orderedCandidates = reranked.candidates.map((candidate) => ({
      ...candidate.payload,
      reasons: reranked.audit.used
        ? [...candidate.payload.reasons, `rerank:${reranked.audit.provider}`]
        : candidate.payload.reasons,
    }));
    const layerLimitedCandidates = this.applyRecallLayerBudgets(orderedCandidates, retrievalBudget);
    const plan = this.contextPlanner.plan(layerLimitedCandidates, { budget: retrievalBudget.total });
    return {
      items: plan.selected.map((candidate) => candidate.item),
      consumedTokens: plan.selectedTokens,
      plan,
      rerankAudit: reranked.audit,
    };
  }

  private hasStrictCandidateConflict(retrievalStrength: RetrievalStrength, result: RecallResult): boolean {
    if (retrievalStrength !== "strict" && retrievalStrength !== "forensic") {
      return false;
    }
    const sourceBackedAnswers = (result.answerCandidates ?? [])
      .filter((candidate) => candidate.sourceVerified)
      .map((candidate) => candidate.text.trim().toLowerCase())
      .filter(Boolean);
    return new Set(sourceBackedAnswers).size > 1;
  }

  private contextSourceForRecallItem(
    item: ContextItem,
    result: RecallResult,
  ): "active_memory" | "summary_context" | "raw_exact_search" {
    const layer = this.classifyRecallLayer(item);
    if (layer === "atom") {
      return "active_memory";
    }
    if (layer === "raw" || result.strategy === "raw_first") {
      return "raw_exact_search";
    }
    return "summary_context";
  }

  private classifyRecallLayer(item: ContextItem): RecallLayer {
    if (item.metadata?.persistentEvidenceAtom === true || item.metadata?.evidenceAtom === true || typeof item.metadata?.atomId === "string") {
      return "atom";
    }
    if (item.kind !== "summary") {
      return "raw";
    }
    return "summary";
  }

  private applyRecallLayerBudgets(
    candidates: ReturnType<ContextPlanner["buildCandidate"]>[],
    retrievalBudget: RetrievalBudgetPlan,
  ): ReturnType<ContextPlanner["buildCandidate"]>[] {
    const used: Record<RecallLayer, number> = { atom: 0, summary: 0, raw: 0 };
    const selected: ReturnType<ContextPlanner["buildCandidate"]>[] = [];
    const sorted = [...candidates].sort((left, right) =>
      right.score - left.score ||
      Math.max(left.item.tokenCount, 0) - Math.max(right.item.tokenCount, 0),
    );

    for (const candidate of sorted) {
      const layer = this.classifyRecallLayer(candidate.item);
      const layerBudget = retrievalBudget[layer];
      const tokenCount = Math.max(candidate.item.tokenCount, 0);
      if (layerBudget > 0 && used[layer] + tokenCount > layerBudget && used[layer] > 0) {
        continue;
      }
      used[layer] += tokenCount;
      selected.push(candidate);
    }

    const selectedIds = new Set(selected.map((candidate) => candidate.id));
    return candidates.filter((candidate) => selectedIds.has(candidate.id));
  }

  private layerPerItemBudget(layer: RecallLayer, retrievalBudget: RetrievalBudgetPlan): number {
    return retrievalBudget.perItem[layer];
  }

  private buildBudgetAwareRecallItem(query: string, item: ContextItem, recallBudget: number): ContextItem {
    const tokenCount = Math.max(item.tokenCount, estimateTokens(String(item.content ?? "")), 1);
    const snippetBudget = Math.max(256, Math.min(recallBudget, Math.floor(recallBudget * 0.8)));
    if (tokenCount <= snippetBudget) {
      return item;
    }

    const content = String(item.content ?? "");
    const excerpt = this.buildRecallExcerpt(query, content, snippetBudget);
    const marker = "\n\n[chaunyoms: evidence snippet; use oms_expand/oms_trace with the listed id for the full source]";
    const snippet = `${excerpt}${marker}`;
    return {
      ...item,
      tokenCount: Math.max(estimateTokens(snippet), 1),
      content: snippet,
      metadata: {
        ...(item.metadata ?? {}),
        recallSnippet: true,
        originalTokenCount: tokenCount,
      },
    };
  }

  private buildRecallExcerpt(query: string, content: string, tokenBudget: number): string {
    const normalizedBudget = Math.max(1, Math.floor(tokenBudget));
    if (estimateTokens(content) <= normalizedBudget) {
      return content;
    }

    const charBudget = Math.max(400, Math.floor(content.length * (normalizedBudget / Math.max(estimateTokens(content), 1))));
    const anchor = this.findBestExcerptAnchor(query, content);
    const start = Math.max(0, anchor - Math.floor(charBudget / 2));
    const end = Math.min(content.length, start + charBudget);
    let excerpt = content.slice(start, end);
    while (excerpt.length > 1 && estimateTokens(excerpt) > normalizedBudget) {
      const trim = Math.max(1, Math.floor(excerpt.length * 0.08));
      excerpt = excerpt.slice(trim, Math.max(trim + 1, excerpt.length - trim));
    }
    const prefix = start > 0 ? "... " : "";
    const suffix = end < content.length ? " ..." : "";
    return `${prefix}${excerpt.trim()}${suffix}`;
  }

  private findBestExcerptAnchor(query: string, content: string): number {
    const lower = content.toLowerCase();
    const terms = this.queryTerms(query)
      .filter((term) => term.length >= 3)
      .sort((left, right) => right.length - left.length);
    for (const term of terms) {
      const index = lower.indexOf(term.toLowerCase());
      if (index >= 0) {
        return index;
      }
    }
    return Math.max(0, content.length - 1);
  }

  private resolveRecallBudget(args: unknown, totalBudget: number): number {
    return this.resolveRetrievalBudgetPlan(args, totalBudget).total;
  }

  private resolveRetrievalBudgetPlan(args: unknown, totalBudget: number): RetrievalBudgetPlan {
    const budget = this.isRecord(args) ? args.budget : undefined;
    const deepRecall = this.isRecord(args) && (args.deepRecall === true || args.qualityMode === true);
    const maxAutomaticBudget = deepRecall
      ? Math.min(totalBudget * 0.05, 10000)
      : Math.min(totalBudget * 0.015, 3000);
    const resolvedBudget = typeof budget === "number" && Number.isFinite(budget)
      ? Math.min(budget, totalBudget * 0.1, 20000)
      : maxAutomaticBudget;
    const total = Math.max(256, Math.floor(resolvedBudget));
    const atom = Math.max(80, Math.min(deepRecall ? 3000 : 1600, Math.floor(total * (deepRecall ? 0.35 : 0.42))));
    let raw = Math.max(80, Math.min(deepRecall ? 4500 : 1800, Math.floor(total * (deepRecall ? 0.35 : 0.28))));
    let summary = total - atom - raw;
    if (summary < 80) {
      raw = Math.max(40, raw - (80 - summary));
      summary = total - atom - raw;
    }
    return {
      total,
      atom,
      summary,
      raw,
      perItem: {
        atom: Math.max(120, Math.min(atom, deepRecall ? 420 : 260)),
        summary: Math.max(240, Math.min(summary, deepRecall ? 1400 : 800)),
        raw: Math.max(300, Math.min(raw, deepRecall ? 1600 : 900)),
      },
    };
  }

  private resolveRawFtsHintLimit(args: unknown): number {
    const deepRecall = this.isRecord(args) && (args.deepRecall === true || args.qualityMode === true);
    const defaultLimit = deepRecall ? 48 : 16;
    const explicit = this.getOptionalNumberArg(args, "rawFtsLimit");
    if (typeof explicit === "number") {
      const floor = deepRecall ? defaultLimit : 1;
      return Math.max(floor, Math.min(100, Math.floor(explicit)));
    }
    return defaultLimit;
  }

  private getScopeArg(args: unknown): "session" | "agent" {
    const value = this.getStringArg(args, "scope").toLowerCase();
    return value === "session" ? "session" : "agent";
  }

  private shouldUseFtsRecallHints(args: unknown, context: LifecycleContext): boolean {
    if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
      return false;
    }
    if (this.isRecord(args) && args.rawFts === false) {
      return false;
    }
    return true;
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

  private buildPlannerValidationBlockedResponse(
    query: string,
    decision: RetrievalDecision,
  ): ToolResponse {
    const violations = decision.planner?.validation.violations ?? [];
    return {
      content: [{
        type: "text",
        text: [
          `PlanValidator blocked retrieval for: ${query}`,
          "The planner produced a hard-boundary violation, so OMS refused to execute the unsafe plan or fall back to an unsupported answer.",
          violations.length > 0
            ? `Violations: ${violations.map((violation) => `${violation.severity}:${violation.code}`).join(", ")}`
            : "Violations: unknown",
        ].join("\n"),
      }],
      details: {
        ok: false,
        route: decision.route,
        query,
        retrievalHitType: "planner_validation_blocked",
        evidencePresentation: "no_answer",
        hitCount: 0,
        blockedBy: "PlanValidator",
        planner: decision.planner ?? null,
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        fallbackTrace: [{
          from: decision.route,
          to: "none",
          reason: "plan_validator_safe_no_answer",
        }],
      },
    };
  }

  private isRetrievalVerifierBlocked(result: RetrievalVerificationResult): boolean {
    return (result.sourceTraceRequired || result.fullRawTraceRequired) && result.status !== "sufficient";
  }

  private buildRetrievalVerifierBlockedResponse(
    query: string,
    decision: RetrievalDecision,
    recallResult: RecallResult,
    retrievalVerification: RetrievalVerificationResult,
    evidenceGate: EvidenceGateResult,
    diagnostics: {
      retrievalBudget: RetrievalBudgetPlan;
      persistentEvidenceAtomHitCount: number;
      transientEvidenceAtomHitCount: number;
    },
    progressiveRetrievalSteps: ProgressiveRetrievalStepRecord[],
  ): ToolResponse {
    return {
      content: [{
        type: "text",
        text: [
          `Retrieval verifier blocked final answer for: ${query}`,
          `Status: ${retrievalVerification.status}; action: ${retrievalVerification.recommendedAction}`,
          `Reason: ${retrievalVerification.reason}`,
          "No unsupported MemoryItem, summary, or trace-only content is returned as a final fact.",
        ].join("\n"),
      }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        hitCount: 0,
        blockedHitCount: recallResult.items.length,
        retrievalHitType: "insufficient_source_evidence",
        evidencePresentation: "no_answer",
        autoRecall: true,
        autoRecallReason: "retrieval_verifier_requires_source_evidence",
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        evidenceGate,
        retrievalVerification,
        sourceTrace: this.compactSourceTrace(recallResult.sourceTrace),
        answerCandidates: this.compactAnswerCandidates(recallResult.answerCandidates ?? [], {
          maxItems: 3,
          maxCharsPerItem: 200,
          includeFullTrace: false,
        }),
        retrievalBudget: diagnostics.retrievalBudget,
        persistentEvidenceAtomHitCount: diagnostics.persistentEvidenceAtomHitCount,
        transientEvidenceAtomHitCount: diagnostics.transientEvidenceAtomHitCount,
        progressiveRetrievalSteps,
        fallbackTrace: [{
          from: decision.route,
          to: "none",
          reason: "retrieval_verifier_insufficient_source_evidence",
        }],
      },
    };
  }

  private buildProgressiveRetrievalSteps(args: PlannerAuditContext): ProgressiveRetrievalStepRecord[] {
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

  private async recordPlannerAuditOnly(
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

  private async resolveRetrievalDecision(
    query: string,
    context: LifecycleContext,
  ): Promise<{ decision: RetrievalDecision }> {
    const { rawStore, summaryStore, projectStore } = await this.runtime.getSessionStores(context);
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const projects = projectStore.getAll().filter((project) => project.status !== "archived");
    const matchedProject = this.matchProject(query, projects);
    const scopedMemoryItemHits = this.shouldProbeMemoryItems(query)
      ? this.searchMemoryItemHits(
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
      },
    });
    const validation = this.planValidator.validate(plannerResult.plan);
    const usePlanner =
      context.config.llmPlannerMode === "auto" &&
      plannerResult.plan.activation.mode === "llm_planner" &&
      validation.accepted;
    const decision = this.retrievalRuntime.decisionFromPlan({
      plan: plannerResult.plan,
      validation,
      deterministicDecision,
      usePlanner,
    });
    return {
      decision,
    };
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

  private hasRecentAssistantUncertainty(rawStore: { getAll(): Array<{ role: string; content: string }> }): boolean {
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
    if (items.length === 0) {
      if (answerCandidates.length === 0) {
        return `No matching historical details found for query: ${query}`;
      }
    }
    const answers = answerCandidates.length > 0
      ? [
          "Answer candidates:",
          ...answerCandidates.slice(0, 5).map((candidate, index) =>
            `${index + 1}. ${candidate.text} (${candidate.type}, confidence=${candidate.confidence}, sourceVerified=${candidate.sourceVerified})`,
          ),
          "",
        ].join("\n")
      : "";
    const gate = evidenceGate
      ? [
          `Evidence gate: ${evidenceGate.status}`,
          `Reason: ${evidenceGate.reason}`,
          `Usable atoms: ${evidenceGate.usableAtomCount}/${evidenceGate.atomHitCount}`,
          `Recommended action: ${evidenceGate.recommendedAction}`,
          evidenceGate.nextActionHint ? `Next action hint: ${evidenceGate.nextActionHint}` : "",
          evidenceGate.targetIds.length > 0 ? `Trace targets: ${evidenceGate.targetIds.join(", ")}` : "",
          "",
        ].filter((line) => line.length > 0).join("\n")
      : "";
    const budget = diagnostics.retrievalBudget
      ? [
          "Retrieval budget:",
          `- total=${diagnostics.retrievalBudget.total}, atom=${diagnostics.retrievalBudget.atom}, summary=${diagnostics.retrievalBudget.summary}, raw=${diagnostics.retrievalBudget.raw}`,
          `- per item: atom=${diagnostics.retrievalBudget.perItem.atom}, summary=${diagnostics.retrievalBudget.perItem.summary}, raw=${diagnostics.retrievalBudget.perItem.raw}`,
          `- persistent atoms=${diagnostics.persistentEvidenceAtomHitCount ?? 0}, transient atoms=${diagnostics.transientEvidenceAtomHitCount ?? 0}`,
          "",
        ].join("\n")
      : "";
    const verifier = diagnostics.retrievalVerification
      ? [
          "Retrieval verifier:",
          `- status=${diagnostics.retrievalVerification.status}, action=${diagnostics.retrievalVerification.recommendedAction}`,
          `- sourceTraceStatus=${diagnostics.retrievalVerification.sourceTraceStatus}, verifiedTrace=${diagnostics.retrievalVerification.verifiedTraceCount}, completeRawTrace=${diagnostics.retrievalVerification.completeRawTraceCount}`,
          `- reason=${diagnostics.retrievalVerification.reason}`,
          "",
        ].join("\n")
      : "";
    const summaryItems = items.filter((item) => item.kind === "summary");
    const messageItems = items
      .filter((item) => item.kind !== "summary")
      .sort((left, right) => this.scoreRecallDisplayItem(right, query) - this.scoreRecallDisplayItem(left, query));
    const localMatches = this.buildLocalSourceMatches(messageItems, query).slice(0, 3);
    const summaryBudget = Math.min(2, Math.max(1, Math.floor(presentation.maxItems / 2)));
    const messageBudget = Math.max(1, presentation.maxItems - summaryBudget);
    const visibleItems = messageItems.length > 0
      ? [
          ...messageItems.slice(0, messageBudget),
          ...summaryItems.slice(0, summaryBudget),
        ].slice(0, presentation.maxItems)
      : summaryItems.slice(0, presentation.maxItems);
    const localMatchText = localMatches.length > 0
      ? [
          "Top local source matches (prefer these over broad multi-dossier summaries):",
          ...localMatches.map((match, index) =>
            `${index + 1}. ${match.slug ? `slug ${match.slug}` : "no slug anchor"} at turn ${match.turnNumber ?? "?"} score=${match.score}${match.roles.length > 0 ? ` roles=${match.roles.slice(0, 3).join(",")}` : ""}: ${this.truncateText(match.excerpt, 260)}`,
          ),
          "",
        ].join("\n")
      : "";
    const messages = visibleItems
      .map(
        (item) => {
          const label = item.kind === "summary"
            ? item.metadata?.persistentEvidenceAtom === true
              ? `[evidence atom ${item.metadata.atomId ?? "?"}]`
              : `[summary ${item.summaryId ?? "?"}]`
            : `[turn ${(item.turnNumber as number | undefined) ?? "?"}] ${(item.role as string | undefined) ?? "user"}`;
          return `${label}: ${this.truncateText(String(item.content ?? ""), presentation.maxCharsPerItem)}`;
        },
      )
      .join("\n\n");
    const omitted = items.length > visibleItems.length
      ? `\n\n... ${items.length - visibleItems.length} more hit(s) omitted. Use oms_expand with a listed summaryId/messageId, or call memory_retrieve with deepRecall=true for a wider pull.`
      : "";
    const traces = sourceTrace.length > 0
      ? [
          "",
          "Source trace:",
          ...sourceTrace.slice(0, presentation.includeFullTrace ? sourceTrace.length : 6).map((trace) =>
            `- summary ${trace.summaryId ?? "?"} -> ${trace.strategy} -> ${trace.verified ? "verified" : "unverified"} (${trace.resolvedMessageCount} messages)`,
          ),
          ...(!presentation.includeFullTrace && sourceTrace.length > 6 ? [`- ... ${sourceTrace.length - 6} more source trace node(s) omitted`] : []),
        ].join("\n")
      : "";
    return [
      `Historical source hits for: ${query}`,
      "",
      answers,
      gate,
      budget,
      verifier,
      localMatchText,
      messages,
      omitted,
      traces,
    ].filter(Boolean).join("\n");
  }

  private truncateText(value: string, maxChars: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd()} ... [truncated]`;
  }

  private scoreRecallDisplayItem(item: ContextItem, query: string): number {
    const content = String(item.content ?? "").toLowerCase();
    const terms = this.queryTerms(query);
    let score = 0;
    for (const term of terms) {
      if (content.includes(term.toLowerCase())) {
        score += term.length >= 6 ? 4 : 2;
      }
    }
    const anchors = query.match(/\b[A-Z][A-Z0-9_]{2,}\b|\b\d{2,}\b/g) ?? [];
    for (const anchor of anchors) {
      if (String(item.content ?? "").includes(anchor)) {
        score += 8;
      }
    }
    score += scoreIntentRoleMatch(query, String(item.content ?? "")).score;
    return score;
  }

  private buildLocalSourceMatches(
    messageItems: ContextItem[],
    query: string,
  ): Array<{ slug: string | null; turnNumber: number | undefined; score: number; roles: string[]; excerpt: string }> {
    return messageItems
      .map((item) => {
        const content = String(item.content ?? "");
        const roleMatch = scoreIntentRoleMatch(query, content);
        return {
          slug: this.extractBestSlugAnchor(content, query),
          turnNumber: typeof item.turnNumber === "number" ? item.turnNumber : undefined,
          score: this.scoreRecallDisplayItem(item, query),
          roles: roleMatch.roles,
          excerpt: content,
        };
      })
      .filter((match) => match.score > 0 || match.slug !== null)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.slug && !right.slug) {
          return -1;
        }
        if (!left.slug && right.slug) {
          return 1;
        }
        return (left.turnNumber ?? Number.MAX_SAFE_INTEGER) - (right.turnNumber ?? Number.MAX_SAFE_INTEGER);
      });
  }

  private extractBestSlugAnchor(content: string, query: string): string | null {
    const explicitSlug = content.match(/(?:^|\||\b)slug\s*(?:\||:|=)\s*`?(\d{2}_[a-z0-9_]+)`?/i)?.[1];
    if (explicitSlug) {
      return explicitSlug;
    }
    const slugs = [...new Set(content.match(/\b\d{2}_[a-z0-9_]+\b/gi) ?? [])];
    if (slugs.length === 0) {
      return null;
    }
    if (slugs.length === 1) {
      return slugs[0];
    }
    const terms = this.queryTerms(query);
    const windows = slugs.map((slug) => {
      const index = content.toLowerCase().indexOf(slug.toLowerCase());
      const start = Math.max(0, index - 500);
      const end = Math.min(content.length, index + 500);
      const window = content.slice(start, end).toLowerCase();
      const score = terms.reduce((sum, term) => sum + (window.includes(term.toLowerCase()) ? (term.length >= 6 ? 4 : 2) : 0), 0);
      return { slug, score };
    });
    return windows.sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))[0]?.slug ?? slugs[0];
  }

  private shouldProbeMemoryItems(query: string): boolean {
    return /(current|latest|now|currently|updated|correction|after correction|exact|parameter|constraint|decision|rule|setting|config|remember|must|当前|最新|修正后|参数|约束|决策|规则|配置|记住)/i.test(query);
  }

  private formatMemoryItemText(query: string, items: MemoryItemEntry[]): string {
    return [
      `MemoryItem hits for: ${query}`,
      ...items.map((item, index) =>
        `${index + 1}. [${item.kind}/${item.sourceTable}] ${item.content ?? item.text}`),
    ].join("\n");
  }

  private formatRecentTailText(
    query: string,
    items: Array<{ turnNumber: number; role: string; content: string }>,
  ): string {
    if (items.length === 0) {
      return `No standard retrieval hit found for query: ${query}`;
    }
    return [
      `Recent context for: ${query}`,
      ...items.map((item) => `[turn ${item.turnNumber}] ${item.role}: ${item.content}`),
    ].join("\n\n");
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

  private formatGrepHit(index: number, hit: OmsGrepHit): string {
    const before = hit.before.map((message) =>
      `  before [turn ${message.turnNumber}] ${message.role}: ${message.content}`,
    );
    const after = hit.after.map((message) =>
      `  after [turn ${message.turnNumber}] ${message.role}: ${message.content}`,
    );
    return [
      `${index}. [score ${hit.score}] [turn ${hit.message.turnNumber}] ${hit.message.role} ${hit.message.id}`,
      hit.message.content,
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
      ? `${this.formatMemoryItemText(query, memoryItemHits)}\n\nSource recall is currently disabled by safety policy.`
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
      context.config.retrievalStrength === "strict" ||
      context.config.retrievalStrength === "forensic";
  }

  private isHardSourceTraceRequired(context: LifecycleContext): boolean {
    return context.config.retrievalStrength === "strict" ||
      context.config.retrievalStrength === "forensic";
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

  private matchProject(query: string, projects: ProjectRecord[]): ProjectRecord | null {
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

}
