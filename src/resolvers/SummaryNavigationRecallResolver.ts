import {
  RawMessage,
  RawMessageRepository,
  RecallResult,
  SummaryEntry,
  SummaryRepository,
} from "../types";
import { SourceMessageResolver } from "./SourceMessageResolver";
import { SummaryDagResolver } from "./SummaryDagResolver";
import { RecallOptions, queryTerms, textHasTerm } from "./RecallShared";
import { scoreIntentRoleMatch } from "./RecallIntentRoles";
import { estimateTokens } from "../utils/tokenizer";

type EvidenceAtomType = "constraint" | "decision" | "exact_fact" | "blocker" | "next_step" | "entity";

export class SummaryNavigationRecallResolver {
  private readonly sourceResolver = new SourceMessageResolver();
  private readonly dagResolver = new SummaryDagResolver();

  resolve(
    query: string,
    summaryStore: SummaryRepository,
    rawStore: RawMessageRepository,
    recallBudget: number,
    options: RecallOptions,
  ): RecallResult {
    const terms = queryTerms(query);
    const exactAnchors = query.match(/\b[A-Z][A-Z0-9_]{2,}\b|\b\d{2,}\b/g) ?? [];
    const traversal = this.dagResolver.resolve(query, summaryStore, {
      sessionId: options.sessionId,
    });
    const hits = traversal.summaries;
    const items: RecallResult["items"] = [];
    const sourceTrace: RecallResult["sourceTrace"] = [];
    const dagTrace: RecallResult["dagTrace"] = traversal.trace;
    let consumedTokens = 0;

    for (const hit of hits) {
      const resolution = this.sourceResolver.resolve(rawStore, hit);
      sourceTrace.push(SourceMessageResolver.traceFromResolution(resolution, {
        route: "summary_tree",
        summaryId: hit.id,
      }));
      const summaryItem = options.includeSummaryItems ? this.buildSummaryItem(hit) : null;
      const rawRequired = this.queryRequiresRawSource(query);
      const atomItems = rawRequired ? [] : this.buildEvidenceAtomItems(hit, query, terms, exactAnchors);
      for (const atom of atomItems) {
        if (consumedTokens + atom.tokenCount > recallBudget && items.length > 0) {
          return { items, consumedTokens, sourceTrace, dagTrace, strategy: "summary_navigation" };
        }
        consumedTokens += atom.tokenCount;
        items.push(atom);
      }

      if (atomItems.length > 0) {
        continue;
      }

      const messages = this.prioritizeMessages(
        options.sessionId
          ? resolution.messages.filter((message) => message.sessionId === options.sessionId)
          : resolution.messages,
        query,
        terms,
        exactAnchors,
      );
      for (const message of messages) {
        if (consumedTokens + message.tokenCount > recallBudget && items.length > 0) {
          return { items, consumedTokens, sourceTrace, dagTrace, strategy: "summary_navigation" };
        }

        consumedTokens += message.tokenCount;
        items.push({
          kind: "message" as const,
          tokenCount: message.tokenCount,
          turnNumber: message.turnNumber,
          role: message.role,
          content: message.content,
          metadata: {
            ...(message.metadata ?? {}),
            messageId: message.id,
            sourceSummaryId: hit.id,
            sourceResolutionStrategy: resolution.strategy,
            sourceVerified: resolution.verified,
          },
        });
      }
      if (summaryItem && (consumedTokens + summaryItem.tokenCount <= recallBudget || items.length === 0)) {
        consumedTokens += summaryItem.tokenCount;
        items.push(summaryItem);
      }
    }

    return { items, consumedTokens, sourceTrace, dagTrace, strategy: "summary_navigation" };
  }

  private buildEvidenceAtomItems(
    summary: SummaryEntry,
    query: string,
    terms: string[],
    exactAnchors: string[],
  ): RecallResult["items"] {
    const contentAtoms = [
      ...this.atomSeeds(summary, "constraint", summary.constraints),
      ...this.atomSeeds(summary, "decision", summary.decisions),
      ...this.atomSeeds(summary, "exact_fact", summary.exactFacts),
      ...this.atomSeeds(summary, "blocker", summary.blockers),
      ...this.atomSeeds(summary, "next_step", summary.nextSteps ?? []),
    ]
      .map((atom) => ({
        ...atom,
        score: this.scoreAtom(atom.text, atom.type, query, terms, exactAnchors),
      }))
      .filter((atom) => atom.score >= 6)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const entityAtoms = contentAtoms.length > 0
      ? []
      : this.atomSeeds(summary, "entity", summary.keyEntities ?? [])
          .map((atom) => ({
            ...atom,
            score: this.scoreAtom(atom.text, atom.type, query, terms, exactAnchors),
          }))
          .filter((atom) => atom.score >= 6)
          .sort((left, right) => right.score - left.score || left.index - right.index);
    const atoms = [...contentAtoms, ...entityAtoms]
      .slice(0, 8);

    return atoms.map((atom) => {
      const content = [
        `[evidence_atom:${atom.type}] ${atom.text}`,
        `sourceSummaryId: ${summary.id}`,
        `sourceTurns: ${summary.startTurn}-${summary.endTurn}`,
      ].join("\n");
      return {
        kind: "summary" as const,
        tokenCount: Math.max(estimateTokens(content), 1),
        turnNumber: summary.startTurn,
        content,
        metadata: {
          atomId: `${summary.id}:${atom.type}:${atom.index}`,
          evidenceAtom: true,
          evidenceType: atom.type,
          sourceSummaryId: summary.id,
          sourceBinding: summary.sourceBinding,
          sourceHash: summary.sourceHash,
          sourceMessageCount: summary.sourceMessageCount,
          summaryLevel: summary.summaryLevel ?? 1,
          sourceVerified: Boolean(summary.sourceBinding || summary.sourceHash),
        },
      };
    });
  }

