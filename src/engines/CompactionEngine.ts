import { randomUUID } from "node:crypto";

import { LlmCaller, LoggerLike, RawMessage, SummaryEntry, SummaryResult } from "../types";
import { estimateTokens } from "../utils/tokenizer";
import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";

export class CompactionEngine {
  constructor(
    private readonly llmCaller: LlmCaller | null,
    private readonly logger: LoggerLike,
  ) {}

  shouldCompact(rawStore: RawMessageStore, contextWindow: number, contextThreshold: number): boolean {
    const normalizedThreshold =
      Number.isFinite(contextThreshold) && contextThreshold > 0 && contextThreshold < 1
        ? contextThreshold
        : 0.75;
    return rawStore.totalUncompactedTokens() > Math.floor(contextWindow * normalizedThreshold);
  }

  selectTurnsForCompaction(
    rawStore: RawMessageStore,
    recentTailSize: number,
    maxTurns = 20,
  ): { startTurn: number; endTurn: number; messages: RawMessage[] } | null {
    const uncompacted = rawStore.getUncompactedMessages();
    const turnNumbers = [...new Set(uncompacted.map((message) => message.turnNumber))];

    if (turnNumbers.length <= recentTailSize) {
      return null;
    }

    const candidateTurns = turnNumbers.slice(0, Math.min(maxTurns, turnNumbers.length - recentTailSize));
    if (candidateTurns.length === 0) {
      return null;
    }

    const startTurn = candidateTurns[0];
    const endTurn = candidateTurns[candidateTurns.length - 1];
    const messages = rawStore.getByRange(startTurn, endTurn).filter((message) => !message.compacted);
    return messages.length === 0 ? null : { startTurn, endTurn, messages };
  }

  async generateSummary(messages: RawMessage[], summaryModel: string, maxOutputTokens: number): Promise<SummaryResult> {
    if (!this.llmCaller) {
      return this.buildFallbackSummary(messages);
    }

    const prompt = this.buildPrompt(messages);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const raw = await this.llmCaller.call({
          model: summaryModel,
          prompt,
          temperature: 0.1,
          maxOutputTokens,
          responseFormat: "json",
        });
        const parsed = JSON.parse(this.extractJson(raw)) as Partial<SummaryResult>;
        if (parsed.summary && Array.isArray(parsed.keywords) && typeof parsed.toneTag === "string") {
          return {
            summary: parsed.summary,
            keywords: parsed.keywords.map((keyword) => String(keyword)),
            toneTag: parsed.toneTag,
          };
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
    rawStore: RawMessageStore,
    summaryStore: SummaryIndexStore,
    contextWindow: number,
    contextThreshold: number,
    recentTailSize: number,
    summaryModel: string,
    maxOutputTokens: number,
    sessionId: string,
    maxTurns: number,
  ): Promise<SummaryEntry | null> {
    if (!this.shouldCompact(rawStore, contextWindow, contextThreshold)) {
      return null;
    }

    const candidate = this.selectTurnsForCompaction(rawStore, recentTailSize, maxTurns);
    if (!candidate) {
      return null;
    }

    try {
      const summary = await this.generateSummary(candidate.messages, summaryModel, maxOutputTokens);
      const entry: SummaryEntry = {
        id: randomUUID(),
        sessionId,
        summary: summary.summary,
        keywords: summary.keywords,
        toneTag: summary.toneTag,
        startTurn: candidate.startTurn,
        endTurn: candidate.endTurn,
        tokenCount: estimateTokens(summary.summary),
        createdAt: new Date().toISOString(),
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

  private buildPrompt(messages: RawMessage[]): string {
    const transcript = messages
      .map((message) => `Turn ${message.turnNumber} | ${message.role}\n${message.content}`)
      .join("\n\n");

    return [
      "You are generating a compact transcript summary for a context engine.",
      "Return JSON with exactly these keys: summary, keywords, toneTag.",
      "summary must be concise and fact-preserving.",
      "keywords must be an array of short search terms.",
      "toneTag must be a short phrase describing the dialogue tone.",
      "",
      transcript,
    ].join("\n");
  }

  private extractJson(raw: string): string {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  }

  private buildFallbackSummary(messages: RawMessage[]): SummaryResult {
    const content = messages.map((message) => message.content).join(" ");
    const keywords = [...new Set(content.split(/\W+/).map((term) => term.toLowerCase()).filter((term) => term.length >= 4))].slice(0, 8);
    const startTurn = messages[0]?.turnNumber ?? 0;
    const endTurn = messages[messages.length - 1]?.turnNumber ?? startTurn;
    return {
      summary: `Transcript summary for turns ${startTurn}-${endTurn}: ${content.slice(0, 400)}`,
      keywords,
      toneTag: "neutral",
    };
  }
}
