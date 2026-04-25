import { ContextAssembler } from "../engines/ContextAssembler";
import { CompactionEngine } from "../engines/CompactionEngine";
import {
  BridgeConfig,
  DurableMemoryRepository,
  FixedPrefixProvider,
  HostFixedContextProvider,
  LoggerLike,
  RawMessageRepository,
  SummaryEntry,
  SummaryRepository,
  CompactionRunResult,
} from "../types";
import { LifecycleContext } from "../host/OpenClawPayloadAdapter";
import { CompactionDiagnostics } from "./ChaunyomsSessionRuntime";

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

interface CompactionCoordinatorDependencies {
  logger: LoggerLike;
  assembler: ContextAssembler;
  fixedPrefixProvider: FixedPrefixProvider;
  hostFixedContextProvider: HostFixedContextProvider;
  compactionEngine: CompactionEngine;
  getConfig: () => BridgeConfig;
  getDurableMemoryStore: () => DurableMemoryRepository;
  setNavigationSnapshotPending: () => void;
  getDiagnostics: () => CompactionDiagnostics | null;
  setDiagnostics: (value: CompactionDiagnostics | null) => void;
  onBarrierCompacted: (entry: SummaryEntry, context: LifecycleContext, summaryStore: SummaryRepository) => Promise<void>;
}

export class CompactionCoordinator {
  private compactionInFlight: Promise<CompactionRunResult> | null = null;

  constructor(private readonly deps: CompactionCoordinatorDependencies) {}

  async runBestEffortCompaction(
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
  ): Promise<{ compacted: boolean; entry: SummaryEntry | null }> {
    const compaction = await this.runSerializedCompaction(
      rawStore,
      summaryStore,
      context,
    );
    const entry = compaction.status === "compacted" || compaction.status === "deduped"
      ? compaction.summary
      : null;
    return { compacted: Boolean(entry), entry };
  }

  async runCompactionBarrier(
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
      this.deps.setDiagnostics({
        sessionId: context.sessionId,
        mode: "barrier",
        triggerExceeded: false,
        triggerThreshold: budgetState.triggerBudget,
        compressibleHistoryTokens: budgetState.compressibleHistoryTokens,
        compressibleHistoryBudget: budgetState.compressibleHistoryBudget,
        hostFixedTokens: budgetState.hostFixedTokens,
        hostFixedTokenSource: budgetState.hostFixedTokenSource,
        pluginFixedTokens: budgetState.pluginFixedTokens,
        freshTailTokens: budgetState.freshTailTokens,
        status: "skipped",
        reason: "barrier_not_required",
      });
      return;
    }

    const tokensBefore = budgetState.compressibleHistoryTokens;
    const maxPasses = 12;
    let passes = 0;

    while (budgetState.compressibleHistoryTokens > budgetState.compressibleHistoryBudget) {
      passes += 1;
      if (passes > maxPasses) {
        this.deps.logger.warn("compaction_barrier_soft_failed", {
          sessionId: context.sessionId,
          reason: "max_passes_exceeded",
          compressibleHistoryTokens: budgetState.compressibleHistoryTokens,
          compressibleHistoryBudget: budgetState.compressibleHistoryBudget,
          passes,
        });
        this.deps.setDiagnostics({
          sessionId: context.sessionId,
          mode: "barrier",
          triggerExceeded: true,
          triggerThreshold: budgetState.triggerBudget,
          compressibleHistoryTokens: budgetState.compressibleHistoryTokens,
          compressibleHistoryBudget: budgetState.compressibleHistoryBudget,
          hostFixedTokens: budgetState.hostFixedTokens,
          hostFixedTokenSource: budgetState.hostFixedTokenSource,
          pluginFixedTokens: budgetState.pluginFixedTokens,
          freshTailTokens: budgetState.freshTailTokens,
          passes,
          status: "failed",
          reason: "max_passes_exceeded",
        });
        return;
      }

      const compaction = await this.runSerializedCompaction(
        rawStore,
        summaryStore,
        context,
        true,
      );
      if (compaction.status !== "compacted" && compaction.status !== "deduped") {
        const reason = compaction.reason ?? compaction.status;
        this.deps.logger.warn("compaction_barrier_soft_failed", {
          sessionId: context.sessionId,
          reason,
          compressibleHistoryTokens: budgetState.compressibleHistoryTokens,
          compressibleHistoryBudget: budgetState.compressibleHistoryBudget,
          passes,
        });
        this.deps.setDiagnostics({
          sessionId: context.sessionId,
          mode: "barrier",
          triggerExceeded: true,
          triggerThreshold: budgetState.triggerBudget,
          compressibleHistoryTokens: budgetState.compressibleHistoryTokens,
          compressibleHistoryBudget: budgetState.compressibleHistoryBudget,
          hostFixedTokens: budgetState.hostFixedTokens,
          hostFixedTokenSource: budgetState.hostFixedTokenSource,
          pluginFixedTokens: budgetState.pluginFixedTokens,
          freshTailTokens: budgetState.freshTailTokens,
          passes,
          status: "failed",
          reason,
        });
        return;
      }
      const entry = compaction.summary;
      await this.deps.onBarrierCompacted(entry, context, summaryStore);
      budgetState = await this.measureCompactionBudgetState(
        context,
        rawStore,
        summaryStore,
        activeQuery,
      );
    }

