import {
  KnowledgeRawCandidateScore,
  RawMessage,
  SummaryEntry,
} from "../types";
import { estimateTokens } from "../utils/tokenizer";

const SCORE_WEIGHTS: KnowledgeRawCandidateScore["weights"] = {
  value: 0.3,
  researchDifficulty: 0.15,
  sourceEffort: 0.18,
  contentDensity: 0.18,
  evidenceStrength: 0.14,
  novelty: 0.05,
};

export class KnowledgeCandidateScorer {
  score(summary: SummaryEntry, messages: RawMessage[]): KnowledgeRawCandidateScore {
    const sourceMessageCount = summary.sourceMessageCount ?? messages.length;
    const sourceTokens = messages.reduce((sum, message) => sum + (message.tokenCount || estimateTokens(message.content)), 0);
    const signalCount = this.signalCount(summary);
    const value = this.clamp(
      signalCount * 16 +
      (summary.promotionIntent === "priority_promote" ? 30 : summary.promotionIntent === "promote" ? 20 : 0) +
      (["decision", "constraint", "diagnostic", "preference", "feedback"].includes(summary.memoryType ?? "") ? 18 : 0),
    );
    const researchDifficulty = this.clamp(
      Math.log2(Math.max(sourceTokens, 1)) * 8 +
      (sourceMessageCount >= 8 ? 18 : sourceMessageCount >= 4 ? 10 : 0) +
      ((summary.keyEntities ?? []).length >= 3 ? 10 : 0),
    );
    const sourceEffort = this.clamp(
      sourceMessageCount * 9 +
      Math.max(0, summary.endTurn - summary.startTurn + 1) * 4 +
      Math.log2(Math.max(sourceTokens, 1)) * 4,
    );
    const contentDensity = this.clamp(
      signalCount * 18 +
      Math.min(28, (summary.keywords ?? []).length * 4) +
      (sourceTokens > 0 ? Math.min(20, (signalCount / Math.max(sourceTokens / 600, 1)) * 10) : 0),
    );
    const evidenceStrength = this.clamp(
      (summary.sourceHash ? 30 : 0) +
      (summary.sourceBinding?.messageIds?.length ? 30 : 0) +
      (sourceMessageCount > 0 && messages.length >= Math.min(sourceMessageCount, 1) ? 20 : 0) +
      ((summary.nodeKind ?? "leaf") === "leaf" ? 10 : 0),
    );
    const novelty = this.clamp(
      new Set([
        ...(summary.keywords ?? []),
        ...(summary.keyEntities ?? []),
        ...(summary.exactFacts ?? []),
      ].map((item) => item.toLowerCase())).size * 6,
    );
    const total = Math.round(
      value * SCORE_WEIGHTS.value +
      researchDifficulty * SCORE_WEIGHTS.researchDifficulty +
      sourceEffort * SCORE_WEIGHTS.sourceEffort +
      contentDensity * SCORE_WEIGHTS.contentDensity +
      evidenceStrength * SCORE_WEIGHTS.evidenceStrength +
      novelty * SCORE_WEIGHTS.novelty,
    );
    return {
      total,
      recommendation: total >= 75 ? "promote" : total >= 50 ? "review" : "skip",
      dimensions: {
        value,
        researchDifficulty,
        sourceEffort,
        contentDensity,
        evidenceStrength,
        novelty,
      },
      weights: SCORE_WEIGHTS,
      reasons: this.reasons(summary, sourceMessageCount, sourceTokens, signalCount),
    };
  }

  summarize(summary: SummaryEntry): string {
    const candidate =
      summary.decisions[0] ??
      summary.constraints[0] ??
      summary.exactFacts[0] ??
      summary.summary;
    return this.truncateOneLine(candidate);
  }

  private signalCount(summary: SummaryEntry): number {
    return [
      summary.decisions.length,
      summary.constraints.length,
      summary.exactFacts.length,
      summary.blockers.length,
      summary.nextSteps?.length ?? 0,
      summary.keyEntities?.length ?? 0,
    ].reduce((sum, count) => sum + Math.min(count, 3), 0);
  }

  private reasons(
    summary: SummaryEntry,
    sourceMessageCount: number,
    sourceTokens: number,
    signalCount: number,
  ): string[] {
    return [
      `signals:${signalCount}`,
      `source_messages:${sourceMessageCount}`,
      `source_tokens:${sourceTokens}`,
      `memory_type:${summary.memoryType ?? "general"}`,
      `promotion_intent:${summary.promotionIntent ?? "candidate"}`,
      summary.sourceHash ? "source_hash_present" : "source_hash_missing",
    ];
  }

  private truncateOneLine(value: string): string {
    const normalized = value
      .replace(/\s+/g, " ")
      .replace(/^[#*\-\s]+/, "")
      .trim();
    return [...normalized].slice(0, 20).join("");
  }

  private clamp(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
}
