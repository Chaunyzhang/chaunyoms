import { createHash } from "node:crypto";

import { ContextAssembler } from "../engines/ContextAssembler";
import { ContextPlannerResult } from "../engines/ContextPlanner";
import { CompactionEngine } from "../engines/CompactionEngine";
import { KnowledgeIntakeGate } from "../engines/KnowledgeIntakeGate";
import { KnowledgeCandidateScorer } from "../engines/KnowledgeCandidateScorer";
import { KnowledgeIntentClassifier } from "../engines/KnowledgeIntentClassifier";
import { KnowledgePromotionEngine } from "../engines/KnowledgePromotionEngine";
import { MemoryExtractionEngine } from "../engines/MemoryExtractionEngine";
import { SummaryHierarchyEngine } from "../engines/SummaryHierarchyEngine";
import { BackgroundOrganizerEngine } from "../engines/BackgroundOrganizerEngine";
import { EvidenceAtomEngine } from "../engines/EvidenceAtomEngine";
import {
  SessionDataLayer,
  SessionDataStores,
  SummaryIntegrityInspection,
} from "../data/SessionDataLayer";
import { SharedDataBootstrap } from "../system/SharedDataBootstrap";
import {
  BridgeConfig,
  ContextItem,
  DagIntegrityReport,
  ContextViewRepository,
  MemoryItemDraftRepository,
  MemoryItemDraftEntry,
  EvidenceAtomEntry,
  FixedPrefixProvider,
  HostFixedContextProvider,
  LlmCaller,
  LoggerLike,
  NavigationRepository,
  ObservationRepository,
  ObservationEntry,
  KnowledgeRawEntry,
  RawMessage,
  RawMessageRepository,
  SummaryEntry,
  SummaryRepository,
} from "../types";
import { estimateTokens } from "../utils/tokenizer";
import {
  IngestPayload,
  LifecycleContext,
  RuntimeMessageSnapshot,
} from "../host/OpenClawPayloadAdapter";
import {
  buildProjectStateSnapshot,
  formatProjectStateSnapshot,
} from "../utils/projectState";
import { SecretIngressGate } from "./SecretIngressGate";
import {
  deriveProjectIdentityFromSnapshot,
  deriveProjectIdentityFromSummary,
  deriveProjectStatusFromSnapshot,
} from "../utils/projectIdentity";
import { SourceMessageResolver } from "../resolvers/SourceMessageResolver";
import { SummaryDagIntegrityInspector } from "../resolvers/SummaryDagIntegrityInspector";
import { RuntimeMessageIngress } from "./RuntimeMessageIngress";
import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import { OmsAdminService } from "./OmsAdminService";
import { KnowledgeMaintenanceService } from "./KnowledgeMaintenanceService";
import { RuntimeIngressService } from "./RuntimeIngressService";
import { CompactionCoordinator } from "./CompactionCoordinator";

export interface CompactionDiagnostics {
  sessionId: string;
  mode: "manual" | "barrier";
  triggerExceeded: boolean;
  triggerThreshold: number;
  compressibleHistoryTokens: number;
  compressibleHistoryBudget: number;
  hostFixedTokens: number;
  hostFixedTokenSource: "systemPromptTokens" | "workspaceBootstrapEstimate";
  pluginFixedTokens: number;
  freshTailTokens: number;
  candidateStartTurn?: number;
  candidateEndTurn?: number;
  candidateMessageCount?: number;
  passes?: number;
  status: "pending" | "compacted" | "deduped" | "skipped" | "failed";
  reason?: string;
}

export interface AssembleResult {
  items: ContextItem[];
  estimatedTokens: number;
  importedMessages: number;
}

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
}

export interface AfterTurnResult {
  stats: Record<string, unknown>;
  importedMessages: number;
}

export interface OmsRuntimeStatus {
  ok: boolean;
  scope: "session" | "agent";
  sessionId: string;
  agentId: string;
  dataDir: string;
  workspaceDir: string;
  knowledgeBaseDir: string;
  memoryVaultDir: string;
  counts: {
    rawMessages: number;
    uncompactedRawMessages: number;
    uncompactedTokens: number;
    summaries: number;
    summaryTokens: number;
    observations: number;
    memoryItemDrafts: number;
    activeMemoryItemDrafts: number;
    evidenceAtoms: number;
    knowledgeRawItems: number;
    pendingKnowledgeRawItems: number;
    projects: number;
    contextItems: number;
  };
  config: Pick<BridgeConfig,
    | "configPreset"
    | "contextWindow"
    | "contextThreshold"
    | "freshTailTokens"
    | "maxFreshTailTurns"
    | "strictCompaction"
    | "compactionBarrierEnabled"
    | "runtimeCaptureEnabled"
    | "memoryItemEnabled"
    | "autoRecallEnabled"
    | "knowledgePromotionEnabled"
    | "knowledgePromotionManualReviewEnabled"
    | "retrievalStrength"
    | "kbCandidateEnabled"
    | "kbWriteEnabled"
    | "kbPromotionMode"
    | "kbPromotionStrictness"
    | "kbExportEnabled"
    | "semanticCandidateExpansionEnabled"
    | "semanticCandidateLimit"
    | "graphEnabled"
    | "ragEnabled"
    | "rerankEnabled"
    | "graphProvider"
    | "ragProvider"
    | "rerankProvider"
    | "embeddingEnabled"
    | "embeddingProvider"
    | "embeddingModel"
    | "embeddingDimensions"
    | "vectorExtensionPath"
    | "vectorExtensionEntryPoint"
    | "vectorSearchMaxCandidates"
    | "bruteForceVectorMaxRows"
    | "ragFallbackToBruteForce"
    | "graphBuilderEnabled"
    | "graphBuilderProvider"
    | "graphMaxDepth"
    | "graphMaxFanout"
    | "graphMinConfidence"
    | "graphCandidateLimit"
    | "rerankModel"
    | "rerankTimeoutMs"
    | "rerankFallbackToDeterministic"
    | "featureIsolationMode"
    | "heavyRetrievalPolicy"
    | "ragPlannerPolicy"
    | "graphPlannerPolicy"
    | "rerankPlannerPolicy"
    | "candidateRerankThreshold"
    | "laneCandidateRerankThreshold"
    | "candidateAmbiguityMargin"
    | "strictModeRequiresRerankOnConflict"
    | "openClawRuntimeProfile"
    | "emergencyBrake"
    | "sqliteJournalMode"
  >;
  runtimeStore: ReturnType<SQLiteRuntimeStore["getStatus"]>;
  lastCompactionDiagnostics: CompactionDiagnostics | null;
}

