import {
  ContextBudget,
  ContextItem,
  DurableMemoryRepository,
  FixedPrefixProvider,
  RawMessageRepository,
  SummaryRepository,
} from "../types";
import { ContextViewStore } from "../stores/ContextViewStore";
import { estimateTokens } from "../utils/tokenizer";

interface AssembleOptions {
  includeStablePrefix?: boolean;
  includeSummaries?: boolean;
  includeDurableMemory?: boolean;
}

export class ContextAssembler {
  constructor(
    private readonly contextViewStore: ContextViewStore,
    private readonly fixedPrefixProvider: FixedPrefixProvider,
  ) {}

  allocateBudget(totalBudget: number, systemPromptTokens: number): ContextBudget {
    const availableBudget = Math.max(totalBudget - systemPromptTokens, 0);
    return {
      totalBudget,
      availableBudget,
      stablePrefixBudget: Math.floor(availableBudget * 0.15),
      recentTailBudget: Math.floor(availableBudget * 0.35),
      summaryBudget: Math.floor(availableBudget * 0.2),
      recallBudget: Math.floor(availableBudget * 0.15),
      reserveBudget: Math.max(availableBudget - Math.floor(availableBudget * 0.9), 0),
    };
  }

  assembleRecentTail(rawStore: RawMessageRepository, budget: number, freshTailTokens: number, maxFreshTailTurns: number): ContextItem[] {
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

  assembleSummaries(summaryStore: SummaryRepository, budget: number): ContextItem[] {
    const summaries = [...summaryStore.getAllSummaries()].sort(
      (left, right) => right.endTurn - left.endTurn || right.startTurn - left.startTurn,
    );
    const selected: ContextItem[] = [];
    let consumed = 0;

    for (const summary of summaries) {
      if (consumed + summary.tokenCount > budget && selected.length > 0) {
        break;
      }

      consumed += summary.tokenCount;
      selected.unshift({
        kind: "summary",
        tokenCount: summary.tokenCount,
        summaryId: summary.id,
        content: summary.summary,
        metadata: {
          keywords: summary.keywords,
          toneTag: summary.toneTag,
          constraints: summary.constraints,
          decisions: summary.decisions,
          blockers: summary.blockers,
          exactFacts: summary.exactFacts,
          startTurn: summary.startTurn,
          endTurn: summary.endTurn,
          sourceFirstMessageId: summary.sourceFirstMessageId,
          sourceLastMessageId: summary.sourceLastMessageId,
          sourceStartTimestamp: summary.sourceStartTimestamp,
          sourceEndTimestamp: summary.sourceEndTimestamp,
          sourceSequenceMin: summary.sourceSequenceMin,
          sourceSequenceMax: summary.sourceSequenceMax,
        },
      });
    }

    return selected;
  }

  assembleDurableMemory(durableMemoryStore: DurableMemoryRepository, budget: number): ContextItem[] {
    const memories = [...durableMemoryStore.getAll()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 8);
    const selected: ContextItem[] = [];
    let consumed = 0;

    for (const memory of memories) {
      const content = `[durable_memory:${memory.kind}] ${memory.text}`;
      const tokenCount = estimateTokens(content);
      if (consumed + tokenCount > budget && selected.length > 0) {
        break;
      }

      consumed += tokenCount;
      selected.unshift({
        kind: "summary",
        tokenCount,
        content,
        metadata: {
          layer: "durable_memory",
          kind: memory.kind,
          tags: memory.tags,
        },
      });
    }

    return selected;
  }

  buildRecallGuidance(summaryStore: SummaryRepository): ContextItem | null {
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
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    durableMemoryStore: DurableMemoryRepository,
    totalBudget: number,
    systemPromptTokens: number,
    freshTailTokens: number,
    maxFreshTailTurns: number,
    sharedDataDir: string,
    workspaceDir: string,
    options: AssembleOptions = {},
  ): Promise<{ budget: ContextBudget; items: ContextItem[] }> {
    const budget = this.allocateBudget(totalBudget, systemPromptTokens);
    const stablePrefix = options.includeStablePrefix === false
      ? []
      : await this.fixedPrefixProvider.load(sharedDataDir, workspaceDir, budget.stablePrefixBudget);
    const recallGuidance = options.includeSummaries === false
      ? null
      : this.buildRecallGuidance(summaryStore);
    const summaries = options.includeSummaries === false
      ? []
      : this.assembleSummaries(summaryStore, budget.summaryBudget);
    const durableMemory = options.includeDurableMemory === false
      ? []
      : this.assembleDurableMemory(durableMemoryStore, budget.recallBudget);
    const effectiveTailBudget = Math.min(budget.recentTailBudget, freshTailTokens);
    const recentTail = this.assembleRecentTail(rawStore, effectiveTailBudget, freshTailTokens, maxFreshTailTurns);
    const items = [
      ...stablePrefix,
      ...(recallGuidance ? [recallGuidance] : []),
      ...durableMemory,
      ...summaries,
      ...recentTail,
    ];
    this.contextViewStore.setItems(items);
    return { budget, items };
  }
}
