import { ContextPlanner } from "../engines/ContextPlanner";
import { MemoryRetrievalRouter } from "../routing/MemoryRetrievalRouter";
import { RecallResolver } from "../resolvers/RecallResolver";
import {
  AnswerCandidate,
  ContextItem,
  DurableMemoryEntry,
  FixedPrefixProvider,
  KnowledgeDocumentIndexEntry,
  KnowledgeRepository,
  ProjectRecord,
  RecallResult,
  RetrievalDecision,
  SemanticCandidate,
  SummaryEntry,
} from "../types";
import {
  LifecycleContext,
  OpenClawPayloadAdapter,
} from "../host/OpenClawPayloadAdapter";
import { ChaunyomsSessionRuntime } from "./ChaunyomsSessionRuntime";
import { OmsExpandResult, OmsGrepHit } from "../data/SQLiteRuntimeStore";

interface ToolResponse {
  content: Array<Record<string, unknown>>;
  details: Record<string, unknown>;
}

interface SemanticExpansionResult {
  candidates: SemanticCandidate[];
  knowledgeHits: KnowledgeDocumentIndexEntry[];
  durableHits: DurableMemoryEntry[];
  summaryHits: SummaryEntry[];
  projectHit: ProjectRecord | null;
}

export interface RetrievalLayerDependencies {
  fixedPrefixProvider: FixedPrefixProvider;
}

