import { ContextBudget, ContextItem } from "../types";
import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import { ContextViewStore } from "../stores/ContextViewStore";
import { StablePrefixStore } from "../stores/StablePrefixStore";

export class ContextAssembler {
  constructor(
    private readonly contextViewStore: ContextViewStore,
    private readonly stablePrefixStore = new StablePrefixStore(),
  ) {}

  allocateBudget(totalBudget: number, systemPromptTokens: number): ContextBudget {
    const availableBudget = Math.max(totalBudget - systemPromptTokens, 0);
    return {
      totalBudget,
      availableBudget,
      stablePrefixBudget: Math.floor(availableBudget * 0.15),
      recentTailBudget: Math.floor(availableBudget * 0.35),
      summaryBudget: Math.floor(availableBudget * 0.25),
      recallBudget: Math.floor(availableBudget * 0.15),
      reserveBudget: Math.max(availableBudget - Math.floor(availableBudget * 0.9), 0),
    };
  }

  assembleRecentTail(rawStore: RawMessageStore, budget: number, recentTailTurns: number): ContextItem[] {
    const recentMessages = rawStore.getRecentTail(recentTailTurns);
    const selected: ContextItem[] = [];
    let consumed = 0;

    for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
      const message = recentMessages[index];
      if (consumed + message.tokenCount > budget && selected.length > 0) {
        break;
      }

      consumed += message.tokenCount;
      selected.unshift({
        kind: "message",
        tokenCount: message.tokenCount,
        turnNumber: message.turnNumber,
        role: message.role,
        content: message.content,
        metadata: message.metadata,
      });
    }

    return selected;
  }

  assembleSummaries(summaryStore: SummaryIndexStore, budget: number): ContextItem[] {
    const summaries = summaryStore.getAllSummaries();
    const selected: ContextItem[] = [];
    let consumed = 0;

    for (const summary of summaries) {
      if (consumed + summary.tokenCount > budget && selected.length > 0) {
        break;
      }

      consumed += summary.tokenCount;
      selected.push({
        kind: "summary",
        tokenCount: summary.tokenCount,
        summaryId: summary.id,
        content: summary.summary,
        metadata: {
          keywords: summary.keywords,
          toneTag: summary.toneTag,
          startTurn: summary.startTurn,
          endTurn: summary.endTurn,
        },
      });
    }

    return selected;
  }

  async assemble(
    rawStore: RawMessageStore,
    summaryStore: SummaryIndexStore,
    totalBudget: number,
    systemPromptTokens: number,
    recentTailTurns: number,
    sharedDataDir: string,
    workspaceDir: string,
  ): Promise<{ budget: ContextBudget; items: ContextItem[] }> {
    const budget = this.allocateBudget(totalBudget, systemPromptTokens);
    const stablePrefix = await this.stablePrefixStore.load(sharedDataDir, workspaceDir, budget.stablePrefixBudget);
    const summaries = this.assembleSummaries(summaryStore, budget.summaryBudget);
    const recentTail = this.assembleRecentTail(rawStore, budget.recentTailBudget, recentTailTurns);
    const items = [...stablePrefix, ...summaries, ...recentTail];
    this.contextViewStore.setItems(items);
    return { budget, items };
  }
}
