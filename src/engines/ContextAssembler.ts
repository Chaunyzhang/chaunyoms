import {
  ContextBudget,
  ContextItem,
  ContextViewRepository,
  MemoryItemDraftEntry,
  MemoryItemDraftRepository,
  FixedPrefixProvider,
  MemoryItemEntry,
  RawMessage,
  RawMessageRepository,
  SummaryEntry,
  SummaryRepository,
} from "../types";
import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import type { RuntimeQueryRecallEvidence } from "../data/SQLiteRuntimeStore";
import { estimateTokens } from "../utils/tokenizer";
import {
  ContextCandidateSource,
  ContextPlanner,
  ContextPlannerCandidate,
  ContextPlannerResult,
} from "./ContextPlanner";

interface AssembleOptions {
  includeStablePrefix?: boolean;
  includeSummaries?: boolean;
  includeMemoryItems?: boolean;
  activeQuery?: string;
  sessionId?: string;
  forceDagOnlyRecall?: boolean;
}

const MIN_RECENT_TAIL_RATIO = 0.05;
const TARGET_RECENT_TAIL_RATIO = 0.07;
const MAX_RECENT_TAIL_RATIO = 0.1;
const MIN_RECENT_TAIL_TURNS = 1;
const MAX_RECENT_TAIL_TURNS = 10;

