import { randomUUID } from "node:crypto";

import {
  LlmCaller,
  LoggerLike,
  RawMessage,
  RawMessageRepository,
  SummaryEntry,
  SummaryRepository,
  SummaryResult,
} from "../types";
import { estimateTokens } from "../utils/tokenizer";
import { hashRawMessages } from "../utils/integrity";
import {
  buildStableEventId,
  deriveProjectIdentityFromMessages,
} from "../utils/projectIdentity";
import { SourceMessageResolver } from "../resolvers/SourceMessageResolver";

const SUMMARY_MEMORY_TYPES = [
  "project_state",
  "decision",
  "constraint",
  "diagnostic",
  "preference",
  "feedback",
  "temporary_note",
  "general",
] as const;

const SUMMARY_PHASES = [
  "planning",
  "implementation",
  "validation",
  "fixing",
  "review",
  "active",
] as const;

const PROMOTION_INTENTS = [
  "navigation_only",
  "candidate",
  "promote",
  "priority_promote",
] as const;

export class CompactionEngine {
  constructor(
    private readonly llmCaller: LlmCaller | null,
    private readonly logger: LoggerLike,
  ) {}

  shouldCompact(
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    contextWindow: number,
    contextThreshold: number,
    freshTailTokens: number,
    maxFreshTailTurns: number,
    sessionId?: string,
  ): boolean {
    const normalizedThreshold = this.normalizeThresholdRatio(contextThreshold, 0.7);
    return (
      this.getCompactionPressureTokens(
        rawStore,
        summaryStore,
        freshTailTokens,
        maxFreshTailTurns,
        sessionId,
      ) > Math.floor(contextWindow * normalizedThreshold)
    );
  }

  measureCompressibleHistoryTokens(
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    freshTailTokens: number,
    maxFreshTailTurns: number,
    sessionId?: string,
  ): number {
    return this.getCompactionPressureTokens(
      rawStore,
      summaryStore,
      freshTailTokens,
      maxFreshTailTurns,
      sessionId,
    );
  }

  canUseLlmSummary(): boolean {
    return this.llmCaller !== null;
  }

  selectTurnsForCompaction(
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    freshTailTokens: number,
    maxFreshTailTurns: number,
    maxTurns = 20,
    sessionId?: string,
  ): { startTurn: number; endTurn: number; messages: RawMessage[] } | null {
    const query = { sessionId };
    const allMessages = rawStore.getAll(query);
    const lastClosedTurn = this.resolveLastClosedTurn(allMessages);
    if (lastClosedTurn <= 0) {
      return null;
    }

    const coveredTurns = summaryStore.getCoveredTurns(query);
    const uncompacted = rawStore
      .getUncompactedMessages(query)
      .filter(
        (message) =>
          message.turnNumber <= lastClosedTurn &&
          !coveredTurns.has(message.turnNumber),
      );
    const turnNumbers = [...new Set(uncompacted.map((message) => message.turnNumber))];
    if (turnNumbers.length === 0) {
      return null;
    }

    const protectedTurns = this.selectProtectedTailTurns(
      uncompacted,
      freshTailTokens,
      maxFreshTailTurns,
    );
    const candidateTurnNumbers = turnNumbers.filter((turnNumber) => !protectedTurns.has(turnNumber));
    const candidateTurns = candidateTurnNumbers.slice(0, Math.min(maxTurns, candidateTurnNumbers.length));
    if (candidateTurns.length === 0) {
      return null;
    }

    const startTurn = candidateTurns[0];
    const endTurn = candidateTurns[candidateTurns.length - 1];
    const messages = rawStore.getByRange(startTurn, endTurn, query).filter((message) => !message.compacted);
    return messages.length === 0 ? null : { startTurn, endTurn, messages };
  }

