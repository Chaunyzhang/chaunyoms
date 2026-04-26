import { createHash, randomUUID } from "node:crypto";

import {
  CompactionRunResult,
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

const LEVEL_ONE_TARGET_RATIO = 0.12;
const COMPACTION_BATCH_TARGET_TOKENS = 24000;
const COMPACTION_BATCH_MIN_TOKENS = 12000;
const COMPACTION_BATCH_MAX_TOKENS = 48000;

function isSummarySourceMessage(message: RawMessage): boolean {
  return message.role === "user" || message.role === "assistant";
}

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
    const candidateTurns = this.selectAdaptiveCandidateTurns(
      uncompacted,
      candidateTurnNumbers,
      maxTurns,
    );
    if (candidateTurns.length === 0) {
      return null;
    }

    const startTurn = candidateTurns[0];
    const endTurn = candidateTurns[candidateTurns.length - 1];
    const messages = rawStore
      .getByRange(startTurn, endTurn, query)
      .filter((message) => !message.compacted && isSummarySourceMessage(message));
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

    const outputBudget = this.resolveLevelOneOutputBudget(messages, maxOutputTokens);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const prompt = this.buildPrompt(messages, attempt, outputBudget);
        const raw = await this.llmCaller.call({
          model: summaryModel,
          prompt,
          temperature: 0.1,
          maxOutputTokens: outputBudget,
          responseFormat: "text",
        });
        const parsed = this.parseSummaryResult(raw);
        if (parsed && !this.isLongerThanSource(parsed, messages)) {
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
  ): Promise<CompactionRunResult> {
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
      return { status: "skipped", reason: "threshold_not_met" };
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
      return { status: "skipped", reason: "no_compaction_candidate" };
    }

    try {
      if (strictCompaction && !this.canUseLlmSummary()) {
        this.logger.warn("strict_compaction_requires_llm", {
          sessionId,
          reason: "llm_unavailable",
        });
        return { status: "skipped", reason: "strict_compaction_requires_llm" };
      }

      const sourceHash = hashRawMessages(candidate.messages);
      const sourceMessageCount = candidate.messages.length;
      const sourceBinding = SourceMessageResolver.bindingFromMessages({
        sessionId,
        agentId,
        messages: candidate.messages,
        sourceHash,
        sourceMessageCount,
      });
      const sourceTrace = SourceMessageResolver.traceFromResolution(
        {
          binding: sourceBinding,
          messages: candidate.messages,
          strategy: "message_ids",
          verified: true,
          reason: "compaction_source_messages_verified",
          actualHash: sourceHash,
          actualMessageCount: sourceMessageCount,
        },
        { route: "compaction" },
      );
      const existing = summaryStore.findBySourceCoverage(
        candidate.startTurn,
        candidate.endTurn,
        sourceHash,
        sourceMessageCount,
        { sessionId },
      );
      if (existing) {
        await rawStore.markCompacted(candidate.startTurn, candidate.endTurn, { sessionId });
        return {
          status: "deduped",
          summary: existing,
          sourceBinding: existing.sourceBinding ?? sourceBinding,
          sourceTrace,
        };
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
        return { status: "skipped", reason: "summary_unavailable" };
      }

      const projectIdentity = deriveProjectIdentityFromMessages(
        candidate.messages,
        `${agentId}-${sessionId}`,
      );
      const summaryTokenCount = estimateTokens(summary.summary);
      const sourceTokenEstimate = this.sumSummarySourceTokens(candidate.messages);
      const summaryId = randomUUID();
      const entry: SummaryEntry = {
        id: summaryId,
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
        openQuestions: summary.openQuestions,
        conflicts: summary.conflicts,
        candidateAtomPreviews: summary.candidateAtomPreviews,
        startTurn: candidate.startTurn,
        endTurn: candidate.endTurn,
        sourceFirstMessageId: candidate.messages[0]?.id,
        sourceLastMessageId: candidate.messages[candidate.messages.length - 1]?.id,
        sourceMessageIds: candidate.messages.map((message) => message.id),
        sourceRefs: this.buildSourceRefs(candidate.messages),
        sourceStartTimestamp: candidate.messages[0]?.createdAt,
        sourceEndTimestamp: candidate.messages[candidate.messages.length - 1]?.createdAt,
        sourceSequenceMin: candidate.messages[0]?.sequence,
        sourceSequenceMax: candidate.messages[candidate.messages.length - 1]?.sequence,
        sourceBinding,
        summaryLevel: 1,
        nodeKind: "leaf",
        tokenCount: summaryTokenCount,
        createdAt: new Date().toISOString(),
        sourceHash,
        sourceMessageCount,
        coverage: {
          sourceTokenEstimate,
          summaryTokenEstimate: summaryTokenCount,
          compressionRatio: sourceTokenEstimate > 0 ? summaryTokenCount / sourceTokenEstimate : 0,
        },
        quality: {
          confidence: 0.9,
          sourceTraceComplete: true,
          unresolvedConflicts: summary.conflicts?.length ?? 0,
          needsHumanReview: (summary.conflicts?.length ?? 0) > 0,
          generatedBy: "compaction_engine_v1",
        },
        sectionChunks: this.buildSectionChunks(summaryId, summary.summary),
      };

      await summaryStore.addSummary(entry);
      await rawStore.markCompacted(candidate.startTurn, candidate.endTurn, { sessionId });
      return { status: "compacted", summary: entry, sourceBinding, sourceTrace };
    } catch (error) {
      this.logger.warn("compaction_skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "failed",
        reason: "compaction_error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private buildPrompt(messages: RawMessage[], attempt: number, maxOutputTokens: number): string {
    const sourceMessages = messages.filter(isSummarySourceMessage);
    const transcript = sourceMessages
      .map((message) => `Turn ${message.turnNumber} | ${message.role}\n${message.content}`)
      .join("\n\n");
    const sourceTokenCount = this.sumSummarySourceTokens(sourceMessages);

    return [
      "You are generating a high-quality level-1 memory extraction in Markdown.",
      "This is not a JSON object and not a short abstract. It is the cleaned nutrient layer that later rollups, knowledge intake, and source recall will use.",
      "Treat the task like a careful meeting-minutes distillation: remove noise, repeated boilerplate, tool chatter, acknowledgements, false starts, and clearly corrected mistakes while preserving usable substance.",
      "Do not optimize for brevity. Optimize for functional retention, downstream retrieval, knowledge intake, and future rollups.",
      `The source span is about ${sourceTokenCount} tokens. Let the length follow functional retention needs. Roughly ${LEVEL_ONE_TARGET_RATIO * 100}% of useful source density is a starting heuristic for information-rich spans, not a hard cap.`,
      `The API output budget is set to ${maxOutputTokens} tokens so the extraction can be as rich as needed, but the final extraction must never exceed the source length.`,
      "Keep enough detail that later retrieval can answer source-specific questions without immediately reopening every raw message.",
      "A good level-1 extraction preserves section structure, named mechanisms, comparisons, caveats, exact values, source-local terminology, and testable claims.",
      "Write atomic bullets where possible: one constraint, decision, failure mode, next step, claim, or exact anchor per bullet.",
      "Keep constraints, decisions, and failure modes in separate sections so downstream evidence atoms do not collapse different memory types together.",
      "Correct only errors that are clearly corrected by the source itself. Preserve uncertainty and disagreement instead of smoothing them away.",
      "Do not invent connective tissue, conclusions, citations, or facts that are not supported by the source.",
      "Return Markdown only. Do not wrap it in a code fence.",
      attempt > 1
        ? "Important: suppress reasoning and emit the final Markdown extraction immediately."
        : "",
      "Use this Markdown shape when useful:",
      "# Level-1 Memory Extraction",
      "## Scope",
      "## Cleaned Substance",
      "## Mechanisms And Claims",
      "## Exact Anchors",
      "## Constraints",
      "## Decisions",
      "## Failure Modes",
      "## Next Steps",
      "## Open Questions",
      "## Conflicts / Ambiguities",
      "## Candidate Evidence Atoms",
      "## Retrieval Cues",
      "## Key Entities",
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

    return this.markdownToSummaryResult(raw);
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

    const outputBudget = this.resolveLevelOneOutputBudget(messages, maxOutputTokens);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const prompt = this.buildPrompt(messages, attempt, outputBudget);
        const raw = await this.llmCaller.call({
          model: summaryModel,
          prompt,
          temperature: 0.1,
          maxOutputTokens: outputBudget,
          responseFormat: "text",
        });
        const parsed = this.parseSummaryResult(raw);
        if (parsed && !this.isLongerThanSource(parsed, messages)) {
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

  private resolveLevelOneOutputBudget(messages: RawMessage[], _configuredMaxOutputTokens: number): number {
    const sourceTokenCount = this.sumSummarySourceTokens(messages);
    return Math.max(1, sourceTokenCount);
  }

  private isLongerThanSource(summary: SummaryResult, messages: RawMessage[]): boolean {
    const sourceTokenCount = this.sumSummarySourceTokens(messages);
    return estimateTokens(summary.summary) > sourceTokenCount;
  }

  private sumSummarySourceTokens(messages: RawMessage[]): number {
    return messages
      .filter(isSummarySourceMessage)
      .reduce((sum, message) => sum + message.tokenCount, 0);
  }

  private markdownToSummaryResult(raw: string): SummaryResult | null {
    const summary = raw.trim().replace(/^```(?:md|markdown)?\s*/i, "").replace(/```$/i, "").trim();
    if (!summary) {
      return null;
    }
    const headings = [...summary.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => match[1].trim());
    const keywords = [...new Set([
      ...headings,
      ...[...summary.matchAll(/`([^`]{2,80})`/g)].map((match) => match[1].trim()),
    ])].slice(0, 24);
    const exactAnchorLines = this.extractSectionLines(summary, /^(exact anchors?|mechanisms? and claims?|claims?|facts?)$/i, 40);
    const exactFacts = [...new Set([
      ...exactAnchorLines,
      ...summary
        .split(/\r?\n/)
        .filter((line) => /(?:https?:\/\/|arxiv|local-synthetic|20\d{2}-\d{2}-\d{2}|[A-Za-z0-9_-]+\.(?:ts|md|json|sqlite)|\b\d+(?:\.\d+)?\b)/.test(line))
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean),
    ])].slice(0, 60);
    return {
      summary,
      keywords,
      toneTag: "markdown level-1 extraction",
      memoryType: "general",
      phase: "active",
      constraints: this.extractSectionLines(summary, /^(constraints?|limits?|musts?)$/i),
      decisions: this.extractSectionLines(summary, /^(decisions?|choices?|settled)$/i),
      blockers: this.extractSectionLines(summary, /^(blockers?|failure modes?|risks?)$/i),
      nextSteps: this.extractSectionLines(summary, /^(next steps?|follow[- ]?ups?|todo)$/i),
      keyEntities: [
        ...this.extractSectionLines(summary, /^(key entities|entities|retrieval cues)$/i, 40),
        ...keywords,
      ].slice(0, 40),
      exactFacts,
      promotionIntent: "candidate",
      openQuestions: this.extractSectionLines(summary, /^(open questions?|unknowns?)$/i),
      conflicts: this.extractSectionLines(summary, /^(conflicts?(?: \/ ambiguities)?|ambiguities?)$/i),
      candidateAtomPreviews: this.extractSectionLines(summary, /^(candidate evidence atoms?|evidence atoms?)$/i, 40),
    };
  }

  private extractSectionLines(markdown: string, headingPattern: RegExp, limit = 20): string[] {
    const lines = markdown.split(/\r?\n/);
    const collected: string[] = [];
    let inside = false;
    for (const line of lines) {
      const heading = line.match(/^#{1,3}\s+(.+)$/);
      if (heading) {
        inside = headingPattern.test(heading[1]);
        continue;
      }
      if (!inside) {
        continue;
      }
      const item = line.replace(/^[-*]\s*/, "").trim();
      if (item) {
        collected.push(item);
      }
    }
    return collected.slice(0, limit);
  }

  private buildSourceRefs(messages: RawMessage[]): SummaryEntry["sourceRefs"] {
    return messages.filter(isSummarySourceMessage).map((message) => ({
      messageId: message.id,
      role: message.role,
      charStart: 0,
      charEnd: message.content.length,
      quoteHash: this.hash(message.content),
    }));
  }

  private buildSectionChunks(summaryId: string, markdown: string): SummaryEntry["sectionChunks"] {
    const chunks: NonNullable<SummaryEntry["sectionChunks"]> = [];
    const lines = markdown.split(/\r?\n/);
    let section = "Preamble";
    let buffer: string[] = [];
    const flush = () => {
      const text = buffer.join("\n").trim();
      if (!text) {
        buffer = [];
        return;
      }
      chunks.push({
        id: `l1sec-${this.hash(`${summaryId}|${section}|${text}`).slice(0, 20)}`,
        section,
        text,
        tokenCount: estimateTokens(text),
      });
      buffer = [];
    };
    for (const line of lines) {
      const heading = line.match(/^#{1,3}\s+(.+)$/);
      if (heading) {
        flush();
        section = heading[1].trim();
        continue;
      }
      buffer.push(line);
    }
    flush();
    return chunks;
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
        openQuestions: Array.isArray(candidateRecord.openQuestions)
          ? candidateRecord.openQuestions.map((item) => String(item))
          : [],
        conflicts: Array.isArray(candidateRecord.conflicts)
          ? candidateRecord.conflicts.map((item) => String(item))
          : [],
        candidateAtomPreviews: Array.isArray(candidateRecord.candidateAtomPreviews)
          ? candidateRecord.candidateAtomPreviews.map((item) => String(item))
          : [],
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

  private selectAdaptiveCandidateTurns(
    messages: RawMessage[],
    candidateTurnNumbers: number[],
    maxTurns: number,
  ): number[] {
    if (candidateTurnNumbers.length === 0) {
      return [];
    }
    const hardTurnLimit = Math.max(maxTurns * 3, maxTurns, 1);
    const selected: number[] = [];
    let consumed = 0;

    for (const turnNumber of candidateTurnNumbers) {
      const turnTokens = messages
        .filter((message) => message.turnNumber === turnNumber && isSummarySourceMessage(message))
        .reduce((sum, message) => sum + message.tokenCount, 0);
      if (turnTokens <= 0) {
        continue;
      }
      const wouldExceedMaxTokens = selected.length > 0 &&
        consumed >= COMPACTION_BATCH_MIN_TOKENS &&
        consumed + turnTokens > COMPACTION_BATCH_MAX_TOKENS;
      const wouldExceedTurnLimit = selected.length >= hardTurnLimit &&
        consumed >= COMPACTION_BATCH_MIN_TOKENS;
      if (wouldExceedMaxTokens || wouldExceedTurnLimit) {
        break;
      }

      selected.push(turnNumber);
      consumed += turnTokens;

      if (
        consumed >= COMPACTION_BATCH_TARGET_TOKENS &&
        selected.length >= Math.min(maxTurns, candidateTurnNumbers.length)
      ) {
        break;
      }
    }

    return selected;
  }

  private normalizeThresholdRatio(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
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
      protectedTurns.has(message.turnNumber) || !isSummarySourceMessage(message)
        ? sum
        : sum + message.tokenCount
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
        .filter((message) => message.turnNumber === turnNumber && isSummarySourceMessage(message))
        .reduce((sum, message) => sum + message.tokenCount, 0);
      if (turnTokens <= 0) {
        continue;
      }

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