    if (budgetState.hostFixedTokens + budgetState.pluginFixedTokens + budgetState.freshTailTokens > context.totalBudget) {
      this.deps.logger.warn("compaction_fixed_and_fresh_over_trigger_budget", {
        sessionId: context.sessionId,
        hostFixedTokens: budgetState.hostFixedTokens,
        hostFixedTokenSource: budgetState.hostFixedTokenSource,
        pluginFixedTokens: budgetState.pluginFixedTokens,
        freshTailTokens: budgetState.freshTailTokens,
        triggerBudget: budgetState.triggerBudget,
        totalBudget: context.totalBudget,
      });
    }

    this.deps.logger.info("compaction_barrier_recovered_context", {
      sessionId: context.sessionId,
      tokensBefore,
      tokensAfter: budgetState.compressibleHistoryTokens,
      triggerThreshold: this.deps.getConfig().contextThreshold,
      hostFixedTokens: budgetState.hostFixedTokens,
      hostFixedTokenSource: budgetState.hostFixedTokenSource,
      pluginFixedTokens: budgetState.pluginFixedTokens,
      freshTailTokens: budgetState.freshTailTokens,
      compressibleHistoryBudget: budgetState.compressibleHistoryBudget,
      passes,
      strictCompaction: this.deps.getConfig().strictCompaction,
    });
    this.deps.setDiagnostics({
      sessionId: context.sessionId,
      mode: "barrier",
      triggerExceeded: true,
      triggerThreshold: budgetState.triggerBudget,
      compressibleHistoryTokens: budgetState.compressibleHistoryTokens,
      compressibleHistoryBudget: budgetState.compressibleHistoryBudget,
      hostFixedTokens: budgetState.hostFixedTokens,
      hostFixedTokenSource: budgetState.hostFixedTokenSource,
      pluginFixedTokens: budgetState.pluginFixedTokens,
      freshTailTokens: budgetState.freshTailTokens,
      passes,
      status: "compacted",
      reason: "barrier_recovered_context_budget",
    });
  }

  async measureCompactionBudgetState(
    context: LifecycleContext,
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    activeQuery?: string,
  ): Promise<CompactionBudgetState> {
    const config = this.deps.getConfig();
    const durableMemoryStore = this.deps.getDurableMemoryStore();
    const budget = this.deps.assembler.allocateBudget(
      context.totalBudget,
      context.systemPromptTokens,
    );
    const stablePrefix = await this.deps.fixedPrefixProvider.load(
      config.sharedDataDir,
      config.workspaceDir,
      budget.stablePrefixBudget,
      { activeQuery },
    );
    const recallGuidance = this.deps.assembler.buildRecallGuidance(summaryStore, context.sessionId);
    const durableMemory = this.deps.assembler.assembleDurableMemory(
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
      config.freshTailTokens,
    );
    const freshTail = this.deps.assembler.assembleRecentTail(
      rawStore,
      effectiveTailBudget,
      config.freshTailTokens,
      config.maxFreshTailTurns,
      context.sessionId,
    );
    const freshTailTokens = freshTail.reduce((sum, item) => sum + item.tokenCount, 0);

    const compressibleHistoryTokens = this.deps.compactionEngine.measureCompressibleHistoryTokens(
      rawStore,
      summaryStore,
      config.freshTailTokens,
      config.maxFreshTailTurns,
      context.sessionId,
    );
    const hostFixedResolved =
      context.systemPromptTokens > 0
        ? {
            tokens: context.systemPromptTokens,
            source: "systemPromptTokens" as const,
          }
        : {
            tokens: await this.deps.hostFixedContextProvider.estimateWorkspaceBootstrapTokens(
              config.workspaceDir,
            ),
            source: "workspaceBootstrapEstimate" as const,
          };
    const hostFixedTokens = hostFixedResolved.tokens;
    const availableBudget = Math.max(context.totalBudget - hostFixedTokens, 0);
    const triggerBudget = Math.floor(availableBudget * config.contextThreshold);
    const compressibleHistoryBudget = Math.max(triggerBudget - pluginFixedTokens - freshTailTokens, 0);

    return {
      availableBudget,
      hostFixedTokens,
      hostFixedTokenSource: hostFixedResolved.source,
      pluginFixedTokens,
      triggerBudget,
      freshTailTokens,
      compressibleHistoryTokens,
      compressibleHistoryBudget,
      triggerExceeded: pluginFixedTokens + freshTailTokens + compressibleHistoryTokens > triggerBudget,
    };
  }

  async runSerializedCompaction(
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    context: LifecycleContext,
    bypassThreshold = false,
  ): Promise<CompactionRunResult> {
    if (this.compactionInFlight) {
      return await this.compactionInFlight;
    }
    const config = this.deps.getConfig();
    const run = this.deps.compactionEngine.runCompaction(
      rawStore,
      summaryStore,
      context.totalBudget,
      config.contextThreshold,
      config.strictCompaction,
      config.freshTailTokens,
      config.maxFreshTailTurns,
      context.summaryModel,
      config.summaryMaxOutputTokens,
      context.sessionId,
      config.agentId,
      config.compactionBatchTurns,
      bypassThreshold,
    );
    this.compactionInFlight = run;
    try {
      const result = await run;
      if (result.status === "compacted" || result.status === "deduped") {
        this.deps.setNavigationSnapshotPending();
      }
      return result;
    } finally {
      if (this.compactionInFlight === run) {
        this.compactionInFlight = null;
      }
    }
  }
}
