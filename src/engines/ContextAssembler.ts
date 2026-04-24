import {
  ContextBudget,
  ContextItem,
  ContextViewRepository,
  DurableMemoryRepository,
  FixedPrefixProvider,
  RawMessageRepository,
  SummaryRepository,
} from "../types";
import { estimateTokens } from "../utils/tokenizer";

interface AssembleOptions {
  includeStablePrefix?: boolean;
  includeSummaries?: boolean;
  includeDurableMemory?: boolean;
  activeQuery?: string;
  sessionId?: string;
}

export class ContextAssembler {
  constructor(
    private readonly contextViewStore: ContextViewRepository,
    private readonly fixedPrefixProvider: FixedPrefixProvider,
  ) {}

  private splitStablePrefix(items: ContextItem[]): {
    leading: ContextItem[];
    deferred: ContextItem[];
  } {
    const layerOrder = new Map<string, number>([
      ["shared_cognition", 0],
      ["navigation", 1],
      ["shared_insights", 0],
      ["knowledge_base_index", 1],
    ]);
    const leading: ContextItem[] = [];
    const deferred: ContextItem[] = [];

    for (const item of items) {
      const layer =
        typeof item.metadata?.layer === "string" ? item.metadata.layer : undefined;
      if (layer === "shared_insights" || layer === "knowledge_base_index") {
        deferred.push(item);
        continue;
      }
      leading.push(item);
    }

    const orderWithinBucket = (bucket: ContextItem[]) =>
      [...bucket].sort((left, right) => {
        const leftLayer =
          typeof left.metadata?.layer === "string" ? left.metadata.layer : "";
        const rightLayer =
          typeof right.metadata?.layer === "string" ? right.metadata.layer : "";
        return (layerOrder.get(leftLayer) ?? Number.MAX_SAFE_INTEGER) -
          (layerOrder.get(rightLayer) ?? Number.MAX_SAFE_INTEGER);
      });

    return {
      leading: orderWithinBucket(leading),
      deferred: orderWithinBucket(deferred),
    };
  }

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

  assembleRecentTail(
    rawStore: RawMessageRepository,
    budget: number,
    freshTailTokens: number,
    maxFreshTailTurns: number,
    sessionId?: string,
  ): ContextItem[] {
    const recentMessages = rawStore.getRecentTailByTokens(freshTailTokens, maxFreshTailTurns, { sessionId });
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

  assembleSummaries(summaryStore: SummaryRepository, budget: number, sessionId?: string): ContextItem[] {
    const rootSummaries = summaryStore.getRootSummaries({ sessionId });
    const sourceSummaries = rootSummaries.length > 0
      ? rootSummaries
      : summaryStore.getActiveSummaries({ sessionId });
    const summaries = [...sourceSummaries].sort(
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
          memoryType: summary.memoryType,
          phase: summary.phase,
          constraints: summary.constraints,
          decisions: summary.decisions,
          blockers: summary.blockers,
          nextSteps: summary.nextSteps,
          keyEntities: summary.keyEntities,
          exactFacts: summary.exactFacts,
          promotionIntent: summary.promotionIntent,
          projectId: summary.projectId,
          topicId: summary.topicId,
          summaryLevel: summary.summaryLevel,
          nodeKind: summary.nodeKind,
          parentSummaryId: summary.parentSummaryId,
          childSummaryIds: summary.childSummaryIds,
          sourceSummaryIds: summary.sourceSummaryIds,
          startTurn: summary.startTurn,
          endTurn: summary.endTurn,
          sourceFirstMessageId: summary.sourceFirstMessageId,
          sourceLastMessageId: summary.sourceLastMessageId,
          sourceStartTimestamp: summary.sourceStartTimestamp,
          sourceEndTimestamp: summary.sourceEndTimestamp,
          sourceSequenceMin: summary.sourceSequenceMin,
          sourceSequenceMax: summary.sourceSequenceMax,
          sourceBinding: summary.sourceBinding,
        },
      });
    }

    return selected;
  }

  assembleDurableMemory(durableMemoryStore: DurableMemoryRepository, budget: number): ContextItem[] {
    const memories = [...durableMemoryStore.getAll()]
      .filter((entry) => entry.recordStatus === "active")
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
          projectId: memory.projectId,
          topicId: memory.topicId,
          recordStatus: memory.recordStatus,
        },
      });
    }

    return selected;
  }

  buildRecallGuidance(summaryStore: SummaryRepository, sessionId?: string): ContextItem | null {
    const summaryCount = summaryStore.getAllSummaries({ sessionId }).length;
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
      : await this.fixedPrefixProvider.load(
          sharedDataDir,
          workspaceDir,
          budget.stablePrefixBudget,
          {
            activeQuery: options.activeQuery,
          },
        );
    const { leading: leadingStablePrefix, deferred: deferredStablePrefix } =
      this.splitStablePrefix(stablePrefix);
    const recallGuidance = options.includeSummaries === false
      ? null
      : this.buildRecallGuidance(summaryStore, options.sessionId);
    const summaries = options.includeSummaries === false
      ? []
      : this.assembleSummaries(summaryStore, budget.summaryBudget, options.sessionId);
    const durableMemory = options.includeDurableMemory === false
      ? []
      : this.assembleDurableMemory(durableMemoryStore, budget.recallBudget);
    const effectiveTailBudget = Math.min(budget.recentTailBudget, freshTailTokens);
    const recentTail = this.assembleRecentTail(
      rawStore,
      effectiveTailBudget,
      freshTailTokens,
      maxFreshTailTurns,
      options.sessionId,
    );
    const items = [
      ...leadingStablePrefix,
      ...(recallGuidance ? [recallGuidance] : []),
      ...durableMemory,
      ...summaries,
      ...deferredStablePrefix,
      ...recentTail,
    ];
    this.contextViewStore.setItems(items);
    return { budget, items };
  }
}