export interface OmsVerifyReport {
  ok: boolean;
  scope: "session" | "agent";
  sessionId: string;
  agentId: string;
  summaryDag: DagIntegrityReport;
  summaryIntegrity: SummaryIntegrityInspection;
  summarySourceTrace: ReturnType<SQLiteRuntimeStore["inspectSummarySourceTrace"]>;
  runtimeStore: ReturnType<SQLiteRuntimeStore["verifyIntegrity"]>;
  warnings: string[];
  errors: string[];
}

export interface OmsBackupResult {
  ok: boolean;
  backupDir: string;
  manifestPath: string;
  copied: string[];
  skipped: string[];
}

export interface OmsRestoreResult {
  ok: boolean;
  backupDir: string;
  apply: boolean;
  manifest: Record<string, unknown> | null;
  rollbackBackupDir?: string;
  rollbackApplied?: boolean;
  copied: string[];
  skipped: string[];
  reason?: string;
}

export interface OmsKnowledgeGovernanceResult {
  ok: boolean;
  apply: boolean;
  report: ReturnType<SQLiteRuntimeStore["inspectKnowledgeGovernance"]>;
  actions: string[];
  warnings: string[];
}

export interface OmsAssetSyncResult {
  ok: boolean;
  mode: "sync" | "reindex";
  markdown: Awaited<ReturnType<SessionDataStores["knowledgeStore"]["syncAssetIndex"]>>;
  runtime: Awaited<ReturnType<SQLiteRuntimeStore["syncAssetsFromMarkdownIndex"]>>;
}

export interface OmsAssetVerifyResult {
  ok: boolean;
  markdown: Awaited<ReturnType<SessionDataStores["knowledgeStore"]["verifyAssetIndex"]>>;
  runtime: ReturnType<SQLiteRuntimeStore["inspectKnowledgeGovernance"]>;
  warnings: string[];
}

export interface OmsKnowledgeCandidateListResult {
  ok: boolean;
  total: number;
  candidates: Array<{
    id: string;
    oneLineSummary: string;
    score: number | null;
    recommendation: string | null;
    status: string;
    reviewState: string | null;
    sourceSummaryId: string;
    intakeReason: string;
    createdAt: string;
  }>;
}

export interface OmsKnowledgeReviewResult {
  ok: boolean;
  action: "approve" | "reject";
  candidate: KnowledgeRawEntry | null;
  reason?: string;
}

export interface OmsAtomBackfillResult {
  ok: boolean;
  apply: boolean;
  scope: "agent" | "session";
  limit: number;
  totalSummaries: number;
  eligibleSummaries: number;
  skippedExistingSummaries: number;
  skippedNoAtomSummaries: number;
  generatedAtoms: number;
  existingAtoms: number;
  writtenAtoms: number;
  sourceSummaryIds: string[];
  warnings: string[];
}

export interface OmsWipeResult {
  ok: boolean;
  scope: "session" | "agent";
  apply: boolean;
  sessionId?: string;
  agentId?: string;
  removed: string[];
  skipped: string[];
  warnings: string[];
  backupDir?: string;
  reason?: string;
}

export interface RuntimeLayerDependencies {
  contextViewStore: ContextViewRepository;
  fixedPrefixProvider: FixedPrefixProvider;
  navigationRepository: NavigationRepository;
  hostFixedContextProvider: HostFixedContextProvider;
}

export class ChaunyomsSessionRuntime {
  private config: BridgeConfig;
  private logger: LoggerLike;
  private readonly sessionData: SessionDataLayer;
  private readonly contextViewStore: ContextViewRepository;
  private readonly fixedPrefixProvider: FixedPrefixProvider;
  private readonly navigationRepository: NavigationRepository;
  private readonly hostFixedContextProvider: HostFixedContextProvider;
  private readonly assembler: ContextAssembler;
  private readonly extractionEngine = new MemoryExtractionEngine();
  private readonly knowledgeIntakeGate = new KnowledgeIntakeGate();
  private readonly knowledgeCandidateScorer = new KnowledgeCandidateScorer();
  private knowledgePromotionEngine: KnowledgePromotionEngine;
  private summaryHierarchyEngine: SummaryHierarchyEngine;
  private backgroundOrganizerEngine: BackgroundOrganizerEngine;
  private sharedDataBootstrap: SharedDataBootstrap;
  private compactionEngine: CompactionEngine;
  private knowledgeIntentClassifier: KnowledgeIntentClassifier;
  private readonly sourceMessageResolver = new SourceMessageResolver();
  private readonly dagIntegrityInspector = new SummaryDagIntegrityInspector();
  private readonly evidenceAtomEngine = new EvidenceAtomEngine();
  private readonly secretIngressGate = new SecretIngressGate();
  private llmCaller: LlmCaller | null;
  private lastCompactionDiagnostics: CompactionDiagnostics | null = null;
  private navigationSnapshotPending = false;
  private readonly runtimeIngress = new RuntimeMessageIngress();
  private omsAdmin!: OmsAdminService;
  private knowledgeMaintenance!: KnowledgeMaintenanceService;
  private runtimeIngressService!: RuntimeIngressService;
  private compactionCoordinator!: CompactionCoordinator;

  constructor(
    logger: LoggerLike,
    llmCaller: LlmCaller | null,
    initialConfig: BridgeConfig,
    dependencies: RuntimeLayerDependencies,
  ) {
    this.logger = logger;
    this.config = initialConfig;
    this.llmCaller = llmCaller;
    this.sessionData = new SessionDataLayer(this.logger);
    this.contextViewStore = dependencies.contextViewStore;
    this.fixedPrefixProvider = dependencies.fixedPrefixProvider;
    this.navigationRepository = dependencies.navigationRepository;
    this.hostFixedContextProvider = dependencies.hostFixedContextProvider;
    this.assembler = new ContextAssembler(this.contextViewStore, this.fixedPrefixProvider);
    this.sharedDataBootstrap = new SharedDataBootstrap(this.logger);
    this.compactionEngine = new CompactionEngine(llmCaller, this.logger);
    this.knowledgeIntentClassifier = new KnowledgeIntentClassifier(llmCaller, this.logger);
    this.knowledgePromotionEngine = new KnowledgePromotionEngine(llmCaller, this.logger);
    this.summaryHierarchyEngine = new SummaryHierarchyEngine(llmCaller, this.logger);
    this.backgroundOrganizerEngine = new BackgroundOrganizerEngine(this.logger);
    this.initializeServices();
  }

