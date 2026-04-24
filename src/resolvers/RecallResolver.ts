import {
  RawMessageRepository,
  RecallResult,
  SummaryRepository,
} from "../types";
import { SourceMessageResolver } from "./SourceMessageResolver";
import { SummaryDagResolver } from "./SummaryDagResolver";

export class RecallResolver {
  private readonly sourceResolver = new SourceMessageResolver();
  private readonly dagResolver = new SummaryDagResolver();

  resolve(
    query: string,
    summaryStore: SummaryRepository,
    rawStore: RawMessageRepository,
    recallBudget: number,
  ): RecallResult {
    const queryTerms = this.queryTerms(query);
    const numericAnchors = query.match(/\b\d{2,}\b/g) ?? [];
    const traversal = this.dagResolver.resolve(query, summaryStore);
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
      const messages = this.prioritizeMessages(
        resolution.messages,
        queryTerms,
        numericAnchors,
      );
      for (const message of messages) {
        if (consumedTokens + message.tokenCount > recallBudget && items.length > 0) {
          return { items, consumedTokens, sourceTrace, dagTrace };
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
            sourceSummaryId: hit.id,
            sourceResolutionStrategy: resolution.strategy,
            sourceVerified: resolution.verified,
          },
        });
      }
    }

    return { items, consumedTokens, sourceTrace, dagTrace };
  }

  private prioritizeMessages(
    messages: ReturnType<RawMessageRepository["getByRange"]>,
    queryTerms: string[],
    numericAnchors: string[],
  ): ReturnType<RawMessageRepository["getByRange"]> {
    const scored = messages.map((message, index) => ({
      message,
      index,
      score: this.scoreMessage(message.content, queryTerms, numericAnchors),
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
    queryTerms: string[],
    numericAnchors: string[],
  ): number {
    const lower = content.toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      if (lower.includes(term)) {
        score += term.length >= 6 ? 3 : 2;
      }
    }

    for (const anchor of numericAnchors) {
      if (content.includes(anchor)) {
        score += 6;
      }
    }

    if (/\b(port|gateway|parameter|config|exact)\b/i.test(content)) {
      score += 2;
    }

    return score;
  }

  private queryTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
  }
}
