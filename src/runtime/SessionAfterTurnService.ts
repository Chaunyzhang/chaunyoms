import type { LifecycleContext } from "../host/OpenClawPayloadAdapter";
import type {
  AfterTurnResult,
} from "./ChaunyomsSessionRuntime";
import type {
  BridgeConfig,
  MemoryItemDraftRepository,
  ObservationRepository,
  RawMessageRepository,
  SummaryRepository,
  LoggerLike,
} from "../types";
import { OpenClawProfilePolicy } from "./OpenClawProfilePolicy";

export interface SessionAfterTurnServiceDeps {
  getConfig: () => BridgeConfig;
  logger: LoggerLike;
  getKnowledgeBaseDir: () => string | null;
  getContextItemCount: () => number;
  getLastCompactionDiagnostics: () => unknown;
  getRuntimeMemoryItemCount: () => number;
  profilePolicy: OpenClawProfilePolicy;
  runLightweightAfterTurnCompaction: (
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
  ) => Promise<{ attempted: boolean; status: string; reason?: string; summaryId?: string } | null>;
  runBackgroundOrganizer: (
    memoryItemDraftStore: MemoryItemDraftRepository,
    summaryStore: SummaryRepository,
  ) => Promise<void>;
  updateProjectRegistry: (
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
  ) => Promise<void>;
  writeNavigationArtifactsIfPending: (
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    memoryItemDraftStore: MemoryItemDraftRepository,
    compactionTriggeredThisStep: boolean,
  ) => Promise<void>;
  writeStatsLog: (sessionId: string, stats: Record<string, unknown>) => Promise<void>;
}

export class SessionAfterTurnService {
  constructor(private readonly deps: SessionAfterTurnServiceDeps) {}

  async run(args: {
    context: LifecycleContext;
    rawStore: RawMessageRepository;
    summaryStore: SummaryRepository;
    observationStore: ObservationRepository;
    memoryItemDraftStore: MemoryItemDraftRepository;
    importedMessages: number;
  }): Promise<AfterTurnResult> {
    const config = this.deps.getConfig();
    const lightweightCompaction = this.deps.profilePolicy.shouldRunLightweightAfterTurnCompaction(config)
      ? await this.deps.runLightweightAfterTurnCompaction(
          args.context,
          args.rawStore,
          args.summaryStore,
        )
      : null;

    const stats = {
      timestamp: new Date().toISOString(),
      sessionId: args.context.sessionId,
      contextWindow: args.context.totalBudget,
      compactionTriggerThreshold: config.contextThreshold,
      uncompactedTokens: args.rawStore.totalUncompactedTokens({ sessionId: args.context.sessionId }),
      summaryCount: args.summaryStore.getAllSummaries().length,
      summaryTokens: args.summaryStore.getTotalTokens(),
      observationCount: args.observationStore.count(),
      memoryItemCount: this.deps.getRuntimeMemoryItemCount(),
      unifiedKnowledgeDir: config.knowledgePromotionEnabled ? this.deps.getKnowledgeBaseDir() : null,
      contextItems: this.deps.getContextItemCount(),
      importedMessages: args.importedMessages,
      strictCompaction: config.strictCompaction,
      compactionBarrierEnabled: config.compactionBarrierEnabled,
      runtimeCaptureEnabled: config.runtimeCaptureEnabled,
      memoryItemEnabled: config.memoryItemEnabled,
      autoRecallEnabled: config.autoRecallEnabled,
      knowledgePromotionEnabled: config.knowledgePromotionEnabled,
      configPreset: config.configPreset,
      semanticCandidateExpansionEnabled: config.semanticCandidateExpansionEnabled,
      semanticCandidateLimit: config.semanticCandidateLimit,
      lastCompactionDiagnostics: this.deps.getLastCompactionDiagnostics(),
      emergencyBrake: config.emergencyBrake,
      openClawRuntimeProfile: config.openClawRuntimeProfile,
      lightweightCompaction,
    };
    this.deps.logger.info("after_turn_stats", stats);
    await this.deps.writeStatsLog(args.context.sessionId, stats);

    if (this.deps.profilePolicy.shouldSkipProjectRegistryAfterTurn(config)) {
      const compactionTriggeredThisStep = lightweightCompaction?.status === "compacted" ||
        lightweightCompaction?.status === "deduped";
      await this.deps.writeNavigationArtifactsIfPending(
        args.context,
        args.rawStore,
        args.summaryStore,
        args.memoryItemDraftStore,
        compactionTriggeredThisStep,
      );
      return {
        stats,
        importedMessages: args.importedMessages,
      };
    }

    await this.deps.writeNavigationArtifactsIfPending(
      args.context,
      args.rawStore,
      args.summaryStore,
      args.memoryItemDraftStore,
      false,
    );
    await this.deps.updateProjectRegistry(args.context, args.rawStore, args.summaryStore);
    await this.deps.runBackgroundOrganizer(args.memoryItemDraftStore, args.summaryStore);

    return {
      stats,
      importedMessages: args.importedMessages,
    };
  }
}
