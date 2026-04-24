import { createHash } from "node:crypto";

import { ContextAssembler } from "../engines/ContextAssembler";
import { CompactionEngine } from "../engines/CompactionEngine";
import { KnowledgeIntakeGate } from "../engines/KnowledgeIntakeGate";
import { KnowledgePromotionEngine } from "../engines/KnowledgePromotionEngine";
import { MemoryExtractionEngine } from "../engines/MemoryExtractionEngine";
import { SummaryHierarchyEngine } from "../engines/SummaryHierarchyEngine";
import { BackgroundOrganizerEngine } from "../engines/BackgroundOrganizerEngine";
import {
  SessionDataLayer,
  SessionDataStores,
  SummaryIntegrityInspection,
} from "../data/SessionDataLayer";
import { ExternalSystemBootstrap } from "../system/ExternalSystemBootstrap";
import {
  BridgeConfig,
  ContextItem,
  ContextViewRepository,
  DurableMemoryRepository,
  DurableMemoryEntry,
  FixedPrefixProvider,
  HostFixedContextProvider,
  LlmCaller,
  LoggerLike,
  NavigationRepository,
  ObservationRepository,
  ObservationEntry,
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
import {
  deriveProjectIdentityFromSnapshot,
  deriveProjectIdentityFromSummary,
  deriveProjectStatusFromSnapshot,
} from "../utils/projectIdentity";
import { SourceMessageResolver } from "../resolvers/SourceMessageResolver";
import { RuntimeMessageIngress } from "./RuntimeMessageIngress";

interface CompactionBudgetState {
  availableBudget: number;
  hostFixedTokens: number;
  hostFixedTokenSource: "systemPromptTokens" | "workspaceBootstrapEstimate";
  pluginFixedTokens: number;
  triggerBudget: number;
  freshTailTokens: number;
  compressibleHistoryTokens: number;
  compressibleHistoryBudget: number;
  triggerExceeded: boolean;
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
  compactedThisTurn: boolean;
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
  private knowledgePromotionEngine: KnowledgePromotionEngine;
  private summaryHierarchyEngine: SummaryHierarchyEngine;
  private backgroundOrganizerEngine: BackgroundOrganizerEngine;
  private externalSystemBootstrap: ExternalSystemBootstrap;
  private compactionEngine: CompactionEngine;
  private readonly sourceMessageResolver = new SourceMessageResolver();
  private llmCaller: LlmCaller | null;
  private compactionInFlight: Promise<SummaryEntry | null> | null = null;
  private knowledgeMaintenanceInFlight: Promise<void> | null = null;
  private readonly pendingKnowledgeMaintenance = new Map<string, {
    sessionId: string;
    config: BridgeConfig;
    summaryModel?: string;
  }>();
  private navigationSnapshotPending = false;
  private readonly runtimeIngress = new RuntimeMessageIngress();
  private static readonly DEFAULT_KNOWLEDGE_OVERRIDE_RE =
    /(帮我记一下|记住这个|记一下这个|放进知识库|扔进知识库|加入知识库|写进知识库|加入wiki|写进wiki|沉淀进知识库|remember this|remember this for later|save this to knowledge|put this in (?:the )?knowledge base|add this to wiki|store this in (?:the )?knowledge base)/i;

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
    this.externalSystemBootstrap = new ExternalSystemBootstrap(this.logger);
    this.compactionEngine = new CompactionEngine(llmCaller, this.logger);
    this.knowledgePromotionEngine = new KnowledgePromotionEngine(llmCaller, this.logger);
    this.summaryHierarchyEngine = new SummaryHierarchyEngine(llmCaller, this.logger);
    this.backgroundOrganizerEngine = new BackgroundOrganizerEngine(this.logger);
  }

  updateHost(logger: LoggerLike, llmCaller: LlmCaller | null): void {
    this.logger = logger;
    this.llmCaller = llmCaller;
    this.externalSystemBootstrap = new ExternalSystemBootstrap(this.logger);
    this.compactionEngine = new CompactionEngine(llmCaller, this.logger);
    this.knowledgePromotionEngine = new KnowledgePromotionEngine(llmCaller, this.logger);
    this.summaryHierarchyEngine = new SummaryHierarchyEngine(llmCaller, this.logger);
    this.backgroundOrganizerEngine = new BackgroundOrganizerEngine(this.logger);
  }

  getConfig(): BridgeConfig {
    return this.config;
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
    await this.externalSystemBootstrap.ensure(this.config.sharedDataDir);
    await this.ensureSession(context.sessionId, context.config);
    const integrityInspection = this.inspectSummaryIntegrity();
    await this.repairCompactedFlagsFromSummaries(integrityInspection.verifiedEntries);
    const integrity = this.toIntegrityStats(integrityInspection);
    if (integrity.mismatched > 0) {
      this.logger.warn("summary_integrity_mismatch_detected", integrity);
    }
    this.scheduleKnowledgeMaintenance(context);
    return { importedMessages: 0, integrity };
  }

  async waitForBackgroundWork(): Promise<void> {
    while (this.knowledgeMaintenanceInFlight) {
      await this.knowledgeMaintenanceInFlight;
    }
  }

  async ingest(payload: IngestPayload): Promise<{ ingested: boolean }> {
    const { rawStore, durableMemoryStore } = await this.ensureSession(payload.sessionId, payload.config);
    const turnNumber = payload.turnNumber ?? this.resolveNextTurnNumber(rawStore, payload.role);
    const message: RawMessage = {
      id: payload.id,
      sessionId: payload.sessionId,
      agentId: payload.config.agentId,
      role: payload.role,
      content: payload.content,
      turnNumber,
      createdAt: new Date().toISOString(),
      tokenCount: estimateTokens(payload.content),
      compacted: false,
      metadata: payload.metadata,
    };
    await rawStore.append(message);
    await this.persistDurableMemories(
      durableMemoryStore,
      this.extractionEngine.extractFromRawMessage(message),
    );
    await this.sessionData.writeDurableMemoryArtifacts();
    return { ingested: true };
  }

  async assemble(context: LifecycleContext): Promise<AssembleResult> {
    const { rawStore, summaryStore, durableMemoryStore } = await this.ensureSession(
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
      await this.runCompactionBarrier(
        context,
        rawStore,
        summaryStore,
        activeQuery,
      );
    }

    try {
      const result = await this.assembler.assemble(
        rawStore,
        summaryStore,
        durableMemoryStore,
        context.totalBudget,
        context.systemPromptTokens,
        this.config.freshTailTokens,
        this.config.maxFreshTailTurns,
        this.config.sharedDataDir,
        this.config.workspaceDir,
        {
          includeStablePrefix: !this.config.emergencyBrake,
          includeSummaries: !this.config.emergencyBrake,
          includeDurableMemory: !this.config.emergencyBrake,
          activeQuery,
          sessionId: context.sessionId,
        },
      );
      return {
        items: result.items,
        estimatedTokens: result.items.reduce((sum, item) => sum + item.tokenCount, 0),
        importedMessages: synced.importedMessages,
      };
    } catch (error) {
      this.logger.warn("assemble_failed_recent_tail_fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
      const fallback = this.assembler.assembleRecentTail(
        rawStore,
        Math.max(context.totalBudget - context.systemPromptTokens, 0),
        this.config.freshTailTokens,
        this.config.maxFreshTailTurns,
        context.sessionId,
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
    const { rawStore, summaryStore, durableMemoryStore } = await this.ensureSession(
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
    const entry = await this.runSerializedCompaction(
      rawStore,
      summaryStore,
      context,
    );

    if (!entry) {
      return {
        ok: true,
        compacted: false,
        reason: "threshold_not_met_or_no_candidate",
      };
    }

    await this.enqueueSummaryForKnowledge(entry, context);
    await this.rollUpSummaryTree(summaryStore, context);
    await this.writeNavigationArtifactsIfPending(
      context,
      rawStore,
      summaryStore,
      durableMemoryStore,
      true,
    );
    await this.backgroundOrganizerEngine.run(
      durableMemoryStore,
      summaryStore,
      this.getActiveStores().projectStore,
      this.config.agentId,
    );

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
        },
      },
    };
  }

  async afterTurn(context: LifecycleContext): Promise<AfterTurnResult> {
    const { rawStore, summaryStore, observationStore, durableMemoryStore } = await this.ensureSession(
      context.sessionId,
      context.config,
    );
    const synced = await this.syncRuntimeMessages(
      context.sessionId,
      context.config,
      context.runtimeMessages,
    );

    const compactionResult = this.config.emergencyBrake
      ? { compacted: false, entry: null as SummaryEntry | null }
      : await this.runBestEffortCompaction(context, rawStore, summaryStore);

    if (compactionResult.entry) {
      await this.enqueueSummaryForKnowledge(compactionResult.entry, context);
      await this.sessionData.appendSummaryArtifact(compactionResult.entry);
      await this.rollUpSummaryTree(summaryStore, context);
    }

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
      durableMemoryCount: durableMemoryStore.count(),
      managedKnowledgeDir: this.config.knowledgePromotionEnabled ? knowledgeStore.getBaseDir() : null,
      knowledgeImportDir: this.config.knowledgeBaseDir,
      contextItems: this.contextViewStore.getItems().length,
      compactedThisTurn: compactionResult.compacted,
      importedMessages: synced.importedMessages,
      strictCompaction: this.config.strictCompaction,
      compactionBarrierEnabled: this.config.compactionBarrierEnabled,
      runtimeCaptureEnabled: this.config.runtimeCaptureEnabled,
      durableMemoryEnabled: this.config.durableMemoryEnabled,
      autoRecallEnabled: this.config.autoRecallEnabled,
      knowledgePromotionEnabled: this.config.knowledgePromotionEnabled,
      emergencyBrake: this.config.emergencyBrake,
    };
    this.logger.info("after_turn_stats", stats);
    await this.writeStatsLog(context.sessionId, stats);

    await this.writeNavigationArtifactsIfPending(
      context,
      rawStore,
      summaryStore,
      durableMemoryStore,
      compactionResult.compacted,
    );
    await this.updateProjectRegistry(context, rawStore, summaryStore, durableMemoryStore);
    await this.backgroundOrganizerEngine.run(
      durableMemoryStore,
      summaryStore,
      this.getActiveStores().projectStore,
      this.config.agentId,
    );

    return {
      stats,
      importedMessages: synced.importedMessages,
      compactedThisTurn: compactionResult.compacted,
    };
  }

  async getSessionStores(context: Pick<LifecycleContext, "sessionId" | "config">): Promise<SessionDataStores> {
    return await this.ensureSession(context.sessionId, context.config);
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

    const { rawStore, observationStore, durableMemoryStore } = await this.ensureSession(sessionId, config);
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

    const normalizedMessages = inspectedMessages
      .filter(({ decision }) => decision.persist)
      .map(({ message, decision }) => ({
        ...message,
        text: decision.normalizedText,
        storageTarget: decision.storageTarget,
        metadata: {
          ...(message.metadata ?? {}),
          runtimeClassification: decision.classification,
          runtimePersistenceReason: decision.reason,
        },
      }));

    if (normalizedMessages.length === 0) {
      return { importedMessages: 0 };
    }

    const rawCandidates = normalizedMessages.filter((message) => message.storageTarget === "raw_message");
    const observationCandidates = normalizedMessages.filter((message) => message.storageTarget === "observation");

    const existingMessages = rawStore
      .getAll()
      .filter(
        (message) =>
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "tool",
      );
    const existingSourceKeys = new Set(
      existingMessages
        .map((message) => {
          const sourceKey = message.metadata?.importedSourceKey;
          return typeof sourceKey === "string" ? sourceKey : null;
        })
        .filter((value): value is string => Boolean(value)),
    );

    const existingObservationSourceKeys = new Set(
      observationStore
        .getAll()
        .map((item) => item.sourceKey),
    );

    const overlap = this.findRuntimeOverlap(existingMessages, rawCandidates);
    const pendingRawMessages = rawCandidates
      .slice(overlap)
      .filter((message) => !existingSourceKeys.has(message.sourceKey));
    const pendingObservationMessages = observationCandidates.filter(
      (message) => !existingObservationSourceKeys.has(message.sourceKey),
    );

    let importedMessages = 0;
    let currentTurn = existingMessages[existingMessages.length - 1]?.turnNumber ?? 0;

    for (let index = 0; index < pendingRawMessages.length; index += 1) {
      const message = pendingRawMessages[index];
      currentTurn = this.resolveRuntimeTurnNumber(currentTurn, message.role);
      const rawMessage: RawMessage = {
        id:
          message.id ??
          this.buildRuntimeMessageId(
            sessionId,
            message.role,
            message.text,
            currentTurn,
            overlap + index,
        ),
        sessionId,
        agentId: config.agentId,
        role: message.role,
        content: message.text,
        turnNumber: currentTurn,
        createdAt: this.resolveRuntimeTimestamp(message.timestamp),
        tokenCount: estimateTokens(message.text),
        compacted: false,
        metadata: {
          ...(message.metadata ?? {}),
          importedFromRuntimeMessages: true,
          importedSourceKey: message.sourceKey,
          runtimeIndex: overlap + index,
        },
      };
      await this.sessionData.appendRawMessage(rawMessage);
      await this.persistDurableMemories(
        durableMemoryStore,
        this.extractionEngine.extractFromRawMessage(rawMessage),
      );
      existingSourceKeys.add(message.sourceKey);
      importedMessages += 1;
    }

    for (let index = 0; index < pendingObservationMessages.length; index += 1) {
      const message = pendingObservationMessages[index];
      const observation: ObservationEntry = {
        id:
          message.id ??
          `observation-${this.buildRuntimeMessageId(sessionId, message.role, message.text, 0, index)}`,
        sessionId,
        agentId: config.agentId,
        role: message.role,
        classification:
          typeof message.metadata?.runtimeClassification === "string"
            ? String(message.metadata.runtimeClassification)
            : "tool_output",
        content: message.text,
        sourceKey: message.sourceKey,
        createdAt: this.resolveRuntimeTimestamp(message.timestamp),
        tokenCount: estimateTokens(message.text),
        metadata: {
          ...(message.metadata ?? {}),
          importedFromRuntimeMessages: true,
          importedSourceKey: message.sourceKey,
          runtimeIndex: index,
        },
      };
      await this.sessionData.appendObservation(observation);
      await this.persistDurableMemories(
        durableMemoryStore,
        this.extractionEngine.extractFromObservation(observation),
      );
      await this.sessionData.writeDurableMemoryArtifacts();
      existingObservationSourceKeys.add(message.sourceKey);
      importedMessages += 1;
    }

    return { importedMessages };
  }

  private async persistDurableMemories(
    durableMemoryStore: DurableMemoryRepository,
    entries: DurableMemoryEntry[],
  ): Promise<void> {
    if (!this.config.durableMemoryEnabled || this.config.emergencyBrake || entries.length === 0) {
      return;
    }
    await this.sessionData.addDurableEntries(entries);
  }

  private resolveRuntimeTurnNumber(
    currentTurn: number,
    role: RawMessage["role"],
  ): number {
    if (role === "user") {
      return Math.max(currentTurn + 1, 1);
    }
    return currentTurn > 0 ? currentTurn : 1;
  }

  private resolveNextTurnNumber(
    rawStore: RawMessageRepository,
    role: RawMessage["role"],
  ): number {
    const messages = rawStore.getAll();
    const lastTurn = messages[messages.length - 1]?.turnNumber ?? 0;
    return role === "user" ? lastTurn + 1 : Math.max(lastTurn, 1);
  }

  private findRuntimeOverlap(
    existingMessages: RawMessage[],
    runtimeMessages: Array<RuntimeMessageSnapshot & { storageTarget?: string }>,
  ): number {
    const maxOverlap = Math.min(existingMessages.length, runtimeMessages.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      let matched = true;
      for (let index = 0; index < overlap; index += 1) {
        const existing = existingMessages[existingMessages.length - overlap + index];
        const runtime = runtimeMessages[index];
        if (
          existing.role !== runtime.role ||
          this.normalizeMessageText(existing.content) !== this.normalizeMessageText(runtime.text)
        ) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return overlap;
      }
    }
    return 0;
  }

  private resolveActiveUserQuery(
    rawStore: RawMessageRepository,
    runtimeMessages: RuntimeMessageSnapshot[],
  ): string | undefined {
    for (let index = runtimeMessages.length - 1; index >= 0; index -= 1) {
      const message = runtimeMessages[index];
      if (message.role === "user" && message.text.trim().length > 0) {
        return message.text.trim();
      }
    }

    const messages = rawStore.getAll();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "user" && message.content.trim().length > 0) {
        return message.content.trim();
      }
    }

    return undefined;
  }

  private normalizeMessageText(content: string): string {
    return content.replace(/\s+/g, " ").trim();
  }

  private buildRuntimeMessageId(
    sessionId: string,
    role: RawMessage["role"],
    content: string,
    turnNumber: number,
    runtimeIndex: number,
  ): string {
    const digest = createHash("sha256")
      .update(
        `${sessionId}|${role}|${turnNumber}|${runtimeIndex}|${this.normalizeMessageText(content)}`,
        "utf8",
      )
      .digest("hex")
      .slice(0, 24);
    return `runtime-${digest}`;
  }

  private resolveRuntimeTimestamp(timestamp?: number | string): string {
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
    if (typeof timestamp === "string" && timestamp.trim().length > 0) {
      const parsed = new Date(timestamp);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    }
    return new Date().toISOString();
  }

  private async runBestEffortCompaction(
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
  ): Promise<{ compacted: boolean; entry: SummaryEntry | null }> {
    const entry = await this.runSerializedCompaction(
      rawStore,
      summaryStore,
      context,
    );
    return { compacted: Boolean(entry), entry };
  }

  private async runCompactionBarrier(
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    activeQuery?: string,
  ): Promise<void> {
    let budgetState = await this.measureCompactionBudgetState(
      context,
      rawStore,
      summaryStore,
      activeQuery,
    );
    if (!budgetState.triggerExceeded) {
      return;
    }

    const tokensBefore = budgetState.compressibleHistoryTokens;
    const maxPasses = 12;
    let passes = 0;

    while (budgetState.compressibleHistoryTokens > budgetState.compressibleHistoryBudget) {
      passes += 1;
      if (passes > maxPasses) {
        throw new Error(
          `Compaction barrier exceeded max passes before structural recovery (session=${context.sessionId})`,
        );
      }

      const entry = await this.runSerializedCompaction(
        rawStore,
        summaryStore,
        context,
        true,
      );
      if (!entry) {
        throw new Error(
          `Compaction barrier could not recover compressible history budget (session=${context.sessionId}, compressibleTokens=${budgetState.compressibleHistoryTokens}, budget=${budgetState.compressibleHistoryBudget})`,
        );
      }

      await this.enqueueSummaryForKnowledge(entry, context);
      await this.rollUpSummaryTree(summaryStore, context);
      budgetState = await this.measureCompactionBudgetState(
        context,
        rawStore,
        summaryStore,
        activeQuery,
      );
    }

    if (budgetState.hostFixedTokens + budgetState.pluginFixedTokens + budgetState.freshTailTokens > context.totalBudget) {
      this.logger.warn("compaction_fixed_and_fresh_over_trigger_budget", {
        sessionId: context.sessionId,
        hostFixedTokens: budgetState.hostFixedTokens,
        hostFixedTokenSource: budgetState.hostFixedTokenSource,
        pluginFixedTokens: budgetState.pluginFixedTokens,
        freshTailTokens: budgetState.freshTailTokens,
        triggerBudget: budgetState.triggerBudget,
        totalBudget: context.totalBudget,
      });
    }

    this.logger.info("compaction_barrier_recovered_context", {
      sessionId: context.sessionId,
      tokensBefore,
      tokensAfter: budgetState.compressibleHistoryTokens,
      triggerThreshold: this.config.contextThreshold,
      hostFixedTokens: budgetState.hostFixedTokens,
      hostFixedTokenSource: budgetState.hostFixedTokenSource,
      pluginFixedTokens: budgetState.pluginFixedTokens,
      freshTailTokens: budgetState.freshTailTokens,
      compressibleHistoryBudget: budgetState.compressibleHistoryBudget,
      passes,
      strictCompaction: this.config.strictCompaction,
    });
  }

  private async measureCompactionBudgetState(
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    activeQuery?: string,
  ): Promise<CompactionBudgetState> {
    const { durableMemoryStore } = this.getActiveStores();
    const budget = this.assembler.allocateBudget(
      context.totalBudget,
      context.systemPromptTokens,
    );
    const stablePrefix = await this.fixedPrefixProvider.load(
      this.config.sharedDataDir,
      this.config.workspaceDir,
      budget.stablePrefixBudget,
      {
        activeQuery,
      },
    );
    const recallGuidance = this.assembler.buildRecallGuidance(summaryStore, context.sessionId);
    const durableMemory = this.assembler.assembleDurableMemory(
      durableMemoryStore,
      budget.recallBudget,
    );
    const pluginFixedTokens = [
      ...stablePrefix,
      ...(recallGuidance ? [recallGuidance] : []),
      ...durableMemory,
    ].reduce((sum, item) => sum + item.tokenCount, 0);

    const effectiveTailBudget = Math.min(
      budget.recentTailBudget,
      this.config.freshTailTokens,
    );
    const freshTail = this.assembler.assembleRecentTail(
      rawStore,
      effectiveTailBudget,
      this.config.freshTailTokens,
      this.config.maxFreshTailTurns,
      context.sessionId,
    );
    const freshTailTokens = freshTail.reduce(
      (sum, item) => sum + item.tokenCount,
      0,
    );

    const compressibleHistoryTokens =
      this.compactionEngine.measureCompressibleHistoryTokens(
        rawStore,
        summaryStore,
        this.config.freshTailTokens,
        this.config.maxFreshTailTurns,
        context.sessionId,
      );
    const hostFixedResolved =
      context.systemPromptTokens > 0
        ? {
            tokens: context.systemPromptTokens,
            source: "systemPromptTokens" as const,
          }
        : {
            tokens: await this.hostFixedContextProvider.estimateWorkspaceBootstrapTokens(
              this.config.workspaceDir,
            ),
            source: "workspaceBootstrapEstimate" as const,
          };
    const hostFixedTokens = hostFixedResolved.tokens;
    const availableBudget = Math.max(
      context.totalBudget - hostFixedTokens,
      0,
    );
    const triggerBudget = Math.floor(availableBudget * this.config.contextThreshold);
    const compressibleHistoryBudget = Math.max(
      triggerBudget - pluginFixedTokens - freshTailTokens,
      0,
    );

    return {
      availableBudget,
      hostFixedTokens,
      hostFixedTokenSource: hostFixedResolved.source,
      pluginFixedTokens,
      triggerBudget,
      freshTailTokens,
      compressibleHistoryTokens,
      compressibleHistoryBudget,
      triggerExceeded:
        pluginFixedTokens + freshTailTokens + compressibleHistoryTokens > triggerBudget,
    };
  }

  private async enqueueSummaryForKnowledge(
    entry: SummaryEntry,
    context: LifecycleContext,
  ): Promise<void> {
    if (!this.config.knowledgePromotionEnabled || this.config.emergencyBrake) {
      return;
    }

    const { rawStore } = await this.ensureSession(
      context.sessionId,
      context.config,
    );
    const sourceResolution = this.sourceMessageResolver.resolve(rawStore, entry);
    if (sourceResolution.messages.length === 0) {
      this.logger.warn("knowledge_raw_intake_missing_source_messages", {
        summaryId: entry.id,
        sessionId: entry.sessionId,
        reason: sourceResolution.reason,
      });
      return;
    }

    const userOverride = this.resolveKnowledgeUserOverride(
      sourceResolution.messages,
      context.config,
    );
    const decision = userOverride
      ? {
          accepted: true,
          reason: userOverride,
        }
      : this.knowledgeIntakeGate.decide(entry, context.config);
    if (!decision.accepted) {
      this.logger.info("knowledge_raw_intake_rejected", {
        summaryId: entry.id,
        reason: decision.reason,
        summaryLevel: entry.summaryLevel ?? 1,
        nodeKind: entry.nodeKind ?? "leaf",
        memoryType: entry.memoryType ?? "general",
        promotionIntent: entry.promotionIntent ?? "candidate",
      });
      return;
    }

    const { knowledgeRawStore } = await this.ensureSession(
      context.sessionId,
      context.config,
    );
    const now = new Date().toISOString();
    const enqueued = await knowledgeRawStore.enqueue({
      id: `knowledge-raw-${entry.id}`,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      sourceSummaryId: entry.id,
      sourceSummary: entry,
      sourceBinding: sourceResolution.binding,
      intakeReason: decision.reason,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    if (!enqueued) {
      this.logger.info("knowledge_raw_intake_deduped", {
        summaryId: entry.id,
      });
      return;
    }

    this.logger.info("knowledge_raw_intake_enqueued", {
      summaryId: entry.id,
      reason: decision.reason,
    });
    this.scheduleKnowledgeMaintenance(context);
  }

  private scheduleKnowledgeMaintenance(context: Pick<LifecycleContext, "sessionId" | "config" | "summaryModel">): void {
    if (!context.config.knowledgePromotionEnabled || context.config.emergencyBrake) {
      return;
    }

    const key = `${context.config.agentId}|${context.sessionId}|${context.config.dataDir}`;
    this.pendingKnowledgeMaintenance.set(key, {
      sessionId: context.sessionId,
      config: context.config,
      summaryModel: context.summaryModel,
    });
    this.startKnowledgeMaintenanceLoop();
  }

  private startKnowledgeMaintenanceLoop(): void {
    if (this.knowledgeMaintenanceInFlight) {
      return;
    }

    this.knowledgeMaintenanceInFlight = (async () => {
      while (this.pendingKnowledgeMaintenance.size > 0) {
        const contexts = [...this.pendingKnowledgeMaintenance.values()];
        this.pendingKnowledgeMaintenance.clear();
        for (const context of contexts) {
          await this.processKnowledgeRawQueue(context);
        }
      }
    })()
      .catch((error) => {
        this.logger.warn("knowledge_raw_worker_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.knowledgeMaintenanceInFlight = null;
        if (this.pendingKnowledgeMaintenance.size > 0) {
          this.startKnowledgeMaintenanceLoop();
        }
      });
  }

  private async processKnowledgeRawQueue(context: {
    sessionId: string;
    config: BridgeConfig;
    summaryModel?: string;
  }): Promise<void> {
    const { rawStore, knowledgeRawStore, knowledgeStore } = await this.ensureSession(
      context.sessionId,
      context.config,
    );

    while (true) {
      const candidates = await knowledgeRawStore.claimPending(8);
      if (candidates.length === 0) {
        return;
      }

      for (const candidate of candidates) {
        try {
          const sourceResolution = this.sourceMessageResolver.resolve(
            rawStore,
            candidate.sourceBinding ?? candidate.sourceSummary,
          );
          if (sourceResolution.messages.length === 0) {
            await knowledgeRawStore.markSettled({
              id: candidate.id,
              status: "failed",
              reason: "missing_source_messages_for_knowledge_candidate",
            });
            continue;
          }
          if (!sourceResolution.verified) {
            await knowledgeRawStore.markSettled({
              id: candidate.id,
              status: "failed",
              reason: sourceResolution.reason,
            });
            continue;
          }

          const result = await this.knowledgePromotionEngine.promote({
            summaryEntry: candidate.sourceSummary,
            messages: sourceResolution.messages,
            sessionId: context.sessionId,
            summaryModel: context.summaryModel,
            knowledgePromotionModel: context.config.knowledgePromotionModel,
            knowledgeStore,
          });
          await knowledgeRawStore.markSettled({
            id: candidate.id,
            status: result.status,
            reason: result.reason,
            docId: result.docId,
            slug: result.slug,
            version: result.version,
            filePath: result.filePath,
          });
          this.logger.info("knowledge_raw_candidate_processed", {
            candidateId: candidate.id,
            summaryId: candidate.sourceSummaryId,
            status: result.status,
            reason: result.reason,
            slug: result.slug,
            version: result.version,
          });
        } catch (error) {
          await knowledgeRawStore.markSettled({
            id: candidate.id,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
          this.logger.warn("knowledge_raw_candidate_processing_failed", {
            candidateId: candidate.id,
            summaryId: candidate.sourceSummaryId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private resolveKnowledgeUserOverride(
    messages: RawMessage[],
    config: Pick<
      BridgeConfig,
      "knowledgeIntakeUserOverrideEnabled" | "knowledgeIntakeUserOverridePatterns"
    >,
  ): string | null {
    if (!config.knowledgeIntakeUserOverrideEnabled) {
      return null;
    }

    const customPatterns = (config.knowledgeIntakeUserOverridePatterns ?? [])
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "user") {
        continue;
      }
      const normalized = message.content.trim();
      if (!normalized) {
        continue;
      }
      if (ChaunyomsSessionRuntime.DEFAULT_KNOWLEDGE_OVERRIDE_RE.test(normalized)) {
        return "explicit_user_knowledge_override";
      }
      const lower = normalized.toLowerCase();
      if (customPatterns.some((pattern) => lower.includes(pattern))) {
        return "custom_user_knowledge_override";
      }
    }

    return null;
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

  private async runSerializedCompaction(
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    context: LifecycleContext,
    bypassThreshold = false,
  ): Promise<SummaryEntry | null> {
    if (this.compactionInFlight) {
      return await this.compactionInFlight;
    }

    const run = this.compactionEngine.runCompaction(
      rawStore,
      summaryStore,
      context.totalBudget,
      this.config.contextThreshold,
      this.config.strictCompaction,
      this.config.freshTailTokens,
      this.config.maxFreshTailTurns,
      context.summaryModel,
      this.config.summaryMaxOutputTokens,
      context.sessionId,
      this.config.agentId,
      this.config.compactionBatchTurns,
      bypassThreshold,
    );
    this.compactionInFlight = run;

    try {
      const entry = await run;
      if (entry) {
        this.navigationSnapshotPending = true;
      }
      return entry;
    } finally {
      if (this.compactionInFlight === run) {
        this.compactionInFlight = null;
      }
    }
  }

  private async writeNavigationArtifactsIfPending(
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    durableMemoryStore: DurableMemoryRepository,
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
    if (this.config.durableMemoryEnabled) {
      const projectStateMemory = this.extractionEngine.buildProjectStateMemory(
        context.sessionId,
        new Date().toISOString(),
        navigationSnapshot,
      );
      await this.persistDurableMemories(durableMemoryStore, [projectStateMemory]);
      await this.sessionData.writeDurableMemoryArtifacts();
    }
    await this.sessionData.writeNavigationSnapshot(navigationSnapshot);
    this.navigationSnapshotPending = false;
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

  private async updateProjectRegistry(
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    durableMemoryStore: DurableMemoryRepository,
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

    let projectMemories = durableMemoryStore
      .getAll()
      .filter((entry) => entry.recordStatus === "active" && entry.projectId === identity.projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    if (projectMemories.length === 0) {
      projectMemories = durableMemoryStore
        .getAll()
        .filter((entry) => entry.recordStatus === "active")
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