  updateHost(logger: LoggerLike, llmCaller: LlmCaller | null): void {
    this.logger = logger;
    this.llmCaller = llmCaller;
    this.sharedDataBootstrap = new SharedDataBootstrap(this.logger);
    this.compactionEngine = new CompactionEngine(llmCaller, this.logger);
    this.knowledgeIntentClassifier = new KnowledgeIntentClassifier(llmCaller, this.logger);
    this.knowledgePromotionEngine = new KnowledgePromotionEngine(llmCaller, this.logger);
    this.summaryHierarchyEngine = new SummaryHierarchyEngine(llmCaller, this.logger);
    this.backgroundOrganizerEngine = new BackgroundOrganizerEngine(this.logger);
    this.initializeServices();
  }

  getConfig(): BridgeConfig {
    return this.config;
  }

  getLlmCaller(): LlmCaller | null {
    return this.llmCaller;
  }

  private initializeServices(): void {
    this.omsAdmin = new OmsAdminService({
      sessionData: this.sessionData,
      contextViewStore: this.contextViewStore,
      knowledgeCandidateScorer: this.knowledgeCandidateScorer,
      ensureSession: this.ensureSession.bind(this),
      inspectDag: this.inspectDag.bind(this),
      inspectAgentDag: () => this.dagIntegrityInspector.inspect(
        this.sessionData.getStores().summaryStore,
        this.sessionData.getStores().rawStore,
        {},
      ),
      getLastCompactionDiagnostics: () => this.lastCompactionDiagnostics,
    });
    this.knowledgeMaintenance = new KnowledgeMaintenanceService({
      logger: this.logger,
      sourceMessageResolver: this.sourceMessageResolver,
      knowledgePromotionEngine: this.knowledgePromotionEngine,
      knowledgeIntakeGate: this.knowledgeIntakeGate,
      knowledgeCandidateScorer: this.knowledgeCandidateScorer,
      ensureSession: this.ensureSession.bind(this),
    });
    this.runtimeIngressService = new RuntimeIngressService({
      runtimeIngress: this.runtimeIngress,
      extractionEngine: this.extractionEngine,
      knowledgeIntentClassifier: this.knowledgeIntentClassifier,
      ensureSession: this.ensureSession.bind(this),
      appendRawMessages: this.sessionData.appendRawMessages.bind(this.sessionData),
      persistMemoryItemDrafts: this.persistMemoryItemDrafts.bind(this),
    });
    this.compactionCoordinator = new CompactionCoordinator({
      logger: this.logger,
      assembler: this.assembler,
      fixedPrefixProvider: this.fixedPrefixProvider,
      hostFixedContextProvider: this.hostFixedContextProvider,
      compactionEngine: this.compactionEngine,
      getConfig: () => this.config,
      getMemoryItemDraftStore: () => this.getActiveStores().memoryItemDraftStore,
      setNavigationSnapshotPending: () => {
        this.navigationSnapshotPending = true;
      },
      getDiagnostics: () => this.lastCompactionDiagnostics,
      setDiagnostics: (value) => {
        this.lastCompactionDiagnostics = value;
      },
      onBarrierCompacted: async (entry, context, summaryStore) => {
        await this.persistEvidenceAtomsForSummary(entry);
        await this.knowledgeMaintenance.enqueueSummaryForKnowledge(entry, context);
        await this.rollUpSummaryTree(summaryStore, context);
      },
    });
  }

  async bootstrap(context: LifecycleContext): Promise<{
    importedMessages: number;
    integrity: {
      total: number;
      verified: number;
      mismatched: number;
      unchecked: number;
    };
  }> {
    this.config = context.config;
    await this.sharedDataBootstrap.ensure(this.config.sharedDataDir);
    await this.ensureSession(context.sessionId, context.config);
    const integrityInspection = this.inspectSummaryIntegrity();
    await this.repairCompactedFlagsFromSummaries(integrityInspection.verifiedEntries);
    const integrity = this.toIntegrityStats(integrityInspection);
    if (integrity.mismatched > 0) {
      this.logger.warn("summary_integrity_mismatch_detected", integrity);
    }
    this.knowledgeMaintenance.schedule(context);
    return { importedMessages: 0, integrity };
  }

  async waitForBackgroundWork(): Promise<void> {
    await this.knowledgeMaintenance.waitForBackgroundWork();
  }

  async ingest(payload: IngestPayload): Promise<{ ingested: boolean }> {
    const { rawStore, memoryItemDraftStore } = await this.ensureSession(payload.sessionId, payload.config);
    const ingressDecision = this.runtimeIngress.inspect({
      id: payload.id,
      sourceKey: payload.id,
      role: payload.role,
      content: payload.content,
      text: payload.content,
      metadata: payload.metadata,
    });
    if (ingressDecision.storageTarget === "observation") {
      const sanitizedObservation = this.secretIngressGate.sanitize(
        `observation:${payload.sessionId}:${payload.id}`,
        ingressDecision.normalizedText,
        payload.metadata ?? {},
      );
      await this.sessionData.appendObservation({
        id: `observation-${payload.id}`,
        sessionId: payload.sessionId,
        agentId: payload.config.agentId,
        role: payload.role,
        classification: ingressDecision.classification,
        content: sanitizedObservation.text,
        sourceKey: payload.id,
        createdAt: new Date().toISOString(),
        tokenCount: estimateTokens(sanitizedObservation.text),
        metadata: {
          ...sanitizedObservation.metadata,
          reason: ingressDecision.reason,
          sourceBoundary: "runtime_event_not_source",
        },
      });
      return { ingested: false };
    }

    if (!ingressDecision.persist || ingressDecision.storageTarget !== "raw_message") {
      return { ingested: false };
    }

    const sanitized = this.secretIngressGate.sanitize(
      `ingest:${payload.sessionId}:${payload.id}`,
      ingressDecision.normalizedText,
      payload.metadata ?? {},
    );
    const turnNumber = payload.turnNumber ?? this.resolveNextTurnNumber(rawStore, payload.role);
    const knowledgeIntent = payload.role === "user" && payload.config.openClawRuntimeProfile !== "lightweight"
      ? await this.knowledgeIntentClassifier.classifyUserMessage(sanitized.text, payload.config)
      : null;
    const message: RawMessage = {
      id: payload.id,
      sessionId: payload.sessionId,
      agentId: payload.config.agentId,
      role: payload.role,
      content: sanitized.text,
      turnNumber,
      createdAt: new Date().toISOString(),
      tokenCount: estimateTokens(sanitized.text),
      compacted: false,
      metadata: {
        ...sanitized.metadata,
        ingressClassification: ingressDecision.classification,
        ingressReason: ingressDecision.reason,
        ...(knowledgeIntent ? { knowledgeIntent } : {}),
      },
    };
    await this.sessionData.appendRawMessage(message);
    await this.persistMemoryItemDrafts(
      memoryItemDraftStore,
      this.extractionEngine.extractFromRawMessage(message),
    );
    await this.sessionData.writeMemoryItemArtifacts();
    return { ingested: true };
  }

