import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { ContextAssembler } from "../engines/ContextAssembler";
import { CompactionEngine } from "../engines/CompactionEngine";
import { ContextViewStore } from "../stores/ContextViewStore";
import { RawMessageStore } from "../stores/RawMessageStore";
import { StablePrefixStore } from "../stores/StablePrefixStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import { ExternalSystemBootstrap } from "../system/ExternalSystemBootstrap";
import {
  BridgeConfig,
  ContextItem,
  LlmCaller,
  LoggerLike,
  RawMessage,
} from "../types";
import { hashRawMessages } from "../utils/integrity";
import { estimateTokens } from "../utils/tokenizer";
import {
  IngestPayload,
  LifecycleContext,
  RuntimeMessageSnapshot,
} from "../host/OpenClawPayloadAdapter";

interface SessionStores {
  rawStore: RawMessageStore;
  summaryStore: SummaryIndexStore;
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

export class ChaunyomsSessionRuntime {
  private config: BridgeConfig;
  private logger: LoggerLike;
  private rawStore: RawMessageStore | null = null;
  private summaryStore: SummaryIndexStore | null = null;
  private readonly contextViewStore = new ContextViewStore();
  private readonly assembler = new ContextAssembler(this.contextViewStore);
  private readonly stablePrefixStore = new StablePrefixStore();
  private externalSystemBootstrap: ExternalSystemBootstrap;
  private compactionEngine: CompactionEngine;

  constructor(
    logger: LoggerLike,
    llmCaller: LlmCaller | null,
    initialConfig: BridgeConfig,
  ) {
    this.logger = logger;
    this.config = initialConfig;
    this.externalSystemBootstrap = new ExternalSystemBootstrap(this.logger);
    this.compactionEngine = new CompactionEngine(llmCaller, this.logger);
  }

  updateHost(logger: LoggerLike, llmCaller: LlmCaller | null): void {
    this.logger = logger;
    this.externalSystemBootstrap = new ExternalSystemBootstrap(this.logger);
    this.compactionEngine = new CompactionEngine(llmCaller, this.logger);
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
    const integrity = this.validateSummaryIntegrity();
    if (integrity.mismatched > 0) {
      this.logger.warn("summary_integrity_mismatch_detected", integrity);
    }
    return { importedMessages: 0, integrity };
  }