  private atomSeeds(
    summary: SummaryEntry,
    type: EvidenceAtomType,
    values: string[],
  ): Array<{ type: EvidenceAtomType; text: string; index: number }> {
    return values
      .map((value, index) => ({ type, text: value.replace(/\s+/g, " ").trim(), index }))
      .filter((atom) => atom.text.length > 0);
  }

  private scoreAtom(
    text: string,
    type: EvidenceAtomType,
    query: string,
    terms: string[],
    exactAnchors: string[],
  ): number {
    const lower = text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (textHasTerm(lower, term)) {
        score += term.length >= 6 ? 7 : 4;
      }
    }
    for (const anchor of exactAnchors) {
      if (text.includes(anchor)) {
        score += 18;
      }
    }
    const roleScore = scoreIntentRoleMatch(query, text).score;
    score += roleScore;
    if (type === "exact_fact") {
      score += 2;
    }
    if (type === "constraint" && /must|need|should|rule|constraint|policy|限制|约束|必须|规则/.test(query)) {
      score += 4;
    }
    if (type === "decision" && /decision|decide|choice|settled|决定|决策|定/.test(query)) {
      score += 4;
    }
    return score;
  }

  private queryRequiresRawSource(query: string): boolean {
    return /\b(?:quote|verbatim|exact|exact wording|source text|original|raw|trace|cite|citation)\b|(?:原文|原话|逐字|引用|出处|来源|回溯|精确措辞)/i.test(query);
  }

  private buildSummaryItem(summary: ReturnType<SummaryRepository["getActiveSummaries"]>[number]): RecallResult["items"][number] | null {
    const lines = [
      `Summary ${summary.id} (level ${summary.summaryLevel ?? 1}, turns ${summary.startTurn}-${summary.endTurn})`,
      summary.summary,
      summary.exactFacts.length > 0 ? `Exact facts: ${summary.exactFacts.join("; ")}` : "",
      summary.keyEntities && summary.keyEntities.length > 0 ? `Key entities: ${summary.keyEntities.join("; ")}` : "",
      summary.keywords.length > 0 ? `Keywords: ${summary.keywords.join("; ")}` : "",
    ].filter(Boolean);
    const content = lines.join("\n");
    if (!content.trim()) {
      return null;
    }
    return {
      kind: "summary",
      summaryId: summary.id,
      tokenCount: Math.max(summary.tokenCount, Math.ceil(content.length / 4)),
      turnNumber: summary.startTurn,
      content,
      metadata: {
        sourceBinding: summary.sourceBinding,
        sourceHash: summary.sourceHash,
        sourceMessageCount: summary.sourceMessageCount,
        summaryLevel: summary.summaryLevel ?? 1,
        sourceSummaryId: summary.id,
      },
    };
  }

  private prioritizeMessages(
    messages: ReturnType<RawMessageRepository["getByRange"]>,
    query: string,
    queryTerms: string[],
    exactAnchors: string[],
  ): ReturnType<RawMessageRepository["getByRange"]> {
    const scored = messages.map((message, index) => ({
      message,
      index,
      score: this.scoreMessage(message.content, query, queryTerms, exactAnchors),
    }));

    if (!scored.some((item) => item.score > 0)) {
      return messages;
    }

    return scored
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.message.turnNumber !== right.message.turnNumber) {
          return left.message.turnNumber - right.message.turnNumber;
        }
        return left.index - right.index;
      })
      .map((item) => item.message);
  }

  private scoreMessage(
    content: string,
    query: string,
    queryTerms: string[],
    exactAnchors: string[],
  ): number {
    const lower = content.toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      if (textHasTerm(lower, term)) {
        score += term.length >= 6 ? 3 : 2;
      }
    }

    for (const anchor of exactAnchors) {
      if (content.includes(anchor)) {
        score += 20;
      }
    }

    if (/\b(port|gateway|parameter|config|exact)\b/i.test(content)) {
      score += 2;
    }

    score += scoreIntentRoleMatch(query, content).score;

    return score;
  }

}