  async assemble(context: LifecycleContext): Promise<AssembleResult> {
    const { rawStore, summaryStore } = await this.ensureSession(
      context.sessionId,
      context.config,
    );
    const synced = await this.syncRuntimeMessages(
      context.sessionId,
      context.config,
      context.runtimeMessages,
    );
    const activeQuery = this.resolveActiveUserQuery(
      rawStore,
      context.runtimeMessages,
    );

    if (!this.config.emergencyBrake && this.config.compactionBarrierEnabled) {
      await this.compactionCoordinator.runCompactionBarrier(
        context,
        rawStore,
        summaryStore,
        activeQuery,
      );
    }
    await this.sessionData.mirrorRuntimeState();

    const assembleOptions = {
      includeStablePrefix: !this.config.emergencyBrake,
      includeSummaries: !this.config.emergencyBrake,
      includeMemoryItems: !this.config.emergencyBrake && this.config.openClawRuntimeProfile !== "lightweight",
      activeQuery,
      sessionId: context.sessionId,
    };

    try {
      const runtimeStore = this.sessionData.getRuntimeStore();
      const runtimeStatus = runtimeStore.getStatus();
      if (!runtimeStatus.enabled) {
        throw new Error("sqlite_runtime_unavailable_for_assembly");
      }
      const result = await this.assembler.assembleFromRuntime(
        runtimeStore,
        context.totalBudget,
        context.systemPromptTokens,
        this.config.freshTailTokens,
        this.config.maxFreshTailTurns,
        this.config.sharedDataDir,
        this.config.workspaceDir,
        assembleOptions,
      );
      const items = this.injectLightweightRecallGuidanceIfNeeded(
        result.items,
        rawStore,
        summaryStore,
        context,
      );
      this.sessionData.recordContextPlan({
        sessionId: context.sessionId,
        agentId: this.config.agentId,
        totalBudget: context.totalBudget,
        intent: activeQuery ? "assemble_sqlite_with_active_query" : "assemble_sqlite",
        plan: result.plan,
        metadata: {
          query: activeQuery,
          route: "assemble",
          retrievalStrength: context.config.retrievalStrength,
          usageFeedbackEnabled: context.config.usageFeedbackEnabled,
        },
      });
      return {
        items,
        estimatedTokens: items.reduce((sum, item) => sum + item.tokenCount, 0),
        importedMessages: synced.importedMessages,
      };
    } catch (sqliteError) {
      this.logger.warn("assemble_sqlite_failed_runtime_tail_fallback", {
        error: sqliteError instanceof Error ? sqliteError.message : String(sqliteError),
      });
      const fallback = this.injectLightweightRecallGuidanceIfNeeded(
        this.buildRuntimeMessageTailFallback(
        context,
        Math.max(context.totalBudget - context.systemPromptTokens, 0),
        ),
        rawStore,
        summaryStore,
        context,
      );
      this.contextViewStore.setItems(fallback);
      return {
        items: fallback,
        estimatedTokens: fallback.reduce((sum, item) => sum + item.tokenCount, 0),
        importedMessages: synced.importedMessages,
      };
    }
  }

