import {
  RawMessage,
  RawMessageRepository,
  RecallResult,
  SummaryRepository,
} from "../types";
import { SourceMessageResolver } from "./SourceMessageResolver";
import { SummaryDagResolver } from "./SummaryDagResolver";
import { RecallOptions, queryTerms, textHasTerm } from "./RecallShared";
import { scoreIntentRoleMatch } from "./RecallIntentRoles";

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