export class ContextAssembler {
  private readonly planner = new ContextPlanner();

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
      ["knowledge_base_index", 1],
    ]);
    const leading: ContextItem[] = [];
    const deferred: ContextItem[] = [];

    for (const item of items) {
      const layer =
        typeof item.metadata?.layer === "string" ? item.metadata.layer : undefined;
      if (layer === "knowledge_base_index") {
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
    const effectiveTailBudget = this.resolveRecentTailBudget(budget, freshTailTokens);
    const effectiveTailTurns = this.resolveRecentTailTurns(maxFreshTailTurns);
    return this.recentMessagesToItems(
      rawStore.getRecentTailByTokens(effectiveTailBudget, effectiveTailTurns, { sessionId }),
      effectiveTailBudget,
    );
  }

  assembleSummaries(summaryStore: SummaryRepository, budget: number, sessionId?: string): ContextItem[] {
    if (budget <= 0) {
      return [];
    }
    const rootSummaries = summaryStore
      .getRootSummaries({ sessionId })
      .filter((entry) => entry.nodeKind === "branch" || (entry.summaryLevel ?? 1) > 1);
    const sourceSummaries = rootSummaries.length > 0
      ? rootSummaries
      : [];
    const summaries = [...sourceSummaries].sort(
      (left, right) => right.endTurn - left.endTurn || right.startTurn - left.startTurn,
    );
    const selected: SummaryEntry[] = [];
    let consumed = 0;

    for (const summary of summaries) {
      if (consumed + summary.tokenCount > budget) {
        break;
      }

      consumed += summary.tokenCount;
      selected.unshift(summary);
    }

    return this.summaryEntriesToItems(selected);
  }

  assembleMemoryItems(
    memoryItemDraftStore: MemoryItemDraftRepository,
    budget: number,
    options: { rawStore?: RawMessageRepository; sessionId?: string } = {},
  ): ContextItem[] {
    if (budget <= 0) {
      return [];
    }
    const memories = [...memoryItemDraftStore.getAll()]
      .filter((entry) => entry.recordStatus === "active")
      .filter((entry) => this.isDraftMemorySourceCompacted(entry, options.rawStore, options.sessionId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 8);
    return this.memoryInputEntriesToContextItems(memories, budget);
  }

  buildRecallGuidance(summaryStore: SummaryRepository, sessionId?: string): ContextItem | null {
    const summaryCount = summaryStore.getAllSummaries({ sessionId }).length;
    return this.buildRecallGuidanceFromCount(summaryCount);
  }

  private buildRecallGuidanceFromCount(summaryCount: number): ContextItem | null {
    if (summaryCount <= 0) {
      return null;
    }

    const content = [
      "[oms_recall_guidance]",
      "Compacted source messages and summaries exist in chaunyoms.",
      "OpenClaw LLM is the driver; ChaunyOMS is only the memory tool/service provider.",
      "Summaries are recall maps, not answer evidence and not default context.",
      "Use `memory_retrieve` as the primary recall entrypoint when old details appear missing.",
      "Use `oms_expand`/`oms_trace` to descend from summary hits to level-1 base summaries and then source messages.",
      "Treat navigation/index hits as hints, not final facts.",
      "For exact constraints/parameters/quotes, continue recall to source messages.",
    ].join("\n");

    return {
      kind: "summary",
      tokenCount: Math.max(estimateTokens(content), 1),
      content,
      metadata: {
        layer: "oms_recall_guidance",
        summaryCount,
      },
    };
  }

  async assembleFromRuntime(
    runtimeStore: SQLiteRuntimeStore,
    totalBudget: number,
    systemPromptTokens: number,
    freshTailTokens: number,
    maxFreshTailTurns: number,
    sharedDataDir: string,
    workspaceDir: string,
    options: AssembleOptions = {},
  ): Promise<{ budget: ContextBudget; items: ContextItem[]; plan: ContextPlannerResult }> {
    const budget = this.allocateBudget(totalBudget, systemPromptTokens);
    const stablePrefix = options.includeStablePrefix === false
      ? []
      : await this.fixedPrefixProvider.load(
          sharedDataDir,
          workspaceDir,
          budget.stablePrefixBudget,
          { activeQuery: options.activeQuery },
        );
    const { leading: leadingStablePrefix, deferred: deferredStablePrefix } =
      this.splitStablePrefix(stablePrefix);
    const runtimeRead = runtimeStore.withAssemblyRead((runtime) => {
      const recallGuidance = options.includeSummaries === false
        ? null
        : this.buildRecallGuidanceFromCount(runtime.getSummaryCount(options.sessionId));
      const memoryItems = options.includeMemoryItems === false
        ? []
        : this.memoryItemsToContextItems(
          this.filterRuntimeMemoryItemsForDefaultContext(
            runtime.getActiveMemoryItems(24),
            runtime.getCompactedMessageIds,
            options.sessionId,
          ).slice(0, 8),
          budget.recallBudget,
        );
      const fixedPluginTokens = this.sumTokens(stablePrefix) +
        (recallGuidance?.tokenCount ?? 0) +
        this.sumTokens(memoryItems);
      const configuredTailBudget = this.resolveRecentTailBudget(budget.availableBudget, freshTailTokens);
      const effectiveTailBudget = Math.min(
        configuredTailBudget,
        Math.max(
          budget.availableBudget - fixedPluginTokens - budget.reserveBudget,
          0,
        ),
      );
      const effectiveTailTurns = this.resolveRecentTailTurns(maxFreshTailTurns);
      const recentTail = this.recentMessagesToItems(
        runtime.getRecentTailByTokens(effectiveTailBudget, effectiveTailTurns, options.sessionId),
        effectiveTailBudget,
      );
      const queryRecallEvidence = this.shouldForceRawRecallForQuery(options.activeQuery)
        ? runtime.getQueryRecallEvidence(options.activeQuery ?? "", 4, options.sessionId, {
          requireSummaryPath: options.forceDagOnlyRecall === true,
        })
        : { rawHits: [] };
      return {
        recallGuidance,
        memoryItems,
        recentTail,
        queryRecallEvidence,
      };
    });
    if (!runtimeRead) {
      throw new Error("SQLite runtime assembly read unavailable");
    }
    const { recallGuidance, memoryItems, recentTail, queryRecallEvidence } = runtimeRead;
    const queryRawEvidence = this.queryRecallEvidenceToItems(queryRecallEvidence, budget.recallBudget);
    const queryRecallSource: ContextCandidateSource = options.forceDagOnlyRecall === true
      ? "summary_raw_expand"
      : "raw_exact_search";
    return this.planAndStore([
      ...this.tagCandidateSource(queryRawEvidence, queryRecallSource),
      ...this.tagCandidateSource(leadingStablePrefix, "stable_prefix"),
      ...this.tagCandidateSource(recentTail, "recent_tail"),
      ...(recallGuidance ? this.tagCandidateSource([recallGuidance], "summary_context") : []),
      ...this.tagCandidateSource(memoryItems, "active_memory"),
      ...this.tagCandidateSource(deferredStablePrefix, "reviewed_asset"),
    ], budget);
  }

  private shouldForceRawRecallForQuery(query?: string): boolean {
    const normalized = String(query ?? "").toLowerCase();
    if (!normalized.trim()) {
      return false;
    }
    return /\b(earlier|previously|before|told you|i told|remember|recall|what is|what was)\b/.test(normalized) &&
      /\b(codename|code name|project|answer only|exact|fact|alias|port|when|where|who|what)\b/.test(normalized);
  }

  private queryRecallEvidenceToItems(
    evidence: RuntimeQueryRecallEvidence,
    budget: number,
  ): ContextItem[] {
    if (budget <= 0 || evidence.rawHits.length === 0) {
      return [];
    }
    const selected: ContextItem[] = [];
    let consumed = 0;
    for (const hit of evidence.rawHits) {
      const windowMessages = [...hit.before, hit.message, ...hit.after];
      const content = [
        "[ChaunyOMS raw source recall]",
        "Authoritative nearby raw evidence expanded from query-matched memory/summary/raw records.",
        "Prefer exact facts in these raw lines over project ids, labels, prior guesses, or navigation hints.",
        `matched_message_id: ${hit.message.id}`,
        `source_session_id: ${hit.message.sessionId}`,
        `source_turn: ${hit.message.turnNumber}`,
        ...windowMessages.map((message) =>
          `[raw ${message.role} turn ${message.turnNumber} id ${message.id}] ${message.content}`),
      ].join("\n");
      const tokenCount = Math.max(estimateTokens(content), 1);
      if (selected.length > 0 && consumed + tokenCount > budget) {
        break;
      }
      selected.push({
        kind: "summary",
        tokenCount,
        content,
        metadata: {
          layer: "query_raw_recall",
          messageId: hit.message.id,
          sourceKind: hit.sourceKind,
          sourceId: hit.sourceId,
          sourceSessionId: hit.message.sessionId,
          turnNumber: hit.message.turnNumber,
          score: hit.score,
        },
      });
      consumed += tokenCount;
    }
    return selected;
  }

  buildOpenClawRecallSystemItem(): ContextItem {
    const content = [
      "[ChaunyOMS recall policy]",
      "OpenClaw LLM is the driver. OMS is only a memory tool/service provider and does not answer for you.",
      "If the answer is not directly present in visible context, do not guess and do not stop at 'not found'.",
      "First call memory_retrieve.",
      "If the answer is still unclear, call oms_grep using short keywords or exact phrases instead of repeating the full question.",
      "If summary or source ids are returned, use memory_get, oms_expand, or oms_trace to reach raw source before answering an exact fact.",
      "Once OMS returns answer-bearing raw evidence, answer the user directly; do not switch to filesystem/exec/web tools for memory recall.",
    ].join("\n");

    return {
      kind: "message",
      tokenCount: Math.max(estimateTokens(content), 1),
      role: "system",
      content,
      metadata: {
        layer: "oms_recall_policy",
      },
    };
  }

  async assemble(
    rawStore: RawMessageRepository,
    summaryStore: SummaryRepository,
    memoryItemDraftStore: MemoryItemDraftRepository,
    totalBudget: number,
    systemPromptTokens: number,
    freshTailTokens: number,
    maxFreshTailTurns: number,
    sharedDataDir: string,
    workspaceDir: string,
    options: AssembleOptions = {},
  ): Promise<{ budget: ContextBudget; items: ContextItem[]; plan: ContextPlannerResult }> {
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
    const memoryItems = options.includeMemoryItems === false
      ? []
      : this.assembleMemoryItems(memoryItemDraftStore, budget.recallBudget, {
        rawStore,
        sessionId: options.sessionId,
      });
    const fixedPluginTokens = this.sumTokens(stablePrefix) +
      (recallGuidance?.tokenCount ?? 0) +
      this.sumTokens(memoryItems);
    const configuredTailBudget = this.resolveRecentTailBudget(budget.availableBudget, freshTailTokens);
    const effectiveTailBudget = Math.min(
      configuredTailBudget,
      Math.max(
        budget.availableBudget - fixedPluginTokens - budget.reserveBudget,
        0,
      ),
    );
    const recentTail = this.assembleRecentTail(
      rawStore,
      effectiveTailBudget,
      configuredTailBudget,
      maxFreshTailTurns,
      options.sessionId,
    );
    return this.planAndStore([
      ...this.tagCandidateSource(leadingStablePrefix, "stable_prefix"),
      ...this.tagCandidateSource(recentTail, "recent_tail"),
      ...(recallGuidance ? this.tagCandidateSource([recallGuidance], "summary_context") : []),
      ...this.tagCandidateSource(memoryItems, "active_memory"),
      ...this.tagCandidateSource(deferredStablePrefix, "reviewed_asset"),
    ], budget);
  }

  private recentMessagesToItems(recentMessages: RawMessage[], budget: number): ContextItem[] {
    const selected: ContextItem[] = [];
    let consumed = 0;
    const turnNumbers = [...new Set(recentMessages.map((message) => message.turnNumber))];

    for (let index = turnNumbers.length - 1; index >= 0; index -= 1) {
      const turnNumber = turnNumbers[index];
      const turnMessages = recentMessages.filter((message) => message.turnNumber === turnNumber);
      const turnTokens = turnMessages.reduce((sum, message) => sum + message.tokenCount, 0);
      if (consumed + turnTokens > budget && selected.length > 0) {
        break;
      }

      const remaining = Math.max(budget - consumed, 0);
      const turnItems = this.buildTurnTailItems(turnMessages, remaining);
      if (turnItems.length === 0) {
        break;
      }

      consumed += this.sumTokens(turnItems);
      selected.unshift(...turnItems);
    }

    return selected;
  }

  private resolveRecentTailBudget(availableBudget: number, configuredFreshTailTokens: number): number {
    if (availableBudget <= 0 || configuredFreshTailTokens <= 0) {
      return 0;
    }
    const minBudget = Math.max(1, Math.floor(availableBudget * MIN_RECENT_TAIL_RATIO));
    const targetBudget = Math.max(1, Math.floor(availableBudget * TARGET_RECENT_TAIL_RATIO));
    const maxBudget = Math.max(minBudget, Math.floor(availableBudget * MAX_RECENT_TAIL_RATIO));
    const configuredBudget = Math.max(1, Math.floor(configuredFreshTailTokens));
    return Math.min(Math.max(configuredBudget, minBudget, targetBudget), maxBudget);
  }

  private resolveRecentTailTurns(maxFreshTailTurns: number): number {
    if (maxFreshTailTurns <= 0) {
      return 0;
    }
    return Math.min(
      MAX_RECENT_TAIL_TURNS,
      Math.max(MIN_RECENT_TAIL_TURNS, Math.floor(maxFreshTailTurns)),
    );
  }

  private buildTurnTailItems(turnMessages: RawMessage[], budget: number): ContextItem[] {
    if (budget <= 0) {
      return [];
    }

    const selected: ContextItem[] = [];
    let consumed = 0;

    for (let index = turnMessages.length - 1; index >= 0; index -= 1) {
      const message = turnMessages[index];
      const tokenCount = Math.max(message.tokenCount, 0);
      const remaining = Math.max(budget - consumed, 0);
      if (remaining <= 0) {
        break;
      }
      if (tokenCount > remaining) {
        selected.unshift(this.truncateRecentTailMessage(message, remaining));
        break;
      }
      selected.unshift(this.rawMessageToContextItem(message));
      consumed += tokenCount;
    }

    return selected;
  }

  private rawMessageToContextItem(message: RawMessage): ContextItem {
    return {
      kind: "message" as const,
      tokenCount: message.tokenCount,
      turnNumber: message.turnNumber,
      role: message.role,
      content: message.content,
      metadata: message.metadata,
    };
  }

  private truncateRecentTailMessage(message: RawMessage, tokenBudget: number): ContextItem {
    const marker = "\n\n[chaunyoms: recent tail clipped; full source remains in raw memory and can be recalled with oms_expand/oms_trace]";
    const content = this.truncateByEstimatedTokens(message.content, Math.max(tokenBudget - estimateTokens(marker), 1));
    const clippedContent = `${content}${marker}`;
    return {
      kind: "message",
      tokenCount: Math.max(estimateTokens(clippedContent), 1),
      turnNumber: message.turnNumber,
      role: message.role,
      content: clippedContent,
      metadata: {
        ...(message.metadata ?? {}),
        recentTailClipped: true,
        originalTokenCount: message.tokenCount,
      },
    };
  }

  private truncateByEstimatedTokens(content: string, tokenBudget: number): string {
    const normalizedBudget = Math.max(Math.floor(tokenBudget), 1);
    if (estimateTokens(content) <= normalizedBudget) {
      return content;
    }

    let end = Math.max(1, Math.floor(content.length * (normalizedBudget / Math.max(estimateTokens(content), 1))));
    let candidate = content.slice(Math.max(0, content.length - end));
    while (candidate.length > 1 && estimateTokens(candidate) > normalizedBudget) {
      end = Math.max(1, Math.floor(end * 0.85));
      candidate = content.slice(Math.max(0, content.length - end));
    }
    return candidate.trimStart();
  }

  private summaryEntriesToItems(summaries: SummaryEntry[]): ContextItem[] {
    return summaries.map((summary) => ({
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
        parentSummaryIds: summary.parentSummaryIds,
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
    }));
  }

  private memoryItemsToContextItems(memories: MemoryItemEntry[], budget: number): ContextItem[] {
    const selected: ContextItem[] = [];
    let consumed = 0;

    for (const memory of memories) {
      const content = `[memory_item:${memory.kind}] ${memory.text}`;
      const tokenCount = estimateTokens(content);
      if (consumed + tokenCount > budget) {
        break;
      }

      consumed += tokenCount;
      selected.unshift({
        kind: "summary",
        tokenCount,
        content,
        metadata: {
          layer: "memory_item",
          memoryItemId: memory.id,
          kind: memory.kind,
          tags: memory.tags,
          projectId: memory.projectId,
          topicId: memory.topicId,
          recordStatus: memory.status,
          evidenceLevel: memory.evidenceLevel,
          contextPolicy: memory.contextPolicy,
        },
      });
    }

    return selected;
  }

  private memoryInputEntriesToContextItems(memories: MemoryItemDraftEntry[], budget: number): ContextItem[] {
    const selected: ContextItem[] = [];
    let consumed = 0;

    for (const memory of memories) {
      const content = `[memory_item:${memory.kind}] ${memory.text}`;
      const tokenCount = estimateTokens(content);
      if (consumed + tokenCount > budget) {
        break;
      }

      consumed += tokenCount;
      selected.unshift({
        kind: "summary",
        tokenCount,
        content,
        metadata: {
          layer: "memory_item",
          memoryItemId: `memory-item:${memory.id}`,
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

  private isDraftMemorySourceCompacted(
    memory: MemoryItemDraftEntry,
    rawStore?: RawMessageRepository,
    sessionId?: string,
  ): boolean {
    if (memory.sourceType !== "raw_message") {
      return true;
    }
    if (!rawStore || memory.sourceIds.length === 0) {
      return false;
    }

    const sourceMessages = rawStore.getByIds(memory.sourceIds, { sessionId });
    if (sourceMessages.length !== memory.sourceIds.length) {
      return false;
    }

    return sourceMessages.every((message) => message.compacted);
  }

  private filterRuntimeMemoryItemsForDefaultContext(
    memories: MemoryItemEntry[],
    getCompactedMessageIds: (messageIds: string[], sessionId?: string) => Set<string>,
    sessionId?: string,
  ): MemoryItemEntry[] {
    const rawMessageSourceIds = [
      ...new Set(memories
        .filter((memory) => this.runtimeMemorySourceType(memory) === "raw_message")
        .flatMap((memory) => memory.sourceIds ?? [])),
    ];
    const compactedSourceIds = getCompactedMessageIds(rawMessageSourceIds, sessionId);

    return memories.filter((memory) => {
      if (this.runtimeMemorySourceType(memory) !== "raw_message") {
        return true;
      }
      const sourceIds = memory.sourceIds ?? [];
      return sourceIds.length > 0 &&
        sourceIds.every((sourceId) => compactedSourceIds.has(sourceId));
    });
  }

  private runtimeMemorySourceType(memory: MemoryItemEntry): MemoryItemDraftEntry["sourceType"] | "unknown" {
    const sourceType = memory.metadata?.draftSourceType;
    if (sourceType === "raw_message" || sourceType === "observation" || sourceType === "snapshot") {
      return sourceType;
    }
    if (memory.sourceTable === "memory_item_drafts") {
      return (memory.sourceIds ?? []).length > 0 ? "raw_message" : "snapshot";
    }
    return "unknown";
  }

  private planAndStore(
    entries: Array<{ item: ContextItem; source: ContextCandidateSource }>,
    budget: ContextBudget,
  ): { budget: ContextBudget; items: ContextItem[]; plan: ContextPlannerResult } {
    const candidates = this.buildPlannerCandidates(entries);
    const plan = this.planner.plan(candidates, { budget: budget.availableBudget });
    const items = plan.selected.map((candidate) => candidate.item);
    this.contextViewStore.setItems(items);
    return { budget, items, plan };
  }

  private tagCandidateSource(
    items: ContextItem[],
    source: ContextCandidateSource,
  ): Array<{ item: ContextItem; source: ContextCandidateSource }> {
    return items.map((item) => ({ item, source }));
  }

  private buildPlannerCandidates(
    entries: Array<{ item: ContextItem; source: ContextCandidateSource }>,
  ): ContextPlannerCandidate[] {
    return entries.map((entry, index) =>
      this.planner.buildCandidate(entry.item, entry.source, index),
    );
  }

  private sumTokens(items: ContextItem[]): number {
    return items.reduce((sum, item) => sum + Math.max(item.tokenCount, 0), 0);
  }
}
