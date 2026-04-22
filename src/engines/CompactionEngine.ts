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
  ): boolean {
    const normalizedThreshold = this.normalizeThresholdRatio(contextThreshold, 0.7);
    return (
      this.getCompactionPressureTokens(
        rawStore,
        summaryStore,
        freshTailTokens,
        maxFreshTailTurns,
      ) > Math.floor(contextWindow * normalizedThreshold)
    );
  }

  measureCompressibleHistoryTokens(
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    freshTailTokens: number,
    maxFreshTailTurns: number,
  ): number {
    return this.getCompactionPressureTokens(
      rawStore,
      summaryStore,
      freshTailTokens,
      maxFreshTailTurns,
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
  ): { startTurn: number; endTurn: number; messages: RawMessage[] } | null {
    const allMessages = rawStore.getAll();
    const lastClosedTurn = this.resolveLastClosedTurn(allMessages);
    if (lastClosedTurn <= 0) {
      return null;
    }

    const coveredTurns = summaryStore.getCoveredTurns();
    const uncompacted = rawStore
      .getUncompactedMessages()
      .filter(
        (message) =>
          message.turnNumber <= lastClosedTurn &&
          !coveredTurns.has(message.turnNumber),
      );
    const turnNumbers = [...new Set(uncompacted.map((message) => message.turnNumber))];
    if (turnNumbers.length === 0) {
      return null;
    }

    const protectedTurns = this.selectProtectedTailTurns(uncompacted, freshTailTokens, maxFreshTailTurns);
    const candidateTurnNumbers = turnNumbers.filter((turnNumber) => !protectedTurns.has(turnNumber));
    const candidateTurns = candidateTurnNumbers.slice(0, Math.min(maxTurns, candidateTurnNumbers.length));
    if (candidateTurns.length === 0) {
      return null;
    }

    const startTurn = candidateTurns[0];
    const endTurn = candidateTurns[candidateTurns.length - 1];
    const messages = rawStore.getByRange(startTurn, endTurn).filter((message) => !message.compacted);
    return messages.length === 0 ? null : { startTurn, endTurn, messages };
  }

  async generateSummary(messages: RawMessage[], summaryModel: string | undefined, maxOutputTokens: number): Promise<SummaryResult> {
    if (!this.llmCaller) {
      return this.buildFallbackSummary(messages);
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

    return this.buildFallbackSummary(messages);
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
      );
      if (existing) {
        await rawStore.markCompacted(candidate.startTurn, candidate.endTurn);
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
      const entry: SummaryEntry = {
        id: randomUUID(),
        sessionId,
        agentId,
        summary: summary.summary,
        keywords: summary.keywords,
        toneTag: summary.toneTag,
        constraints: summary.constraints,
        decisions: summary.decisions,
        blockers: summary.blockers,
        exactFacts: summary.exactFacts,
        startTurn: candidate.startTurn,
        endTurn: candidate.endTurn,
        sourceFirstMessageId: candidate.messages[0]?.id,
        sourceLastMessageId: candidate.messages[candidate.messages.length - 1]?.id,
        sourceMessageIds: candidate.messages.map((message) => message.id),
        sourceStartTimestamp: candidate.messages[0]?.createdAt,
        sourceEndTimestamp: candidate.messages[candidate.messages.length - 1]?.createdAt,
        sourceSequenceMin: candidate.messages[0]?.sequence,
        sourceSequenceMax: candidate.messages[candidate.messages.length - 1]?.sequence,
        tokenCount: estimateTokens(summary.summary),
        createdAt: new Date().toISOString(),
        sourceHash,
        sourceMessageCount,
      };

      await summaryStore.addSummary(entry);
      await rawStore.markCompacted(candidate.startTurn, candidate.endTurn);
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
      "You are generating a compact transcript summary for a context engine.",
      "Return JSON with exactly these keys: summary, keywords, toneTag, constraints, decisions, blockers, exactFacts.",
      "Output only one JSON object. Do not wrap it in markdown.",
      "Do not output any extra commentary before or after the JSON object.",
      attempt > 1
        ? "Important: suppress reasoning and emit the final JSON object immediately."
        : "",
      "summary must be concise and fact-preserving.",
      "keywords must be an array of short search terms.",
      "toneTag must be a short phrase describing the dialogue tone.",
      "constraints must list explicit limits, requirements, and must-not rules.",
      "decisions must list concrete decisions or settled implementation choices.",
      "blockers must list concrete failures, risks, or unresolved blockers.",
      "exactFacts must list exact numbers, ports, file names, config keys, parameter values, and other precise anchors that should survive compression.",
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
      const fenced = this.normalizeSummaryCandidate(
        this.tryParseJsonObject(fencedMatch[1]),
      );
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

    const labeled = this.parseLabeledSummary(raw);
    if (labeled) {
      return labeled;
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
        constraints: Array.isArray(candidateRecord.constraints)
          ? candidateRecord.constraints.map((item) => String(item))
          : [],
        decisions: Array.isArray(candidateRecord.decisions)
          ? candidateRecord.decisions.map((item) => String(item))
          : [],
        blockers: Array.isArray(candidateRecord.blockers)
          ? candidateRecord.blockers.map((item) => String(item))
          : [],
        exactFacts: Array.isArray(candidateRecord.exactFacts)
          ? candidateRecord.exactFacts.map((item) => String(item))
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

  private parseLabeledSummary(raw: string): SummaryResult | null {
    const summaryMatch = raw.match(/summary\s*[:：]\s*(.+)/i);
    const keywordsMatch = raw.match(/keywords?\s*[:：]\s*(.+)/i);
    const toneMatch = raw.match(/toneTag\s*[:：]\s*(.+)/i);
    if (!summaryMatch || !keywordsMatch) {
      return null;
    }

    const keywords = keywordsMatch[1]
      .split(/[,\uFF0C|]/)
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    if (keywords.length === 0) {
      return null;
    }

    return {
      summary: summaryMatch[1].trim(),
      keywords,
      toneTag: toneMatch?.[1]?.trim() || "neutral",
      constraints: [],
      decisions: [],
      blockers: [],
      exactFacts: [],
    };
  }

  private buildFallbackSummary(messages: RawMessage[]): SummaryResult {
    const startTurn = messages[0]?.turnNumber ?? 0;
    const endTurn = messages[messages.length - 1]?.turnNumber ?? startTurn;
    const sentences = messages.flatMap((message) =>
      this.extractSentences(message.content).map((sentence) => ({
        role: message.role,
        sentence,
      })),
    );
    const constraints = this.pickFallbackHighlights(
      sentences,
      /(constraint|must|must not|do not|don't|should not|require|need to|不要|必须|约束|禁用|disable)/i,
    );
    const decisions = this.pickFallbackHighlights(
      sentences,
      /(decision|decided|keep|we will|recorded|选择|决定|保留|采用)/i,
    );
    const blockers = this.pickFallbackHighlights(
      sentences,
      /(blocker|blocked|error|fail|issue|risk|cannot|can't|not installed|阻塞|卡住|失败|报错|风险)/i,
    );
    const nextActions = this.pickFallbackHighlights(
      sentences,
      /(next action|next step|follow-up|todo|pending|下一步|待办|后续|接下来)/i,
    );
    const exactFacts = this.pickFallbackHighlights(
      sentences,
      /(\b\d{2,}\b|port|gateway|profile|config|parameter|exact|具体|端口|配置|参数)/i,
    );
    const summaryParts = [
      `Fallback transcript summary for turns ${startTurn}-${endTurn}.`,
      constraints.length > 0 ? `Constraints: ${constraints.join(" | ")}` : "",
      decisions.length > 0 ? `Decisions: ${decisions.join(" | ")}` : "",
      blockers.length > 0 ? `Blockers: ${blockers.join(" | ")}` : "",
      nextActions.length > 0 ? `Next: ${nextActions.join(" | ")}` : "",
      exactFacts.length > 0 ? `Facts: ${exactFacts.join(" | ")}` : "",
    ].filter(Boolean);
    const content = summaryParts.join("\n");
    const keywords = this.buildFallbackKeywords([
      ...constraints,
      ...decisions,
      ...blockers,
      ...nextActions,
      ...exactFacts,
    ]);
    return {
      summary: content,
      keywords,
      toneTag: "neutral",
      constraints,
      decisions,
      blockers,
      exactFacts,
    };
  }

  private extractSentences(content: string): string[] {
    return content
      .split(/(?<=[.!?。！？])\s+/)
      .map((sentence) => sentence.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  private pickFallbackHighlights(
    sentences: Array<{ role: RawMessage["role"]; sentence: string }>,
    pattern: RegExp,
    limit = 2,
  ): string[] {
    const picked: string[] = [];
    for (const { sentence } of sentences) {
      if (!pattern.test(sentence)) {
        continue;
      }
      if (picked.includes(sentence)) {
        continue;
      }
      picked.push(sentence);
      if (picked.length >= limit) {
        break;
      }
    }
    return picked;
  }

  private buildFallbackKeywords(highlights: string[]): string[] {
    const keywords = new Set<string>();
    for (const highlight of highlights) {
      const exactAnchors = highlight.match(/\b\d{2,}\b/g) ?? [];
      for (const anchor of exactAnchors) {
        keywords.add(anchor.toLowerCase());
        if (keywords.size >= 10) {
          return [...keywords];
        }
      }
    }
    for (const highlight of highlights) {
      const terms = highlight
        .split(/[^a-zA-Z0-9\u4e00-\u9fff]+/)
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length >= 2);
      for (const term of terms) {
        keywords.add(term);
        if (keywords.size >= 10) {
          return [...keywords];
        }
      }
    }
    return [...keywords];
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
  ): number {
    const allMessages = rawStore.getAll();
    const lastClosedTurn = this.resolveLastClosedTurn(allMessages);
    if (lastClosedTurn <= 0) {
      return 0;
    }

    const coveredTurns = summaryStore.getCoveredTurns();
    const uncompacted = rawStore
      .getUncompactedMessages()
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

    return uncompacted.reduce((sum, message) => {
      return protectedTurns.has(message.turnNumber) ? sum : sum + message.tokenCount;
    }, 0);
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