  async compact(context: LifecycleContext): Promise<CompactResult> {
    const { rawStore, summaryStore, memoryItemDraftStore } = await this.ensureSession(
      context.sessionId,
      context.config,
    );

    if (this.config.emergencyBrake) {
      return {
        ok: true,
        compacted: false,
        reason: "emergency_brake_enabled",
      };
    }

    await this.syncRuntimeMessages(
      context.sessionId,
      context.config,
      context.runtimeMessages,
    );
    const tokensBefore = rawStore.totalUncompactedTokens({ sessionId: context.sessionId });
    const budgetState = await this.compactionCoordinator.measureCompactionBudgetState(
      context,
      rawStore,
      summaryStore,
    );
    const candidate = this.compactionEngine.selectTurnsForCompaction(
      rawStore,
      summaryStore,
      this.config.freshTailTokens,
      this.config.maxFreshTailTurns,
      this.config.compactionBatchTurns,
      context.sessionId,
    );
    this.lastCompactionDiagnostics = {
      sessionId: context.sessionId,
      mode: "manual",
      triggerExceeded: budgetState.triggerExceeded,
      triggerThreshold: budgetState.triggerBudget,
      compressibleHistoryTokens: budgetState.compressibleHistoryTokens,
      compressibleHistoryBudget: budgetState.compressibleHistoryBudget,
      hostFixedTokens: budgetState.hostFixedTokens,
      hostFixedTokenSource: budgetState.hostFixedTokenSource,
      pluginFixedTokens: budgetState.pluginFixedTokens,
      freshTailTokens: budgetState.freshTailTokens,
      candidateStartTurn: candidate?.startTurn,
      candidateEndTurn: candidate?.endTurn,
      candidateMessageCount: candidate?.messages.length,
      status: "pending",
    };
    const compaction = await this.compactionCoordinator.runSerializedCompaction(
      rawStore,
      summaryStore,
      context,
    );

    if (compaction.status !== "compacted" && compaction.status !== "deduped") {
      this.lastCompactionDiagnostics = {
        ...(this.lastCompactionDiagnostics ?? {
          sessionId: context.sessionId,
          mode: "manual",
          triggerExceeded: false,
          triggerThreshold: 0,
          compressibleHistoryTokens: 0,
          compressibleHistoryBudget: 0,
          hostFixedTokens: 0,
          hostFixedTokenSource: "systemPromptTokens",
          pluginFixedTokens: 0,
          freshTailTokens: 0,
        }),
        status: compaction.status,
        reason: compaction.reason,
      };
      return {
        ok: true,
        compacted: false,
        reason: compaction.reason,
      };
    }
    const entry = compaction.summary;

    await this.persistEvidenceAtomsForSummary(entry);
    await this.knowledgeMaintenance.enqueueSummaryForKnowledge(entry, context);
    await this.rollUpSummaryTree(summaryStore, context);
    await this.writeNavigationArtifactsIfPending(
      context,
      rawStore,
      summaryStore,
      memoryItemDraftStore,
      true,
    );
    await this.backgroundOrganizerEngine.run(
      memoryItemDraftStore,
      summaryStore,
      this.getActiveStores().projectStore,
      this.config.agentId,
    );
    this.lastCompactionDiagnostics = {
      ...(this.lastCompactionDiagnostics ?? {
        sessionId: context.sessionId,
        mode: "manual",
        triggerExceeded: false,
        triggerThreshold: 0,
        compressibleHistoryTokens: 0,
        compressibleHistoryBudget: 0,
        hostFixedTokens: 0,
        hostFixedTokenSource: "systemPromptTokens",
        pluginFixedTokens: 0,
        freshTailTokens: 0,
      }),
      candidateStartTurn: entry.startTurn,
      candidateEndTurn: entry.endTurn,
      candidateMessageCount: entry.sourceMessageCount,
      status: compaction.status,
      reason: "manual_compaction_completed",
    };

    return {
      ok: true,
      compacted: true,
      result: {
        summary: entry.summary,
        tokensBefore,
        tokensAfter: rawStore.totalUncompactedTokens({ sessionId: context.sessionId }),
        details: {
          startTurn: entry.startTurn,
          endTurn: entry.endTurn,
          summaryId: entry.id,
          sourceTrace: compaction.sourceTrace,
          diagnostics: {
            ...(this.lastCompactionDiagnostics ?? {}),
            status: compaction.status,
            reason: "manual_compaction_completed",
          },
        },
      },
    };
  }

  async afterTurn(context: LifecycleContext): Promise<AfterTurnResult> {
    const { rawStore, summaryStore, observationStore, memoryItemDraftStore } = await this.ensureSession(
      context.sessionId,
      context.config,
    );
    const synced = await this.syncRuntimeMessages(
      context.sessionId,
      context.config,
      context.runtimeMessages,
    );
    const lightweightCompaction = this.config.openClawRuntimeProfile === "lightweight"
      ? await this.runLightweightAfterTurnCompaction(
        context,
        rawStore,
        summaryStore,
      )
      : null;

    const { knowledgeStore } = await this.ensureSession(
      context.sessionId,
      context.config,
    );
    const stats = {
      timestamp: new Date().toISOString(),
      sessionId: context.sessionId,
      contextWindow: context.totalBudget,
      compactionTriggerThreshold: this.config.contextThreshold,
      uncompactedTokens: rawStore.totalUncompactedTokens({ sessionId: context.sessionId }),
      summaryCount: summaryStore.getAllSummaries().length,
      summaryTokens: summaryStore.getTotalTokens(),
      observationCount: observationStore.count(),
      memoryItemCount: this.sessionData.getRuntimeStore().getStatus().counts.memoryItems,
      unifiedKnowledgeDir: this.config.knowledgePromotionEnabled ? knowledgeStore.getBaseDir() : null,
      contextItems: this.contextViewStore.getItems().length,
      importedMessages: synced.importedMessages,
      strictCompaction: this.config.strictCompaction,
      compactionBarrierEnabled: this.config.compactionBarrierEnabled,
      runtimeCaptureEnabled: this.config.runtimeCaptureEnabled,
      memoryItemEnabled: this.config.memoryItemEnabled,
      autoRecallEnabled: this.config.autoRecallEnabled,
      knowledgePromotionEnabled: this.config.knowledgePromotionEnabled,
      configPreset: this.config.configPreset,
      semanticCandidateExpansionEnabled: this.config.semanticCandidateExpansionEnabled,
      semanticCandidateLimit: this.config.semanticCandidateLimit,
      lastCompactionDiagnostics: this.lastCompactionDiagnostics,
      emergencyBrake: this.config.emergencyBrake,
      openClawRuntimeProfile: this.config.openClawRuntimeProfile,
      lightweightCompaction,
    };
    this.logger.info("after_turn_stats", stats);
    await this.writeStatsLog(context.sessionId, stats);

    if (this.config.openClawRuntimeProfile === "lightweight") {
      const compactionTriggeredThisStep = lightweightCompaction?.status === "compacted" ||
        lightweightCompaction?.status === "deduped";
      await this.writeNavigationArtifactsIfPending(
        context,
        rawStore,
        summaryStore,
        memoryItemDraftStore,
        compactionTriggeredThisStep,
      );
      return {
        stats,
        importedMessages: synced.importedMessages,
      };
    }

    await this.writeNavigationArtifactsIfPending(
      context,
      rawStore,
      summaryStore,
      memoryItemDraftStore,
      false,
    );
    await this.updateProjectRegistry(context, rawStore, summaryStore);
    await this.backgroundOrganizerEngine.run(
      memoryItemDraftStore,
      summaryStore,
      this.getActiveStores().projectStore,
      this.config.agentId,
    );

    return {
      stats,
      importedMessages: synced.importedMessages,
    };
  }

  async getSessionStores(context: Pick<LifecycleContext, "sessionId" | "config">): Promise<SessionDataStores> {
    return await this.ensureSession(context.sessionId, context.config);
  }

  async getRuntimeStore(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: { mirror?: boolean; ensure?: boolean } = {},
  ): Promise<SQLiteRuntimeStore> {
    if (options.ensure !== false) {
      await this.ensureSession(context.sessionId, context.config);
    }
    if (options.mirror !== false) {
      await this.sessionData.mirrorRuntimeState();
    }
    return this.sessionData.getRuntimeStore();
  }