export class ChaunyomsRetrievalService {
  private readonly contextPlanner = new ContextPlanner();
  private readonly recallResolver = new RecallResolver();
  private readonly retrievalRouter = new MemoryRetrievalRouter();
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
    const query = this.getQuery(args);
    const { decision } = await this.resolveRetrievalDecision(query, context);
    const semanticExpansion = await this.collectSemanticExpansion({
      query,
      context,
      decision,
      durableEntries: stores.durableMemoryStore.getAll(),
      knowledgeHits: stores.knowledgeStore.searchRelatedDocuments(
        query,
        context.config.semanticCandidateLimit,
      ),
      summaryHits: stores.summaryStore.search(query, { sessionId: context.sessionId }),
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
    const context = this.resolveContext(args);
    const { rawStore, summaryStore, durableMemoryStore, projectStore, knowledgeStore } = await this.runtime.getSessionStores(context);
    const query = this.getQuery(args);
    if (!query) {
      return this.buildMissingQueryResponse("memory_retrieve");
    }

    const { decision } = await this.resolveRetrievalDecision(query, context);
    const activeProjects = projectStore.getAll().filter((project) => project.status !== "archived");
    const matchedProject = this.matchProject(query, activeProjects);
    const emptyExpansion = this.emptySemanticExpansion(matchedProject);
    const durableHits = decision.route === "durable_memory" ||
      ((decision.requiresSourceRecall || decision.route === "summary_tree") &&
        (!context.config.autoRecallEnabled || context.config.emergencyBrake))
      ? this.searchDurableHits(
        durableMemoryStore.getAll(),
        query,
        matchedProject?.id,
        3,
      )
      : [];

    if ((decision.requiresSourceRecall || decision.route === "summary_tree") && (!context.config.autoRecallEnabled || context.config.emergencyBrake)) {
      return this.attachDiagnostics(
        this.buildRecallDisabledResponse(query, durableHits, context, decision),
        query,
        context,
        decision,
        emptyExpansion,
      );
    }

    if (decision.route === "project_registry") {
      const project = this.matchProject(query, projectStore.getAll());
      return this.attachDiagnostics(
        this.buildProjectRegistryResult(project, decision, query),
        query,
        context,
        decision,
        emptyExpansion,
      );
    }

    if (decision.route === "durable_memory" && durableHits.length > 0) {
      return this.attachDiagnostics({
        content: [{ type: "text", text: this.formatDurableMemoryText(query, durableHits) }],
        details: {
          ok: true,
          route: decision.route,
          routePlan: decision.routePlan,
          layerScores: decision.layerScores ?? [],
          explanation: decision.explanation,
          retrievalLabel: this.describeRetrievalRoute(decision),
          query,
          hitCount: durableHits.length,
          retrievalHitType: "durable_memory",
          autoRecall: false,
          autoRecallReason: null,
          matchedProjectId: decision.matchedProjectId ?? null,
          matchedProjectTitle: decision.matchedProjectTitle ?? null,
        },
      }, query, context, decision, emptyExpansion);
    }

    const shouldCheckKnowledge = decision.route === "knowledge" ||
      (decision.route === "recent_tail" && this.shouldProbeKnowledgeFallback(query, context));
    const managedKnowledgeHits = shouldCheckKnowledge
      ? knowledgeStore.searchRelatedDocuments(query, 6)
      : [];
    const knowledgeExpansion = managedKnowledgeHits.length > 0
      ? await this.collectSemanticExpansion({
        query,
        context,
        decision,
        durableEntries: [],
        knowledgeHits: managedKnowledgeHits,
        summaryHits: [],
        projects: [],
        matchedProject,
      })
      : emptyExpansion;

    if (decision.route === "knowledge" && managedKnowledgeHits.length > 0) {
      return this.attachDiagnostics(
        await this.buildUnifiedKnowledgeResult(
          query,
          knowledgeStore,
          managedKnowledgeHits,
          decision,
        ),
        query,
        context,
        decision,
        knowledgeExpansion,
      );
    }

    if (decision.route === "recent_tail" && managedKnowledgeHits.length > 0) {
      const result = await this.buildUnifiedKnowledgeResult(
        query,
        knowledgeStore,
        managedKnowledgeHits,
        decision,
      );
      return this.attachDiagnostics({
        ...result,
        details: {
          ...result.details,
          fallbackTrace: [{
            from: decision.route,
            to: "knowledge",
            reason: "reviewed_knowledge_candidate_hit",
          }],
        },
      }, query, context, decision, knowledgeExpansion);
    }

    if (this.shouldAutoRecall(decision, context)) {
      if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
        return this.attachDiagnostics(
          this.buildRecallDisabledResponse(query, durableHits, context, decision),
          query,
          context,
          decision,
          emptyExpansion,
        );
      }

      const rawFtsHints = this.shouldUseFtsRecallHints(args, context)
        ? (await this.runtime.getRuntimeStore(context)).grepMessages(query, {
            sessionId: context.sessionId,
            limit: this.resolveRawFtsHintLimit(args),
            contextTurns: 0,
          })
        : [];
      const recallBudget = this.resolveRecallBudget(args, context.totalBudget);
      const rawFtsMessageIds = rawFtsHints.map((hit) => hit.message.id);
      const result = this.recallResolver.resolve(query, summaryStore, rawStore, recallBudget, {
        sessionId: context.sessionId,
        rawHintMessageIds: rawFtsMessageIds,
        rawCandidateMessageIds: rawFtsMessageIds,
      });
      const planned = this.planRecallItems(result, recallBudget);
      await this.runtime.recordRetrievalPlan(context, "memory_retrieve", planned.plan, recallBudget);
      return this.attachDiagnostics({
        content: [{ type: "text", text: this.formatRecallText(query, planned.items, result.sourceTrace, result.answerCandidates) }],
        details: {
          ok: true,
          route: decision.route,
          retrievalLabel: this.describeRetrievalRoute(decision),
          query,
          consumedTokens: planned.consumedTokens,
          hitCount: planned.items.length,
          retrievalHitType: result.strategy === "raw_first" ? "raw_history_recall" : "summary_tree_recall",
          recallStrategy: result.strategy ?? "summary_navigation",
          rawCandidateCount: result.rawCandidateCount ?? 0,
          rawFtsHintCount: rawFtsHints.length,
          answerCandidates: result.answerCandidates ?? [],
          autoRecall: true,
          autoRecallReason: this.explainAutoRecall(decision, context),
          routePlan: decision.routePlan,
          layerScores: decision.layerScores ?? [],
          explanation: decision.explanation,
          dagTrace: result.dagTrace,
          sourceTrace: result.sourceTrace,
          plannerRunId: planned.plan.runId,
          plannerRejectedCount: planned.plan.rejected.length,
        },
      }, query, context, decision, emptyExpansion);
    }

    if (decision.route === "knowledge") {
      const hit = await this.fixedPrefixProvider.getKnowledgeBaseHit(
        context.config.sharedDataDir,
        query,
      );
      if (hit) {
        return this.attachDiagnostics(
          this.buildRouteHitResult(hit, decision, query),
          query,
          context,
          decision,
          knowledgeExpansion,
        );
      }
    }

    const recentTail = rawStore.getRecentTail(3, { sessionId: context.sessionId });
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
    }, query, context, decision, emptyExpansion);
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
        text: this.formatExpandResult(kind, id, result),
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
        sourceTrace: result.edges,
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
    return this.jsonToolResponse("oms_status", status, status.ok);
  }

  async executeOmsSetupGuide(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const status = await this.runtime.getStatus(context);
    const configGuidance = this.payloadAdapter.describeConfigGuidance(context.config);
    const recommendedConfig = {
      configPreset: context.config.configPreset,
      enableTools: true,
      runtimeCaptureEnabled: true,
      durableMemoryEnabled: true,
      autoRecallEnabled: context.config.configPreset !== "safe",
      knowledgePromotionEnabled: false,
      knowledgePromotionManualReviewEnabled: true,
      knowledgeIntakeMode: context.config.knowledgeIntakeMode,
      sqliteJournalMode: context.config.sqliteJournalMode,
    };
    const setup = {
      ok: status.ok,
      purpose: "Configure ChaunyOMS as a SQLite-first runtime with Markdown assets as reviewed human-readable output.",
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
        "Keep sqliteJournalMode=delete unless the deployment needs concurrent reads/writes and supports WAL files reliably.",
        "Leave knowledgePromotionEnabled=false until raw recall/compaction are stable for the project.",
        "Enable knowledgePromotionManualReviewEnabled=true when promotion is enabled and the UI wants a review queue.",
        "Use oms_backup before restore/migration and oms_verify after large data operations.",
        "Use oms_wipe_session for privacy-driven session cleanup; use oms_wipe_agent only when you intend to remove the entire agent runtime state.",
      ],
      warnings: [
        ...configGuidance.warnings,
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
    const warnings = [
      ...configGuidance.warnings,
      ...verify.warnings,
      ...(context.config.emergencyBrake ? ["emergencyBrake is enabled: automatic compaction/promotion paths are intentionally conservative."] : []),
      ...(status.runtimeStore.enabled ? [] : ["SQLite runtime is disabled; source recall tools will fall back to no-op results."]),
      ...(status.runtimeStore.experimentalAdapter ? ["SQLite runtime is using Node's experimental node:sqlite adapter; pin a compatible Node version for production deployments."] : []),
      ...(context.config.knowledgePromotionEnabled ? [] : ["knowledgePromotionEnabled is false; Markdown asset promotion is opt-in/disabled."]),
    ];
    const errors = [...verify.errors];
    const doctor = {
      ok: errors.length === 0,
      engineId: "chaunyoms",
      activeRuntime: "sqlite-first runtime, markdown-first assets",
      status,
      verify,
      configGuidance,
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
      emergencyBrake: context.config.emergencyBrake,
      configPreset: context.config.configPreset,
      configWarnings,
      semanticCandidateExpansionEnabled: context.config.semanticCandidateExpansionEnabled,
      semanticCandidateLimit: context.config.semanticCandidateLimit,
      embeddingsReady: false,
      candidateExpansionMode:
        context.config.semanticCandidateExpansionEnabled
          ? "heuristic_only"
          : "disabled",
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
    durableEntries: DurableMemoryEntry[];
    knowledgeHits: KnowledgeDocumentIndexEntry[];
    summaryHits: SummaryEntry[];
    projects: ProjectRecord[];
    matchedProject: ProjectRecord | null;
  }): Promise<SemanticExpansionResult> {
    const expansionEnabled = args.context.config.semanticCandidateExpansionEnabled;
    if (!expansionEnabled) {
      return {
        candidates: [],
        knowledgeHits: [],
        durableHits: [],
        summaryHits: [],
        projectHit: args.matchedProject,
      };
    }
    const terms = this.semanticTerms(args.query);
    const candidates: SemanticCandidate[] = [];
    const knowledgeHits = [...args.knowledgeHits]
      .map((entry) => ({
        entry,
        score: this.scoreKnowledgeEntry(entry, terms, args.query),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title))
      .slice(0, Math.max(args.context.config.semanticCandidateLimit, 1));
    for (const item of knowledgeHits) {
      candidates.push({
        kind: "knowledge",
        id: item.entry.docId,
        title: item.entry.title,
        score: item.score,
        reasons: [
          `knowledge:${item.entry.bucket}`,
          `origin:${item.entry.origin}`,
          `status:${item.entry.status}`,
        ],
        authority: item.entry.status === "superseded" ? "hint" : "authoritative",
        sourceRoute: "semantic_candidate_expansion",
      });
    }

    const durableHits = [...args.durableEntries]
      .filter((entry) => entry.recordStatus !== "superseded" && entry.recordStatus !== "archived")
      .map((entry) => ({
        entry,
        score: this.scoreSemanticHaystack(
          [entry.kind, entry.projectId ?? "", entry.topicId ?? "", ...entry.tags, entry.text].join(" "),
          terms,
          args.query,
        ) + (args.matchedProject?.id && entry.projectId === args.matchedProject.id ? 4 : 0),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.createdAt.localeCompare(left.entry.createdAt))
      .slice(0, Math.max(args.context.config.semanticCandidateLimit, 1));
    for (const item of durableHits) {
      const matchedProjectTitle = args.matchedProject && args.matchedProject.id === item.entry.projectId
        ? args.matchedProject.title
        : undefined;
      candidates.push({
        kind: "durable_memory",
        id: item.entry.id,
        title: `[${item.entry.kind}] ${item.entry.text.slice(0, 72)}`,
        score: item.score,
        reasons: [
          `durable:${item.entry.kind}`,
          ...(args.matchedProject?.id && item.entry.projectId === args.matchedProject.id
            ? ["matched_project"]
            : []),
        ],
        authority: "authoritative",
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
      knowledgeHits: knowledgeHits.map((item) => item.entry),
      durableHits: durableHits.map((item) => item.entry),
      summaryHits: summaryHits.map((item) => item.entry),
      projectHit,
    };
  }

  private emptySemanticExpansion(projectHit: ProjectRecord | null = null): SemanticExpansionResult {
    return {
      candidates: [],
      knowledgeHits: [],
      durableHits: [],
      summaryHits: [],
      projectHit,
    };
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

  private planRecallItems(result: RecallResult, recallBudget: number): {
    items: ContextItem[];
    consumedTokens: number;
    plan: ReturnType<ContextPlanner["plan"]>;
  } {
    const source = result.strategy === "raw_first" ? "raw_exact_search" : "summary_context";
    const candidates = result.items.map((item, index) => this.contextPlanner.buildCandidate(item, source, index));
    const plan = this.contextPlanner.plan(candidates, { budget: recallBudget });
    return {
      items: plan.selected.map((candidate) => candidate.item),
      consumedTokens: plan.selectedTokens,
      plan,
    };
  }

  private resolveRecallBudget(args: unknown, totalBudget: number): number {
    const budget = this.isRecord(args) ? args.budget : undefined;
    return Math.max(
      256,
      Math.floor(
        typeof budget === "number" && Number.isFinite(budget)
          ? budget
          : totalBudget * 0.2,
      ),
    );
  }

  private resolveRawFtsHintLimit(args: unknown): number {
    if (this.isRecord(args) && args.qualityMode === true) {
      return 50;
    }
    if (this.isRecord(args) && args.deepRecall === true) {
      return 50;
    }
    return 48;
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
    const selected = Array.isArray(details.selected) ? details.selected as Array<Record<string, unknown>> : [];
    const rejected = Array.isArray(details.rejected) ? details.rejected as Array<Record<string, unknown>> : [];
    const lines = [
      `Context run: ${String(run.id ?? "")}`,
      `Intent: ${String(run.intent ?? "")}`,
      `Budget: selected ${Number(run.selectedTokens ?? 0)} / total ${Number(run.totalBudget ?? 0)} tokens`,
      `Selected: ${selected.length}; Rejected: ${rejected.length}`,
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
    if (matches.length === 0) {
      return [...header, "No matching candidate audit rows were found."].join("\n");
    }
    return [
      ...header,
      ...matches.map((candidate, index) =>
        `${index + 1}. ${candidate.status} ${candidate.source}/${candidate.authority} ${candidate.targetKind}:${candidate.targetId ?? "-"} score=${candidate.score} tokens=${candidate.tokenCount} reasons=${this.formatReasonList(candidate.reasons)}${candidate.rejectedReason ? ` rejected=${candidate.rejectedReason}` : ""}`),
    ].join("\n");
  }

  private formatReasonList(value: unknown): string {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").join(",")
      : "";
  }

  private async resolveRetrievalDecision(
    query: string,
    context: LifecycleContext,
  ): Promise<{ decision: RetrievalDecision }> {
    const { rawStore, summaryStore, durableMemoryStore, projectStore, knowledgeStore } = await this.runtime.getSessionStores(context);
    const projects = projectStore.getAll().filter((project) => project.status !== "archived");
    const matchedProject = this.matchProject(query, projects);
    const scopedDurableHits = this.shouldProbeDurableMemory(query)
      ? this.searchDurableHits(
        durableMemoryStore.getAll(),
        query,
        matchedProject?.id,
        3,
      )
      : [];
    const hasKnowledgeHits = this.shouldProbeKnowledgeDecision(query, context)
      ? knowledgeStore.searchRelatedDocuments(query, 1).length > 0
      : false;
    const decision = this.retrievalRouter.decide(query, {
      hasKnowledgeHits,
      hasKnowledgeRawHint: false,
      hasCompactedHistory: summaryStore.getAllSummaries().length > 0,
      hasProjectRegistry: projects.length > 0,
      hasDurableHits: scopedDurableHits.length > 0,
      recentAssistantUncertainty: this.hasRecentAssistantUncertainty(rawStore),
      queryComplexity: this.classifyQueryComplexity(query),
      referencesCurrentWork: this.referencesCurrentWork(query),
      matchedProjectId: matchedProject?.id,
      matchedProjectTitle: matchedProject?.title,
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
    const messages = items
      .map(
        (item) =>
          `[turn ${(item.turnNumber as number | undefined) ?? "?"}] ${(item.role as string | undefined) ?? "user"}: ${String(item.content ?? "")}`,
      )
      .join("\n\n");
    const traces = sourceTrace.length > 0
      ? [
          "",
          "Source trace:",
          ...sourceTrace.map((trace) =>
            `- summary ${trace.summaryId ?? "?"} -> ${trace.strategy} -> ${trace.verified ? "verified" : "unverified"} (${trace.resolvedMessageCount} messages)`,
          ),
        ].join("\n")
      : "";
    return [
      `Historical source hits for: ${query}`,
      "",
      answers,
      messages,
      traces,
    ].filter(Boolean).join("\n");
  }

  private shouldProbeDurableMemory(query: string): boolean {
    return /(current|latest|now|currently|updated|correction|after correction|exact|parameter|constraint|decision|rule|setting|config|remember|must|当前|最新|修正后|参数|约束|决策|规则|配置|记住)/i.test(query);
  }

  private shouldProbeKnowledgeDecision(query: string, context: LifecycleContext): boolean {
    if (!context.config.semanticCandidateExpansionEnabled) {
      return this.hasKnowledgeRouteTerms(query);
    }
    return this.hasKnowledgeRouteTerms(query);
  }

  private shouldProbeKnowledgeFallback(query: string, context: LifecycleContext): boolean {
    if (!context.config.semanticCandidateExpansionEnabled) {
      return false;
    }
    return this.hasKnowledgeRouteTerms(query);
  }

  private hasKnowledgeRouteTerms(query: string): boolean {
    const terms = [
      "knowledge[- ]?base",
      "\\u77e5\\u8bc6\\u5e93",
      "\\u6587\\u6863",
      "\\u8d44\\u6599",
      "topic-index",
      "architecture docs?",
      "\\u60f3\\u60f3",
      "\\u53d1\\u6563",
      "\\u7075\\u611f",
      "\\u521b\\u9020\\u529b",
      "\\u521b\\u610f",
      "\\u77e5\\u8bc6\\u5e7f\\u5ea6",
      "\\u7ecf\\u9a8c",
      "\\u5b66\\u4e60",
      "\\u501f\\u9274",
      "\\u53c2\\u8003",
      "\\u6700\\u4f73\\u5b9e\\u8df5",
      "\\u6848\\u4f8b",
      "\\u6a21\\u5f0f",
      "lesson",
      "learn",
      "learning",
      "experience",
      "inspiration",
      "creative",
      "creativity",
      "brainstorm",
      "broaden",
      "best practice",
      "pattern",
      "example",
      "case study",
    ];
    return new RegExp(terms.join("|"), "i").test(query);
  }

  private formatDurableMemoryText(query: string, items: DurableMemoryEntry[]): string {
    return [
      `Durable memory hits for: ${query}`,
      ...items.map((item, index) => `${index + 1}. [${item.kind}] ${item.text}`),
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

  private searchDurableHits(
    entries: DurableMemoryEntry[],
    query: string,
    projectId?: string,
    limit = 5,
  ): DurableMemoryEntry[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return [];
    }

    const scored = entries
      .filter((entry) => entry.recordStatus === "active")
      .map((entry) => {
        const haystack = [
          entry.kind,
          entry.projectId ?? "",
          entry.topicId ?? "",
          ...entry.tags,
          typeof entry.metadata?.factKey === "string" ? entry.metadata.factKey : "",
          typeof entry.metadata?.factValue === "string" ? entry.metadata.factValue : "",
          entry.text,
        ].join(" ").toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (haystack.includes(term)) {
            score += term.length >= 6 ? 3 : 2;
          }
        }
        if (terms.every((term) => haystack.includes(term))) {
          score += 4;
        }
        if (projectId && entry.projectId === projectId) {
          score += 5;
        }
        if (entry.metadata?.factRecencyHint === true) {
          score += 3;
        }
        if (/(current|latest|now|currently|现在|当前|最新)/i.test(query) && entry.metadata?.factKey) {
          score += 4;
        }
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.entry.createdAt.localeCompare(left.entry.createdAt);
      });

    const scoped = projectId
      ? scored.filter((item) => item.entry.projectId === projectId)
      : [];
    const source = scoped.length > 0 ? scoped : scored;
    return source.slice(0, Math.max(limit, 1)).map((item) => item.entry);
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

  private scoreManagedKnowledge(
    entry: KnowledgeDocumentIndexEntry,
    terms: string[],
  ): number {
    const haystack = [
      entry.slug,
      entry.title,
      entry.summary,
      entry.canonicalKey,
      entry.origin,
      ...entry.tags,
      ...entry.sourceRefs,
    ].join(" ").toLowerCase();
    return this.scoreHaystack(haystack, terms);
  }

  private scoreKnowledgeEntry(
    entry: KnowledgeDocumentIndexEntry,
    terms: string[],
    query: string,
  ): number {
    let score = this.scoreManagedKnowledge(entry, terms);
    if (entry.status === "active") {
      score += 4;
    } else if (entry.status === "draft") {
      score += 1;
    } else {
      score -= 1;
    }
    if (entry.origin === "synthesized" || entry.origin === "native") {
      score += 2;
    }
    if (entry.sourceRefs.length > 0) {
      score += Math.min(entry.sourceRefs.length, 3);
    }
    score += this.scoreSemanticHaystack(
      [entry.title, entry.summary, entry.canonicalKey, ...entry.tags].join(" "),
      terms,
      query,
    );
    return score;
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

  private async buildUnifiedKnowledgeResult(
    query: string,
    knowledgeStore: KnowledgeRepository,
    managedHits: Array<ReturnType<KnowledgeRepository["searchRelatedDocuments"]>[number]>,
    decision: RetrievalDecision,
  ): Promise<ToolResponse> {
    const terms = this.semanticTerms(query);
    const managedDocuments = (
      await Promise.all(managedHits.map((hit) => knowledgeStore.getById(hit.docId)))
    ).filter((document): document is NonNullable<typeof document> => Boolean(document));
    const unifiedHits = managedDocuments
      .map((document) => ({
        recordType: "knowledge_record" as const,
        score: this.scoreKnowledgeEntry(document.entry, terms, query),
        title: document.entry.title,
        body: document.content.trim(),
        metadata: [
          `type: knowledge_record`,
          `origin: ${document.entry.origin}`,
          `bucket: ${document.entry.bucket}`,
          `canonicalKey: ${document.entry.canonicalKey}`,
          `status: ${document.entry.status}`,
          `versions: ${document.entry.versions.length}`,
          `provenance refs: ${document.entry.sourceRefs.length}`,
          `linked summaries: ${document.entry.linkedSummaryIds.join(", ") || "none"}`,
          `source refs: ${document.entry.sourceRefs.join(", ") || "none"}`,
        ],
      }))
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, 6);

    const text = unifiedHits.length > 0
      ? unifiedHits
        .map((hit, index) => [
          `${index + 1}. ${hit.title}`,
          ...hit.metadata.map((line) => `   ${line}`),
          "",
          hit.body,
        ].join("\n"))
        .join("\n\n---\n\n")
      : `No knowledge documents matched query: ${query}`;

    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        hitCount: unifiedHits.length,
        knowledgeHitCount: managedDocuments.length,
        topRecordType: unifiedHits[0]?.recordType ?? null,
        retrievalHitType: "knowledge",
        autoRecall: false,
        autoRecallReason: null,
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
      },
    };
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

  private formatExpandResult(kind: string, id: string, result: OmsExpandResult): string {
    if (!result.target) {
      return `No runtime target found for ${kind}:${id}`;
    }
    const messages = result.messages.map((message) =>
      `[turn ${message.turnNumber}] ${message.role}: ${message.content}`,
    );
    const summaries = result.summaries.map((summary) =>
      `[summary ${summary.id}] turns ${summary.startTurn}-${summary.endTurn}: ${summary.summary}`,
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
    ].join("\n");
  }

  private buildRecallDisabledResponse(
    query: string,
    durableHits: DurableMemoryEntry[],
    context: LifecycleContext,
    decision: RetrievalDecision,
  ): ToolResponse {
    const text = durableHits.length > 0
      ? `${this.formatDurableMemoryText(query, durableHits)}\n\nSource recall is currently disabled by safety policy.`
      : `Source recall is currently disabled${context.config.emergencyBrake ? " because emergency brake is enabled" : " by configuration"}.`;
    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        hitCount: durableHits.length,
        retrievalHitType: durableHits.length > 0 ? "durable_memory" : this.getRetrievalHitType(decision),
        autoRecall: false,
        autoRecallReason: context.config.emergencyBrake ? "emergency_brake_enabled" : "auto_recall_disabled",
        emergencyBrake: context.config.emergencyBrake,
        autoRecallEnabled: context.config.autoRecallEnabled,
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        fallbackTrace: [{
          from: decision.route,
          to: durableHits.length > 0 ? "durable_memory" : "none",
          reason: context.config.emergencyBrake ? "emergency_brake_enabled" : "auto_recall_disabled",
        }],
      },
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  private shouldAutoRecall(decision: RetrievalDecision, context: LifecycleContext): boolean {
    if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
      return false;
    }
    return decision.requiresSourceRecall || decision.route === "summary_tree";
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
  ): "route_hit" | "summary_tree_recall" | "recent_tail" | "project_registry" | "durable_memory" | "knowledge" {
    if (decision.route === "project_registry") {
      return "project_registry";
    }
    if (decision.route === "durable_memory") {
      return "durable_memory";
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
      case "durable_memory":
        return "durable memory";
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

  private buildRouteHitResult(
    hit: { title: string; content: string; filePath?: string } | null,
    decision: RetrievalDecision,
    query: string,
  ): ToolResponse {
    const text =
      hit && hit.content.trim()
        ? hit.content
        : `No direct route-hit content found for query: ${query}`;
    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        title: hit?.title ?? null,
        filePath: hit?.filePath ?? null,
        retrievalHitType: decision.route === "knowledge" ? "knowledge" : "route_hit",
        autoRecall: false,
        autoRecallReason: null,
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        matchedProjectId: decision.matchedProjectId ?? null,
        matchedProjectTitle: decision.matchedProjectTitle ?? null,
        fallbackTrace: hit ? [] : [{
          from: decision.route,
          to: "none",
          reason: "route_hit_not_found",
        }],
      },
    };
  }
}


