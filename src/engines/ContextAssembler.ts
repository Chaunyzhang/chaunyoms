import { ContextBudget, ContextItem } from "../types";
import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import { ContextViewStore } from "../stores/ContextViewStore";
import { StablePrefixStore } from "../stores/StablePrefixStore";
import { estimateTokens } from "../utils/tokenizer";

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

  assembleRecentTail(rawStore: RawMessageStore, budget: number, freshTailTokens: number, maxFreshTailTurns: number): ContextItem[] {
    const recentMessages = rawStore.getRecentTailByTokens(freshTailTokens, maxFreshTailTurns);
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

  buildRecallGuidance(summaryStore: SummaryIndexStore): ContextItem | null {
    const summaryCount = summaryStore.getAllSummaries().length;
    if (summaryCount <= 0) {
      return null;
    }

    const content = [
      "[lcm_recall_guidance]",
      "Compacted summaries exist in chaunyoms.",
      "Use `memory_retrieve` for route-aware recall and `recall_detail` for source-level details.",
      "Treat navigation/index hits as hints, not final facts.",
      "For exact constraints/parameters/quotes, continue recall to source messages.",
    ].join("\n");

    return {
      kind: "summary",
      tokenCount: Math.max(estimateTokens(content), 1),
      content,
      metadata: {
        layer: "lcm_recall_guidance",
        summaryCount,
      },
    };
  }

  async assemble(
    rawStore: RawMessageStore,
    summaryStore: SummaryIndexStore,
    totalBudget: number,
    systemPromptTokens: number,
    freshTailTokens: number,
    maxFreshTailTurns: number,
    sharedDataDir: string,
    workspaceDir: string,
  ): Promise<{ budget: ContextBudget; items: ContextItem[] }> {
    const budget = this.allocateBudget(totalBudget, systemPromptTokens);
    const stablePrefix = await this.stablePrefixStore.load(sharedDataDir, workspaceDir, budget.stablePrefixBudget);
    const recallGuidance = this.buildRecallGuidance(summaryStore);
    const summaries = this.assembleSummaries(summaryStore, budget.summaryBudget);
    const effectiveTailBudget = Math.min(budget.recentTailBudget, freshTailTokens);
    const recentTail = this.assembleRecentTail(rawStore, effectiveTailBudget, freshTailTokens, maxFreshTailTurns);
    const items = [...stablePrefix, ...(recallGuidance ? [recallGuidance] : []), ...summaries, ...recentTail];
    this.contextViewStore.setItems(items);
    return { budget, items };
  }
}