  async recordRetrievalPlan(
    context: Pick<LifecycleContext, "sessionId" | "config" | "totalBudget">,
    intent: string,
    plan: ContextPlannerResult,
    totalBudget?: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureSession(context.sessionId, context.config);
    this.sessionData.recordContextPlan({
      sessionId: context.sessionId,
      agentId: context.config.agentId,
      totalBudget: totalBudget ?? ("totalBudget" in context ? context.totalBudget : plan.budget),
      intent,
      plan,
      metadata,
    });
  }

  async inspectDag(context: Pick<LifecycleContext, "sessionId" | "config">): Promise<DagIntegrityReport> {
    const { rawStore, summaryStore } = await this.ensureSession(context.sessionId, context.config);
    return this.dagIntegrityInspector.inspect(summaryStore, rawStore, {
      sessionId: context.sessionId,
    });
  }

  async getStatus(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: { scope?: "session" | "agent" } = {},
  ): Promise<OmsRuntimeStatus> {
    return await this.omsAdmin.getStatus(context, options);
  }

  async verify(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: { scope?: "session" | "agent" } = {},
  ): Promise<OmsVerifyReport> {
    return await this.omsAdmin.verify(context, options);
  }

  async backup(context: Pick<LifecycleContext, "sessionId" | "config">, label = ""): Promise<OmsBackupResult> {
    return await this.omsAdmin.backup(context, label);
  }

  async exportAgentCapsule(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: { agentId?: string; label?: string } = {},
  ): Promise<Record<string, unknown>> {
    return await this.omsAdmin.exportAgentCapsule(context, options);
  }

  async verifyAgentCapsule(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    capsulePath: string,
  ): Promise<Record<string, unknown>> {
    return await this.omsAdmin.verifyAgentCapsule(context, capsulePath);
  }

  async importAgentCapsule(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    capsulePath: string,
    apply = false,
  ): Promise<Record<string, unknown>> {
    return await this.omsAdmin.importAgentCapsule(context, capsulePath, apply);
  }

  async restore(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    backupDirInput: string,
    apply = false,
  ): Promise<OmsRestoreResult> {
    return await this.omsAdmin.restore(context, backupDirInput, apply);
  }

  async verifyMigration(
    context: Pick<LifecycleContext, "sessionId" | "config">,
  ): Promise<Record<string, unknown>> {
    return await this.omsAdmin.verifyMigration(context);
  }

  async exportJsonBackup(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    label = "",
  ): Promise<Record<string, unknown>> {
    return await this.omsAdmin.exportJsonBackup(context, label);
  }

  async cleanupLegacyJson(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    apply = false,
  ): Promise<Record<string, unknown>> {
    return await this.omsAdmin.cleanupLegacyJson(context, apply);
  }

  async migrateJsonToSqlite(
    context: Pick<LifecycleContext, "sessionId" | "config">,
  ): Promise<Record<string, unknown>> {
    return await this.omsAdmin.migrateJsonToSqlite(context);
  }

  async curateKnowledge(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    apply = false,
  ): Promise<OmsKnowledgeGovernanceResult> {
    return await this.omsAdmin.curateKnowledge(context, apply);
  }

  async syncKnowledgeAssets(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    mode: "sync" | "reindex" = "sync",
  ): Promise<OmsAssetSyncResult> {
    return await this.omsAdmin.syncKnowledgeAssets(context, mode);
  }

  async verifyKnowledgeAssets(
    context: Pick<LifecycleContext, "sessionId" | "config">,
  ): Promise<OmsAssetVerifyResult> {
    return await this.omsAdmin.verifyKnowledgeAssets(context);
  }

  async listKnowledgeCandidates(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: { status?: string; limit?: number } = {},
  ): Promise<OmsKnowledgeCandidateListResult> {
    return await this.omsAdmin.listKnowledgeCandidates(context, options);
  }

  async reviewKnowledgeCandidate(
    context: Pick<LifecycleContext, "sessionId" | "config" | "summaryModel">,
    args: {
      id: string;
      action: "approve" | "reject";
      reviewer?: string;
      note?: string;
    },
  ): Promise<OmsKnowledgeReviewResult> {
    return await this.omsAdmin.reviewKnowledgeCandidate(context, {
      ...args,
      onApprove: () => this.knowledgeMaintenance.schedule(context),
    });
  }

  async backfillEvidenceAtoms(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: {
      apply?: boolean;
      scope?: "agent" | "session";
      limit?: number;
    } = {},
  ): Promise<OmsAtomBackfillResult> {
    const stores = await this.ensureSession(context.sessionId, context.config);
    const scope = options.scope ?? "agent";
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
    const scopedQuery = scope === "session" ? { sessionId: context.sessionId } : undefined;
    const summaries = stores.summaryStore.getAllSummaries(scopedQuery);
    const existingAtoms = stores.evidenceAtomStore.getAll(scopedQuery);
    const existingSummaryIds = new Set(existingAtoms.map((atom) => atom.sourceSummaryId));
    const sourceSummaryIds: string[] = [];
    let eligibleSummaries = 0;
    let skippedExistingSummaries = 0;
    let skippedNoAtomSummaries = 0;
    const atoms: EvidenceAtomEntry[] = [];

    for (const summary of summaries) {
      if ((summary.summaryLevel ?? 1) > 1 || (summary.nodeKind ?? "leaf") !== "leaf") {
        continue;
      }
      if (summary.recordStatus && summary.recordStatus !== "active") {
        continue;
      }
      if (existingSummaryIds.has(summary.id)) {
        skippedExistingSummaries += 1;
        continue;
      }
      if (sourceSummaryIds.length >= limit) {
        break;
      }
      const summaryAtoms = this.evidenceAtomEngine.fromSummary(summary);
      if (summaryAtoms.length === 0) {
        skippedNoAtomSummaries += 1;
        continue;
      }
      eligibleSummaries += 1;
      sourceSummaryIds.push(summary.id);
      atoms.push(...summaryAtoms);
    }

    let writtenAtoms = 0;
    if (options.apply && atoms.length > 0) {
      await this.sessionData.upsertEvidenceAtoms(atoms);
      await this.sessionData.getRuntimeStore().recordEvidenceAtoms(atoms);
      writtenAtoms = atoms.length;
    }

    return {
      ok: true,
      apply: options.apply === true,
      scope,
      limit,
      totalSummaries: summaries.length,
      eligibleSummaries,
      skippedExistingSummaries,
      skippedNoAtomSummaries,
      generatedAtoms: atoms.length,
      existingAtoms: existingAtoms.length,
      writtenAtoms,
      sourceSummaryIds,
      warnings: options.apply
        ? []
        : ["Dry run only. Pass apply=true to persist generated evidence atoms."],
    };
  }