  async generateSummary(
    messages: RawMessage[],
    summaryModel: string | undefined,
    maxOutputTokens: number,
  ): Promise<SummaryResult | null> {
    if (!this.llmCaller) {
      return null;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const attemptMaxOutputTokens = Math.min(
          Math.max(maxOutputTokens * attempt, maxOutputTokens),
          1024,
        );
        const prompt = this.buildPrompt(messages, attempt);
        const raw = await this.llmCaller.call({
          model: summaryModel,
          prompt,
          temperature: 0.1,
          maxOutputTokens: attemptMaxOutputTokens,
          responseFormat: "json",
        });
        const parsed = this.parseSummaryResult(raw);
        if (parsed) {
          return parsed;
        }
      } catch (error) {
        this.logger.warn("summary_generation_failed", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }

  async runCompaction(
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    contextWindow: number,
    contextThreshold: number,
    strictCompaction: boolean,
    freshTailTokens: number,
    maxFreshTailTurns: number,
    summaryModel: string | undefined,
    maxOutputTokens: number,
    sessionId: string,
    agentId: string,
    maxTurns: number,
    bypassThreshold = false,
  ): Promise<SummaryEntry | null> {
    if (
      !bypassThreshold &&
      !this.shouldCompact(
        rawStore,
        summaryStore,
        contextWindow,
        contextThreshold,
        freshTailTokens,
        maxFreshTailTurns,
        sessionId,
      )
    ) {
      return null;
    }

    const candidate = this.selectTurnsForCompaction(
      rawStore,
      summaryStore,
      freshTailTokens,
      maxFreshTailTurns,
      maxTurns,
      sessionId,
    );
    if (!candidate) {
      return null;
    }

    try {
      if (strictCompaction && !this.canUseLlmSummary()) {
        this.logger.warn("strict_compaction_requires_llm", {
          sessionId,
          reason: "llm_unavailable",
        });
        return null;
      }

      const sourceHash = hashRawMessages(candidate.messages);
      const sourceMessageCount = candidate.messages.length;
      const existing = summaryStore.findBySourceCoverage(
        candidate.startTurn,
        candidate.endTurn,
        sourceHash,
        sourceMessageCount,
        { sessionId },
      );
      if (existing) {
        await rawStore.markCompacted(candidate.startTurn, candidate.endTurn, { sessionId });
        return existing;
      }

      const summary = strictCompaction
        ? await this.generateStrictSummary(candidate.messages, summaryModel, maxOutputTokens)
        : await this.generateSummary(candidate.messages, summaryModel, maxOutputTokens);
      if (!summary) {
        this.logger.warn("strict_compaction_summary_unavailable", {
          sessionId,
          startTurn: candidate.startTurn,
          endTurn: candidate.endTurn,
        });
        return null;
      }

      const projectIdentity = deriveProjectIdentityFromMessages(
        candidate.messages,
        `${agentId}-${sessionId}`,
      );
      const entry: SummaryEntry = {
        id: randomUUID(),
        eventId: buildStableEventId(
          "summary",
          `${sessionId}|${candidate.startTurn}|${candidate.endTurn}|${sourceHash}`,
        ),
        sessionId,
        agentId,
        projectId: projectIdentity.projectId,
        topicId: projectIdentity.topicId,
        recordStatus: "active",
        summary: summary.summary,
        keywords: summary.keywords,
        toneTag: summary.toneTag,
        memoryType: summary.memoryType,
        phase: summary.phase,
        constraints: summary.constraints,
        decisions: summary.decisions,
        blockers: summary.blockers,
        nextSteps: summary.nextSteps,
        keyEntities: summary.keyEntities,
        exactFacts: summary.exactFacts,
        promotionIntent: summary.promotionIntent,
        startTurn: candidate.startTurn,
        endTurn: candidate.endTurn,
        sourceFirstMessageId: candidate.messages[0]?.id,
        sourceLastMessageId: candidate.messages[candidate.messages.length - 1]?.id,
        sourceMessageIds: candidate.messages.map((message) => message.id),
        sourceStartTimestamp: candidate.messages[0]?.createdAt,
        sourceEndTimestamp: candidate.messages[candidate.messages.length - 1]?.createdAt,
        sourceSequenceMin: candidate.messages[0]?.sequence,
        sourceSequenceMax: candidate.messages[candidate.messages.length - 1]?.sequence,
        sourceBinding: SourceMessageResolver.bindingFromMessages({
          sessionId,
          agentId,
          messages: candidate.messages,
          sourceHash,
          sourceMessageCount,
        }),
        summaryLevel: 1,
        nodeKind: "leaf",
        tokenCount: estimateTokens(summary.summary),
        createdAt: new Date().toISOString(),
        sourceHash,
        sourceMessageCount,
      };

      await summaryStore.addSummary(entry);
      await rawStore.markCompacted(candidate.startTurn, candidate.endTurn, { sessionId });
      return entry;
    } catch (error) {
      this.logger.warn("compaction_skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private buildPrompt(messages: RawMessage[], attempt: number): string {
    const transcript = messages
      .map((message) => `Turn ${message.turnNumber} | ${message.role}\n${message.content}`)
      .join("\n\n");

    return [
      "You are generating a high-quality structured memory node for a context engine.",
      "Do not optimize for extreme brevity. Optimize for factual retention, structure, and future reuse.",
      "Return JSON with exactly these keys: summary, keywords, toneTag, memoryType, phase, constraints, decisions, blockers, nextSteps, keyEntities, exactFacts, promotionIntent.",
      "Output only one JSON object. Do not wrap it in markdown.",
      "Do not output any extra commentary before or after the JSON object.",
      attempt > 1
        ? "Important: suppress reasoning and emit the final JSON object immediately."
        : "",
      "summary must be structured, fact-preserving, and readable by both humans and downstream organizer logic.",
      "keywords must be an array of short search terms.",
      "toneTag must be a short phrase describing the dialogue tone.",
      `memoryType must be one of: ${SUMMARY_MEMORY_TYPES.join(", ")}.`,
      "phase must be a short lifecycle label such as planning, implementation, validation, fixing, review, or active.",
      "constraints must list explicit limits, requirements, and must-not rules.",
      "decisions must list concrete decisions or settled implementation choices.",
      "blockers must list concrete failures, risks, or unresolved blockers.",
      "nextSteps must list concrete next actions or follow-up work.",
      "keyEntities must list important project names, files, modules, APIs, components, or other retrieval anchors.",
      "exactFacts must list exact numbers, file names, config keys, parameter values, and other precise anchors that should survive compression.",
      `promotionIntent must be one of: ${PROMOTION_INTENTS.join(", ")}.`,
      "Prefer promote or priority_promote only when the node is strong enough to become a reusable long-term asset.",
      "",
      transcript,
    ].join("\n");
  }

  private parseSummaryResult(raw: string): SummaryResult | null {
    const direct = this.normalizeSummaryCandidate(this.tryParseJsonObject(raw));
    if (direct) {
      return direct;
    }

    const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
    if (fencedMatch) {
      const fenced = this.normalizeSummaryCandidate(this.tryParseJsonObject(fencedMatch[1]));
      if (fenced) {
        return fenced;
      }
    }

    const embedded = this.normalizeSummaryCandidate(
      this.tryParseJsonObject(this.extractJson(raw)),
    );
    if (embedded) {
      return embedded;
    }

    return null;
  }

  private tryParseJsonObject(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private async generateStrictSummary(
    messages: RawMessage[],
    summaryModel: string | undefined,
    maxOutputTokens: number,
  ): Promise<SummaryResult | null> {
    if (!this.llmCaller) {
      return null;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const attemptMaxOutputTokens = Math.min(
          Math.max(maxOutputTokens * attempt, maxOutputTokens),
          1024,
        );
        const prompt = this.buildPrompt(messages, attempt);
        const raw = await this.llmCaller.call({
          model: summaryModel,
          prompt,
          temperature: 0.1,
          maxOutputTokens: attemptMaxOutputTokens,
          responseFormat: "json",
        });
        const parsed = this.parseSummaryResult(raw);
        if (parsed) {
          return parsed;
        }
      } catch (error) {
        this.logger.warn("strict_summary_generation_failed", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }

  private normalizeSummaryCandidate(candidate: unknown): SummaryResult | null {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }

    const candidateRecord = candidate as Record<string, unknown>;
    if (
      typeof candidateRecord.summary === "string" &&
      Array.isArray(candidateRecord.keywords) &&
      typeof candidateRecord.toneTag === "string"
    ) {
      return {
        summary: candidateRecord.summary,
        keywords: candidateRecord.keywords.map((keyword) => String(keyword)),
        toneTag: candidateRecord.toneTag,
        memoryType: this.normalizeMemoryType(candidateRecord.memoryType),
        phase:
          typeof candidateRecord.phase === "string"
            ? this.normalizePhase(candidateRecord.phase)
            : undefined,
        constraints: Array.isArray(candidateRecord.constraints)
          ? candidateRecord.constraints.map((item) => String(item))
          : [],
        decisions: Array.isArray(candidateRecord.decisions)
          ? candidateRecord.decisions.map((item) => String(item))
          : [],
        blockers: Array.isArray(candidateRecord.blockers)
          ? candidateRecord.blockers.map((item) => String(item))
          : [],
        nextSteps: Array.isArray(candidateRecord.nextSteps)
          ? candidateRecord.nextSteps.map((item) => String(item))
          : [],
        keyEntities: Array.isArray(candidateRecord.keyEntities)
          ? candidateRecord.keyEntities.map((item) => String(item))
          : [],
        exactFacts: Array.isArray(candidateRecord.exactFacts)
          ? candidateRecord.exactFacts.map((item) => String(item))
          : [],
        promotionIntent: this.normalizePromotionIntent(candidateRecord.promotionIntent),
      };
    }

    if (Array.isArray(candidateRecord.content)) {
      const text = candidateRecord.content
        .flatMap((part) => {
          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            return [(part as { text: string }).text];
          }
          return [];
        })
        .join("\n");
      if (!text.trim()) {
        return null;
      }
      return this.parseSummaryResult(text);
    }

    return null;
  }

  private extractJson(raw: string): string {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  }

  private normalizeMemoryType(value: unknown): SummaryResult["memoryType"] {
    const candidate = String(value ?? "").trim();
    return (SUMMARY_MEMORY_TYPES as readonly string[]).includes(candidate)
      ? (candidate as SummaryResult["memoryType"])
      : "general";
  }

  private normalizePromotionIntent(value: unknown): SummaryResult["promotionIntent"] {
    const candidate = String(value ?? "").trim();
    return (PROMOTION_INTENTS as readonly string[]).includes(candidate)
      ? (candidate as SummaryResult["promotionIntent"])
      : "candidate";
  }

  private normalizePhase(value: unknown): SummaryResult["phase"] {
    const candidate = String(value ?? "").trim().toLowerCase();
    return (SUMMARY_PHASES as readonly string[]).includes(candidate)
      ? (candidate as SummaryResult["phase"])
      : undefined;
  }

  private resolveLastClosedTurn(messages: RawMessage[]): number {
    let maxClosedTurn = 0;
    for (const message of messages) {
      if (message.role === "assistant") {
        maxClosedTurn = Math.max(maxClosedTurn, message.turnNumber);
      }
    }
    return maxClosedTurn;
  }

  private normalizeThresholdRatio(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
  }

  private getCompactionPressureTokens(
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    freshTailTokens: number,
    maxFreshTailTurns: number,
    sessionId?: string,
  ): number {
    const query = { sessionId };
    const allMessages = rawStore.getAll(query);
    const lastClosedTurn = this.resolveLastClosedTurn(allMessages);
    if (lastClosedTurn <= 0) {
      return 0;
    }

    const coveredTurns = summaryStore.getCoveredTurns(query);
    const uncompacted = rawStore
      .getUncompactedMessages(query)
      .filter(
        (message) =>
          message.turnNumber <= lastClosedTurn &&
          !coveredTurns.has(message.turnNumber),
      );

    if (uncompacted.length === 0) {
      return 0;
    }

    const protectedTurns = this.selectProtectedTailTurns(
      uncompacted,
      freshTailTokens,
      maxFreshTailTurns,
    );

    return uncompacted.reduce((sum, message) => (
      protectedTurns.has(message.turnNumber) ? sum : sum + message.tokenCount
    ), 0);
  }

  private selectProtectedTailTurns(
    messages: RawMessage[],
    freshTailTokens: number,
    maxFreshTailTurns: number,
  ): Set<number> {
    if (freshTailTokens <= 0 || maxFreshTailTurns <= 0) {
      return new Set<number>();
    }

    const turnNumbers = [...new Set(messages.map((message) => message.turnNumber))];
    const protectedTurns = new Set<number>();
    let consumed = 0;

    for (let index = turnNumbers.length - 1; index >= 0; index -= 1) {
      const turnNumber = turnNumbers[index];
      const turnTokens = messages
        .filter((message) => message.turnNumber === turnNumber)
        .reduce((sum, message) => sum + message.tokenCount, 0);

      if (protectedTurns.size > 0 && consumed + turnTokens > freshTailTokens) {
        break;
      }

      protectedTurns.add(turnNumber);
      consumed += turnTokens;

      if (protectedTurns.size >= maxFreshTailTurns) {
        break;
      }
    }

    return protectedTurns;
  }
}
