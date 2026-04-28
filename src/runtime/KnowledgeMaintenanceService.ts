import { SourceMessageResolver } from "../resolvers/SourceMessageResolver";
import { BridgeConfig, KnowledgeRawEntry, LoggerLike, RawMessage, SummaryEntry } from "../types";
import { LifecycleContext } from "../host/OpenClawPayloadAdapter";
import { KnowledgePromotionEngine } from "../engines/KnowledgePromotionEngine";
import { SessionDataStores } from "../data/SessionDataLayer";
import { KnowledgeIntakeGate } from "../engines/KnowledgeIntakeGate";
import { KnowledgeCandidateScorer } from "../engines/KnowledgeCandidateScorer";
import {
  detectKnowledgeIntentPhrase,
  isPromoteKnowledgeIntent,
} from "../utils/knowledgeIntent";

interface KnowledgeMaintenanceDependencies {
  logger: LoggerLike;
  sourceMessageResolver: SourceMessageResolver;
  knowledgePromotionEngine: KnowledgePromotionEngine;
  knowledgeIntakeGate: KnowledgeIntakeGate;
  knowledgeCandidateScorer: KnowledgeCandidateScorer;
  ensureSession: (sessionId: string, config: BridgeConfig) => Promise<SessionDataStores>;
}

export class KnowledgeMaintenanceService {
  private knowledgeMaintenanceInFlight: Promise<void> | null = null;
  private readonly pendingKnowledgeMaintenance = new Map<string, {
    sessionId: string;
    config: BridgeConfig;
    summaryModel?: string;
  }>();

  constructor(private readonly deps: KnowledgeMaintenanceDependencies) {}

  async waitForBackgroundWork(): Promise<void> {
    while (this.knowledgeMaintenanceInFlight) {
      await this.knowledgeMaintenanceInFlight;
    }
  }

  schedule(context: Pick<LifecycleContext, "sessionId" | "config" | "summaryModel">): void {
    if (!this.canProcessKnowledgeWrites(context.config)) {
      return;
    }
    const key = `${context.config.agentId}|${context.sessionId}|${context.config.dataDir}`;
    this.pendingKnowledgeMaintenance.set(key, {
      sessionId: context.sessionId,
      config: context.config,
      summaryModel: context.summaryModel,
    });
    this.startLoop();
  }