  async wipeSession(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: {
      apply?: boolean;
      backupBeforeApply?: boolean;
    } = {},
  ): Promise<OmsWipeResult> {
    return await this.omsAdmin.wipeSession(context, options);
  }

  async wipeAgent(
    context: Pick<LifecycleContext, "sessionId" | "config">,
    options: {
      apply?: boolean;
      backupBeforeApply?: boolean;
      wipeKnowledgeBase?: boolean;
      wipeWorkspaceMemory?: boolean;
      wipeBackups?: boolean;
    } = {},
  ): Promise<OmsWipeResult> {
    return await this.omsAdmin.wipeAgent(context, options);
  }

  private async ensureSession(
    sessionId: string,
    config: BridgeConfig,
  ): Promise<SessionDataStores> {
    this.config = config;
    return await this.sessionData.ensure(sessionId, config);
  }
  private async syncRuntimeMessages(
    sessionId: string,
    config: BridgeConfig,
    runtimeMessages: RuntimeMessageSnapshot[],
  ): Promise<{ importedMessages: number }> {
    if (!config.runtimeCaptureEnabled || config.emergencyBrake) {
      if (runtimeMessages.length > 0) {
        this.logger.info("runtime_message_ingress_bypassed", {
          sessionId,
          reason: config.emergencyBrake ? "emergency_brake_enabled" : "runtime_capture_disabled",
          runtimeMessageCount: runtimeMessages.length,
        });
      }
      return { importedMessages: 0 };
    }
    const inspectedMessages = runtimeMessages.map((message) => ({
      message,
      decision: this.runtimeIngress.inspect(message),
    }));
    const skippedCounts = new Map<string, number>();
    for (const { decision } of inspectedMessages) {
      if (decision.persist) {
        continue;
      }
      skippedCounts.set(
        decision.classification,
        (skippedCounts.get(decision.classification) ?? 0) + 1,
      );
    }
    if (skippedCounts.size > 0) {
      this.logger.info("runtime_message_ingress_filtered", {
        sessionId,
        skipped: Object.fromEntries(skippedCounts),
      });
    }
    return await this.runtimeIngressService.syncRuntimeMessages(sessionId, config, runtimeMessages);
  }

  private async persistMemoryItemDrafts(
    memoryItemDraftStore: MemoryItemDraftRepository,
    entries: MemoryItemDraftEntry[],
  ): Promise<void> {
    if (!this.config.memoryItemEnabled || this.config.emergencyBrake || entries.length === 0) {
      return;
    }
    await this.sessionData.addMemoryItemDraftEntries(entries);
  }

  private resolveNextTurnNumber(
    rawStore: RawMessageRepository,
    role: RawMessage["role"],
  ): number {
    const messages = rawStore.getAll();
    const lastTurn = messages[messages.length - 1]?.turnNumber ?? 0;
    return role === "user" ? lastTurn + 1 : Math.max(lastTurn, 1);
  }

  private resolveActiveUserQuery(
    rawStore: RawMessageRepository,
    runtimeMessages: RuntimeMessageSnapshot[],
  ): string | undefined {
    return this.runtimeIngressService.resolveActiveUserQuery(rawStore, runtimeMessages);
  }

  private buildRuntimeMessageTailFallback(
    context: LifecycleContext,
    availableBudget: number,
  ): ContextItem[] {
    return this.runtimeIngressService.buildRuntimeMessageTailFallback(
      context,
      availableBudget,
      this.config.freshTailTokens,
      this.config.maxFreshTailTurns,
    );
  }

