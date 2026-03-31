import { RecallResult } from "../types";
import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";

export class RecallResolver {
  resolve(
    query: string,
    summaryStore: SummaryIndexStore,
    rawStore: RawMessageStore,
    recallBudget: number,
  ): RecallResult {
    const hits = summaryStore.search(query);
    const items: RecallResult["items"] = [];
    let consumedTokens = 0;

    for (const hit of hits) {
      const messages = rawStore.getByRange(hit.startTurn, hit.endTurn);
      for (const message of messages) {
        if (consumedTokens + message.tokenCount > recallBudget && items.length > 0) {
          return { items, consumedTokens };
        }

        consumedTokens += message.tokenCount;
        items.push({
          kind: "message" as const,
          tokenCount: message.tokenCount,
          turnNumber: message.turnNumber,
          role: message.role,
          content: message.content,
          metadata: message.metadata,
        });
      }
    }

    return { items, consumedTokens };
  }
}