  async enqueueSummaryForKnowledge(
    entry: SummaryEntry,
    context: LifecycleContext,
  ): Promise<void> {
    if (!this.canCreateKnowledgeCandidate(context.config)) {
      return;
    }

    const { rawStore, knowledgeRawStore } = await this.deps.ensureSession(
      context.sessionId,
      context.config,
    );
    const sourceResolution = this.deps.sourceMessageResolver.resolve(rawStore, entry);
    if (sourceResolution.messages.length === 0) {
      this.deps.logger.warn("knowledge_raw_intake_missing_source_messages", {
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
      : this.deps.knowledgeIntakeGate.decide(entry, context.config);
    if (!decision.accepted) {
      this.deps.logger.info("knowledge_raw_intake_rejected", {
        summaryId: entry.id,
        reason: decision.reason,
        summaryLevel: entry.summaryLevel ?? 1,
        nodeKind: entry.nodeKind ?? "leaf",
        memoryType: entry.memoryType ?? "general",
        promotionIntent: entry.promotionIntent ?? "candidate",
      });
      return;
    }

    const score = this.deps.knowledgeCandidateScorer.score(entry, sourceResolution.messages);
    if (!userOverride && !this.passesCandidateStrictness(score.total, context.config)) {
      this.deps.logger.info("knowledge_raw_intake_rejected", {
        summaryId: entry.id,
        reason: "candidate_score_below_kb_promotion_strictness",
        strictness: context.config.kbPromotionStrictness,
        score: score.total,
        recommendation: score.recommendation,
      });
      return;
    }

    const now = new Date().toISOString();
    const autoPromote = this.shouldAutoPromote(score.total, context.config, Boolean(userOverride));
    const enqueued = await knowledgeRawStore.enqueue({
      id: `knowledge-raw-${entry.id}`,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      sourceSummaryId: entry.id,
      sourceSummary: entry,
      sourceBinding: sourceResolution.binding,
      oneLineSummary: this.deps.knowledgeCandidateScorer.summarize(entry),
      score,
      review: {
        mode: autoPromote ? "auto" : "manual",
        state: autoPromote ? "auto_accepted" : "awaiting_review",
      },
      intakeReason: decision.reason,
      status: autoPromote ? "pending" : "review_pending",
      createdAt: now,
      updatedAt: now,
    });
    if (!enqueued) {
      this.deps.logger.info("knowledge_raw_intake_deduped", {
        summaryId: entry.id,
      });
      return;
    }

    this.deps.logger.info("knowledge_raw_intake_enqueued", {
      summaryId: entry.id,
      reason: decision.reason,
      oneLineSummary: this.deps.knowledgeCandidateScorer.summarize(entry),
      score: score.total,
      recommendation: score.recommendation,
      reviewMode: autoPromote ? "auto" : "manual",
      kbPromotionMode: context.config.kbPromotionMode,
      kbPromotionStrictness: context.config.kbPromotionStrictness,
      kbWriteEnabled: context.config.kbWriteEnabled,
      kbExportEnabled: context.config.kbExportEnabled,
    });
    if (autoPromote) {
      this.schedule(context);
    }
  }

  private startLoop(): void {
    if (this.knowledgeMaintenanceInFlight) {
      return;
    }
    this.knowledgeMaintenanceInFlight = (async () => {
      while (this.pendingKnowledgeMaintenance.size > 0) {
        const contexts = [...this.pendingKnowledgeMaintenance.values()];
        this.pendingKnowledgeMaintenance.clear();
        for (const context of contexts) {
          await this.processQueue(context);
        }
      }
    })()
      .catch((error) => {
        this.deps.logger.warn("knowledge_raw_worker_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.knowledgeMaintenanceInFlight = null;
        if (this.pendingKnowledgeMaintenance.size > 0) {
          this.startLoop();
        }
      });
  }

  private async processQueue(context: {
    sessionId: string;
    config: BridgeConfig;
    summaryModel?: string;
  }): Promise<void> {
    if (!this.canProcessKnowledgeWrites(context.config)) {
      return;
    }
    const { rawStore, knowledgeRawStore, knowledgeStore } = await this.deps.ensureSession(
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
          const sourceResolution = this.deps.sourceMessageResolver.resolve(
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

          const result = await this.deps.knowledgePromotionEngine.promote({
            summaryEntry: candidate.sourceSummary,
            messages: sourceResolution.messages,
            sessionId: context.sessionId,
            summaryModel: context.summaryModel,
            knowledgePromotionModel: context.config.knowledgePromotionModel,
            config: context.config,
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
          const trustModel = knowledgeStore.describeTrustModel();
          this.deps.logger.info("knowledge_raw_candidate_processed", {
            candidateId: candidate.id,
            summaryId: candidate.sourceSummaryId,
            status: result.status,
            reason: result.reason,
            slug: result.slug,
            version: result.version,
            bucket: result.draft?.bucket,
            canonicalKey: result.draft?.canonicalKey,
            sourceVerified: sourceResolution.verified,
            sourceMessageCount: sourceResolution.messages.length,
            trustLayer: trustModel.layer,
            requiresProvenance: trustModel.requiresProvenance,
          });
        } catch (error) {
          await knowledgeRawStore.markSettled({
            id: candidate.id,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
          this.deps.logger.warn("knowledge_raw_candidate_processing_failed", {
            candidateId: candidate.id,
            summaryId: candidate.sourceSummaryId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private canCreateKnowledgeCandidate(config: BridgeConfig): boolean {
    return config.kbCandidateEnabled && !config.emergencyBrake;
  }

  private canProcessKnowledgeWrites(config: BridgeConfig): boolean {
    return config.kbWriteEnabled && config.kbExportEnabled && !config.emergencyBrake;
  }

  private shouldAutoPromote(score: number, config: BridgeConfig, force = false): boolean {
    if (!this.canProcessKnowledgeWrites(config)) {
      return false;
    }
    if (force && this.isAutoPromotionMode(config.kbPromotionMode)) {
      return true;
    }
    switch (config.kbPromotionMode) {
      case "conservative_auto":
        return score >= 75 && this.passesCandidateStrictness(score, config);
      case "balanced_auto":
        return score >= 50 && this.passesCandidateStrictness(score, config);
      case "aggressive_auto":
        return score >= 35 && this.passesCandidateStrictness(score, config);
      case "manual":
      case "assisted":
      default:
        return false;
    }
  }

  private isAutoPromotionMode(mode: BridgeConfig["kbPromotionMode"]): boolean {
    return mode === "conservative_auto" || mode === "balanced_auto" || mode === "aggressive_auto";
  }

  private passesCandidateStrictness(score: number, config: Pick<BridgeConfig, "kbPromotionStrictness">): boolean {
    switch (config.kbPromotionStrictness) {
      case "low":
        return score >= 25;
      case "medium":
        return score >= 40;
      case "high":
      default:
        return score >= 50;
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
      if (isPromoteKnowledgeIntent(message.metadata?.knowledgeIntent)) {
        return "explicit_user_knowledge_intent";
      }
      if (detectKnowledgeIntentPhrase(normalized)) {
        return "explicit_user_knowledge_override";
      }
      const lower = normalized.toLowerCase();
      if (customPatterns.some((pattern) => lower.includes(pattern))) {
        return "custom_user_knowledge_override";
      }
    }

    return null;
  }
}