  async ingest(payload: IngestPayload): Promise<{ ingested: boolean }> {
    const { rawStore } = await this.ensureSession(payload.sessionId, payload.config);
    const turnNumber = payload.turnNumber ?? this.resolveNextTurnNumber(rawStore, payload.role);
    const message: RawMessage = {
      id: payload.id,
      sessionId: payload.sessionId,
      role: payload.role,
      content: payload.content,
      turnNumber,
      createdAt: new Date().toISOString(),
      tokenCount: estimateTokens(payload.content),
      compacted: false,
      metadata: payload.metadata,
    };
    await rawStore.append(message);
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

    try {
      const result = await this.assembler.assemble(
        rawStore,
        summaryStore,
        context.totalBudget,
        context.systemPromptTokens,
        this.config.freshTailTokens,
        this.config.maxFreshTailTurns,
        this.config.sharedDataDir,
        this.config.workspaceDir,
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
    const { rawStore, summaryStore } = await this.ensureSession(
      context.sessionId,
      context.config,
    );
    await this.syncRuntimeMessages(
      context.sessionId,
      context.config,
      context.runtimeMessages,
    );
    const tokensBefore = rawStore.totalUncompactedTokens();
    const entry = await this.compactionEngine.runCompaction(
      rawStore,
      summaryStore,
      context.totalBudget,
      this.config.contextThreshold,
      this.config.freshTailTokens,
      this.config.maxFreshTailTurns,
      context.summaryModel,
      this.config.summaryMaxOutputTokens,
      context.sessionId,
      this.config.compactionBatchTurns,
    );

    if (!entry) {
      return {
        ok: true,
        compacted: false,
        reason: "threshold_not_met_or_no_candidate",
      };
    }

    return {
      ok: true,
      compacted: true,
      result: {
        summary: entry.summary,
        tokensBefore,
        tokensAfter: rawStore.totalUncompactedTokens(),
        details: {
          startTurn: entry.startTurn,
          endTurn: entry.endTurn,
          summaryId: entry.id,
        },
      },
    };
  }

  async afterTurn(context: LifecycleContext): Promise<AfterTurnResult> {
    const { rawStore, summaryStore } = await this.ensureSession(
      context.sessionId,
      context.config,
    );
    const synced = await this.syncRuntimeMessages(
      context.sessionId,
      context.config,
      context.runtimeMessages,
    );
    const compactionResult = await this.runBestEffortCompaction(context, rawStore, summaryStore);
    const stats = {
      timestamp: new Date().toISOString(),
      sessionId: context.sessionId,
      contextWindow: context.totalBudget,
      contextThreshold: this.config.contextThreshold,
      uncompactedTokens: rawStore.totalUncompactedTokens(),
      summaryCount: summaryStore.getAllSummaries().length,
      summaryTokens: summaryStore.getTotalTokens(),
      contextItems: this.contextViewStore.getItems().length,
      compactedThisTurn: compactionResult.compacted,
      importedMessages: synced.importedMessages,
    };
    this.logger.info("after_turn_stats", stats);
    await this.writeStatsLog(context.sessionId, stats);

    const navigationSnapshot = this.buildNavigationSnapshot(rawStore, summaryStore);
    const navigationWrite = await this.stablePrefixStore.writeNavigationSnapshot(
      this.config.workspaceDir,
      navigationSnapshot,
    );
    if (navigationWrite.written) {
      this.logger.info("navigation_snapshot_written", {
        filePath: navigationWrite.filePath,
      });
    }

    return {
      stats,
      importedMessages: synced.importedMessages,
      compactedThisTurn: compactionResult.compacted,
    };
  }

  async getSessionStores(context: Pick<LifecycleContext, "sessionId" | "config">): Promise<SessionStores> {
    return await this.ensureSession(context.sessionId, context.config);
  }

  private async ensureSession(
    sessionId: string,
    config: BridgeConfig,
  ): Promise<SessionStores> {
    if (
      this.rawStore &&
      this.summaryStore &&
      this.config.sessionId === sessionId &&
      this.config.dataDir === config.dataDir &&
      this.config.workspaceDir === config.workspaceDir &&
      this.config.sharedDataDir === config.sharedDataDir
    ) {
      return {
        rawStore: this.rawStore,
        summaryStore: this.summaryStore,
      };
    }

    this.config = config;
    this.rawStore = new RawMessageStore(this.config.dataDir, sessionId);
    this.summaryStore = new SummaryIndexStore(this.config.dataDir, sessionId);
    await this.rawStore.init();
    await this.summaryStore.init();
    return {
      rawStore: this.rawStore,
      summaryStore: this.summaryStore,
    };
  }

  private async syncRuntimeMessages(
    sessionId: string,
    config: BridgeConfig,
    runtimeMessages: RuntimeMessageSnapshot[],
  ): Promise<{ importedMessages: number }> {
    const { rawStore } = await this.ensureSession(sessionId, config);
    const normalizedMessages = runtimeMessages.filter(
      (message) =>
        (message.role === "user" ||
          message.role === "assistant" ||
          message.role === "tool") &&
        message.text.length > 0,
    );

    if (normalizedMessages.length === 0) {
      return { importedMessages: 0 };
    }

    const existingMessages = rawStore
      .getAll()
      .filter(
        (message) =>
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "tool",
      );
    const overlap = this.findRuntimeOverlap(existingMessages, normalizedMessages);
    const pendingMessages = normalizedMessages.slice(overlap);
    if (pendingMessages.length === 0) {
      return { importedMessages: 0 };
    }

    let currentTurn = existingMessages[existingMessages.length - 1]?.turnNumber ?? 0;
    for (let index = 0; index < pendingMessages.length; index += 1) {
      const message = pendingMessages[index];
      currentTurn = this.resolveRuntimeTurnNumber(currentTurn, message.role);
      await rawStore.append({
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
        role: message.role,
        content: message.text,
        turnNumber: currentTurn,
        createdAt: this.resolveRuntimeTimestamp(message.timestamp),
        tokenCount: estimateTokens(message.text),
        compacted: false,
        metadata: {
          ...(message.metadata ?? {}),
          importedFromRuntimeMessages: true,
          runtimeIndex: overlap + index,
        },
      });
    }

    return { importedMessages: pendingMessages.length };
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
    rawStore: RawMessageStore,
    role: RawMessage["role"],
  ): number {
    const messages = rawStore.getAll();
    const lastTurn = messages[messages.length - 1]?.turnNumber ?? 0;
    return role === "assistant" ? Math.max(lastTurn, 1) : lastTurn + 1;
  }

  private findRuntimeOverlap(
    existingMessages: RawMessage[],
    runtimeMessages: RuntimeMessageSnapshot[],
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
    const digest = Buffer.from(
      `${sessionId}|${role}|${turnNumber}|${runtimeIndex}|${this.normalizeMessageText(content)}`,
      "utf8",
    )
      .toString("base64")
      .replace(/[+/=]/g, "")
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
    rawStore: RawMessageStore,
    summaryStore: SummaryIndexStore,
  ): Promise<{ compacted: boolean }> {
    const entry = await this.compactionEngine.runCompaction(
      rawStore,
      summaryStore,
      context.totalBudget,
      this.config.contextThreshold,
      this.config.freshTailTokens,
      this.config.maxFreshTailTurns,
      context.summaryModel,
      this.config.summaryMaxOutputTokens,
      context.sessionId,
      this.config.compactionBatchTurns,
    );
    return { compacted: Boolean(entry) };
  }

  private validateSummaryIntegrity(): {
    total: number;
    verified: number;
    mismatched: number;
    unchecked: number;
  } {
    const { rawStore, summaryStore } = this.getActiveStores();
    const summaries = summaryStore.getAllSummaries();
    let verified = 0;
    let mismatched = 0;
    let unchecked = 0;

    for (const summary of summaries) {
      if (!summary.sourceHash || typeof summary.sourceMessageCount !== "number") {
        unchecked += 1;
        continue;
      }
      const sourceMessages = rawStore.getByRange(summary.startTurn, summary.endTurn);
      const actualHash = hashRawMessages(sourceMessages);
      const actualCount = sourceMessages.length;
      if (
        actualHash !== summary.sourceHash ||
        actualCount !== summary.sourceMessageCount
      ) {
        mismatched += 1;
      } else {
        verified += 1;
      }
    }

    return { total: summaries.length, verified, mismatched, unchecked };
  }

  private buildNavigationSnapshot(
    rawStore: RawMessageStore,
    summaryStore: SummaryIndexStore,
  ): string {
    const latestMessages = rawStore.getAll().slice(-12);
    const latestUser =
      [...latestMessages].reverse().find((item) => item.role === "user")?.content ?? "(none)";
    const latestAssistant =
      [...latestMessages].reverse().find((item) => item.role === "assistant")?.content ?? "(none)";
    const latestSummary = summaryStore.getAllSummaries().at(-1);
    const blocker =
      [...latestMessages]
        .reverse()
        .find((item) =>
          /(blocker|blocked|error|fail|issue|risk|阻塞|卡住|失败|报错)/i.test(item.content),
        )
        ?.content ?? "none recorded";
    const pending =
      latestUser !== "(none)"
        ? latestUser
        : "review outstanding work from the latest session";
    const nextAction =
      latestAssistant !== "(none)"
        ? latestAssistant
        : "continue the active thread from the latest user request";
    const today = new Date();
    const dateLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return [
      `${dateLabel}:`,
      `- active: ${this.truncateNavigationLine(latestUser)}`,
      `- decision: ${this.truncateNavigationLine(latestAssistant)}`,
      `- todo: review follow-up actions from latest turn`,
      `- next: ${this.truncateNavigationLine(nextAction)}`,
      `- pending: ${this.truncateNavigationLine(pending)}`,
      `- blocker: ${this.truncateNavigationLine(blocker)}`,
      `- risk: ${blocker === "none recorded" ? "none recorded" : "latest blocker needs follow-up"}`,
      `- recall: ${latestSummary ? `summary:${latestSummary.id} turns ${latestSummary.startTurn}-${latestSummary.endTurn}` : "none"}`,
    ].join("\n");
  }

  private truncateNavigationLine(input: string, maxChars = 120): string {
    const normalized = input.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, maxChars - 3)}...`;
  }

  private async writeStatsLog(
    sessionId: string,
    stats: Record<string, unknown>,
  ): Promise<void> {
    const logDir = path.join(this.config.dataDir, "logs");
    await mkdir(logDir, { recursive: true });
    await appendFile(
      path.join(logDir, `${sessionId}.after-turn.log`),
      `${JSON.stringify(stats)}\n`,
      "utf8",
    );
  }

  private getActiveStores(): SessionStores {
    if (!this.rawStore || !this.summaryStore) {
      throw new Error("Chaunyoms runtime stores are not initialized");
    }
    return {
      rawStore: this.rawStore,
      summaryStore: this.summaryStore,
    };
  }
}