  private injectLightweightRecallGuidanceIfNeeded(
    items: ContextItem[],
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    context: LifecycleContext,
  ): ContextItem[] {
    if (this.config.openClawRuntimeProfile !== "lightweight") {
      return items;
    }
    const alreadyHasGuidance = items.some((item) => item.metadata?.layer === "oms_recall_guidance");
    const alreadyHasSystemPolicy = items.some((item) => item.metadata?.layer === "oms_recall_policy");
    if (alreadyHasGuidance && alreadyHasSystemPolicy) {
      return items;
    }
    const prefixed: ContextItem[] = [
      ...(alreadyHasSystemPolicy ? [] : [this.assembler.buildOpenClawRecallSystemItem()]),
      ...items,
    ];
    const summaryCount = summaryStore.getAllSummaries({ sessionId: context.sessionId }).length;
    const rawCount = rawStore.getAll({ sessionId: context.sessionId }).length;
    if (summaryCount > 0 || rawCount < Math.max(this.config.maxFreshTailTurns * 2, 6)) {
      return prefixed;
    }
    const guidanceText = [
      "[oms_recall_guidance]",
      "Earlier turns may be outside the visible recent tail.",
      this.config.forceDagOnlyRecall
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
  private inspectSummaryIntegrity(): SummaryIntegrityInspection {
    return this.sessionData.inspectSummaryIntegrity();
  }

  private toIntegrityStats(
    inspection: SummaryIntegrityInspection,
  ): {
    total: number;
    verified: number;
    mismatched: number;
    unchecked: number;
  } {
    return {
      total: inspection.total,
      verified: inspection.verified,
      mismatched: inspection.mismatched,
      unchecked: inspection.unchecked,
    };
  }

  private buildNavigationSnapshot(
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
  ): string {
    return formatProjectStateSnapshot(
      buildProjectStateSnapshot(rawStore, summaryStore),
    );
  }

  private async writeStatsLog(
    sessionId: string,
    stats: Record<string, unknown>,
  ): Promise<void> {
    await this.sessionData.appendAfterTurnStats(sessionId, stats);
  }

  private async repairCompactedFlagsFromSummaries(
    verifiedEntries: Array<{ sessionId: string; startTurn: number; endTurn: number }>,
  ): Promise<void> {
    await this.sessionData.repairCompactedFlagsFromSummaries(verifiedEntries);
  }

  private async writeNavigationArtifactsIfPending(
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    memoryItemDraftStore: MemoryItemDraftRepository,
    compactionTriggeredThisStep: boolean,
  ): Promise<void> {
    if (this.config.emergencyBrake) {
      this.navigationSnapshotPending = false;
      return;
    }

    if (!this.navigationSnapshotPending && !compactionTriggeredThisStep) {
      return;
    }

    const navigationSnapshot = this.buildNavigationSnapshot(rawStore, summaryStore);
    const navigationWrite = await this.navigationRepository.writeNavigationSnapshot(
      this.config.workspaceDir,
      navigationSnapshot,
    );
    if (navigationWrite.written) {
      this.logger.info("navigation_snapshot_written", {
        filePath: navigationWrite.filePath,
      });
    }
    if (this.config.memoryItemEnabled) {
      const projectStateMemory = this.extractionEngine.buildProjectStateMemory(
        context.sessionId,
        new Date().toISOString(),
        navigationSnapshot,
      );
      await this.persistMemoryItemDrafts(memoryItemDraftStore, [projectStateMemory]);
      await this.sessionData.writeMemoryItemArtifacts();
    }
    await this.sessionData.writeNavigationSnapshot(navigationSnapshot);
    this.navigationSnapshotPending = false;
  }

  private async runLightweightAfterTurnCompaction(
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
  ): Promise<{ attempted: boolean; status: string; reason?: string; summaryId?: string } | null> {
    if (this.config.emergencyBrake) {
      return { attempted: false, status: "skipped", reason: "emergency_brake_enabled" };
    }
    const eligibleTurnCount = this.compactionEngine.countEligibleTurnsForCompaction(
      rawStore,
      summaryStore,
      this.config.freshTailTokens,
      this.config.maxFreshTailTurns,
      context.sessionId,
    );
    if (eligibleTurnCount < Math.max(1, this.config.compactionBatchTurns)) {
      return { attempted: false, status: "skipped", reason: "insufficient_closed_turns" };
    }
    const candidate = this.compactionEngine.selectTurnsForCompaction(
      rawStore,
      summaryStore,
      this.config.freshTailTokens,
      this.config.maxFreshTailTurns,
      this.config.compactionBatchTurns,
      context.sessionId,
    );
    if (!candidate) {
      return { attempted: false, status: "skipped", reason: "no_compaction_candidate" };
    }
    const compaction = await this.compactionCoordinator.runSerializedCompaction(
      rawStore,
      summaryStore,
      context,
      true,
    );
    if (compaction.status === "compacted" || compaction.status === "deduped") {
      return {
        attempted: true,
        status: compaction.status,
        summaryId: compaction.summary.id,
      };
    }
    return {
      attempted: true,
      status: compaction.status,
      reason: compaction.reason,
    };
  }

  private async rollUpSummaryTree(
    summaryStore: SummaryRepository,
    context: LifecycleContext,
  ): Promise<void> {
    let passes = 0;
    while (passes < 4) {
      passes += 1;
      const rollup = await this.summaryHierarchyEngine.rollUp(
        summaryStore,
        context.sessionId,
        this.config.agentId,
        context.summaryModel,
        this.config.summaryMaxOutputTokens,
      );
      if (!rollup) {
        return;
      }
      this.navigationSnapshotPending = true;
      await this.sessionData.appendSummaryArtifact(rollup);
    }
  }

  private async persistEvidenceAtomsForSummary(summary: SummaryEntry): Promise<void> {
    const summaryLevel = summary.summaryLevel ?? 1;
    const nodeKind = summary.nodeKind ?? "leaf";
    if (summaryLevel > 1 || nodeKind !== "leaf") {
      return;
    }
    const atoms = this.evidenceAtomEngine.fromSummary(summary);
    if (atoms.length === 0) {
      return;
    }
    await this.sessionData.upsertEvidenceAtoms(atoms);
    try {
      await this.sessionData.getRuntimeStore().recordEvidenceAtoms(atoms);
    } catch (error) {
      this.logger.warn("evidence_atom_runtime_record_failed", {
        summaryId: summary.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async updateProjectRegistry(
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
  ): Promise<void> {
    const snapshot = buildProjectStateSnapshot(rawStore, summaryStore);
    let identity = deriveProjectIdentityFromSnapshot(
      snapshot,
      `${this.config.agentId}-${context.sessionId}`,
    );
    const activeSummaries = summaryStore
      .getActiveSummaries()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    let projectSummaries = activeSummaries
      .filter((entry) => entry.projectId === identity.projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (projectSummaries.length === 0 && activeSummaries.length > 0) {
      identity = deriveProjectIdentityFromSummary(
        activeSummaries[0],
        `${this.config.agentId}-${context.sessionId}`,
      );
      snapshot.projectId = identity.projectId;
      snapshot.projectTitle = identity.title;
      projectSummaries = activeSummaries.filter((entry) => entry.projectId === identity.projectId);
    }

    const memoryItems = this.sessionData.getRuntimeStore().listMemoryItems({ agentId: this.config.agentId });
    let projectMemories = memoryItems
      .filter((entry) => entry.status === "active" && entry.projectId === identity.projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (projectMemories.length === 0) {
      projectMemories = memoryItems
        .filter((entry) => entry.status === "active")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    await this.sessionData.upsertProjectRecord({
      id: identity.projectId,
      agentId: this.config.agentId,
      canonicalKey: identity.canonicalKey,
      title: snapshot.projectTitle || identity.title,
      status: deriveProjectStatusFromSnapshot(snapshot),
      summary: projectSummaries[0]?.summary ?? snapshot.active,
      activeFocus: snapshot.active,
      currentDecision: snapshot.decision,
      nextStep: snapshot.next,
      todo: snapshot.todo,
      blocker: snapshot.blocker,
      risk: snapshot.risk,
      tags: [
        identity.canonicalKey,
        ...projectSummaries.flatMap((entry) => entry.keywords).slice(0, 12),
        ...projectMemories.flatMap((entry) => entry.tags).slice(0, 12),
      ],
      sourceSessionIds: [context.sessionId],
      summaryIds: projectSummaries.map((entry) => entry.id),
      memoryIds: projectMemories.map((entry) => entry.id),
      topicIds: [
        identity.topicId,
        ...projectSummaries.map((entry) => entry.topicId).filter((value): value is string => Boolean(value)),
        ...projectMemories.map((entry) => entry.topicId).filter((value): value is string => Boolean(value)),
      ],
      latestSummaryId: projectSummaries[0]?.id,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
  }

  private getActiveStores(): SessionDataStores {
    return this.sessionData.getStores();
  }
}

