import {
  RawMessage,
  RawMessageRepository,
  RecallResult,
  SummaryEntry,
  SummaryRepository,
} from "../types";
import { SourceMessageResolution, SourceMessageResolver } from "./SourceMessageResolver";
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
    const seenMessageIds = new Set<string>();
    let consumedTokens = 0;

    for (const hit of hits) {
      const resolution = this.sourceResolver.resolve(rawStore, hit);
      sourceTrace.push(SourceMessageResolver.traceFromResolution(resolution, {
        route: "summary_tree",
        summaryId: hit.id,
      }));
      const rawRequired = options.requireRawSource === true || this.queryRequiresRawSource(query);
      const summaryItem = options.includeSummaryItems && !rawRequired ? this.buildSummaryItem(hit) : null;
      const atomItems = rawRequired ? [] : this.buildEvidenceAtomItems(hit, query, terms, exactAnchors);
      for (const atom of atomItems) {
        if (consumedTokens + atom.tokenCount > recallBudget && items.length > 0) {
          return { items, consumedTokens, sourceTrace, dagTrace, strategy: "summary_navigation" };
        }
        consumedTokens += atom.tokenCount;
        items.push(atom);
      }

      const messages = this.expandAndPrioritizeMessages(
        rawStore,
        resolution,
        query,
        options,
        terms,
        exactAnchors,
      );
      for (const message of messages) {
        if (seenMessageIds.has(message.id)) {
          continue;
        }
        if (consumedTokens + message.tokenCount > recallBudget && items.length > 0) {
          return { items, consumedTokens, sourceTrace, dagTrace, strategy: "summary_navigation" };
        }

        seenMessageIds.add(message.id);
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


  async resolveDelegated(
    query: string,
    summaryStore: SummaryRepository,
    rawStore: RawMessageRepository,
    recallBudget: number,
    options: RecallOptions,
  ): Promise<RecallResult> {
    const requested = options.dagExpansion;
    if (!requested || requested.mode !== "delegated_agent") {
      return this.resolve(query, summaryStore, rawStore, recallBudget, options);
    }

    if (requested.agentProvider !== "llm" || !requested.llmCaller) {
      return this.delegatedFallback(
        query,
        summaryStore,
        rawStore,
        recallBudget,
        options,
        requested.agentProvider !== "llm"
          ? "Configured delegated DAG provider has no runtime executor in this host; falling back to deterministic resolver."
          : "Delegated DAG expansion requested without an LLM caller; falling back to deterministic resolver.",
      );
    }

    const traversal = this.dagResolver.resolve(query, summaryStore, {
      sessionId: options.sessionId,
      maxRoots: 5,
      maxLeaves: 12,
      maxChildrenPerBranch: 6,
    });
    const summaries = summaryStore.getActiveSummaries({ sessionId: options.sessionId });
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    const candidateIds = [
      ...traversal.trace.map((step) => step.summaryId),
      ...traversal.summaries.map((summary) => summary.id),
      ...summaryStore.search(query, { sessionId: options.sessionId }).map((summary) => summary.id),
    ].filter((id, index, ids) => ids.indexOf(id) === index && byId.has(id)).slice(0, 24);

    if (candidateIds.length === 0) {
      return this.delegatedFallback(query, summaryStore, rawStore, recallBudget, options, "No DAG summary candidates were available for delegated expansion.");
    }

    const prompt = this.buildDelegatedDagPrompt(query, candidateIds.map((id) => byId.get(id)!));
    try {
      const rawSelection = await this.withTimeout(
        requested.llmCaller.call({
          model: requested.model,
          prompt,
          temperature: 0,
          maxOutputTokens: 700,
          responseFormat: "json",
        }),
        requested.timeoutMs ?? 120000,
      );
      const selectedIds = this.parseDelegatedSummaryIds(rawSelection)
        .filter((id, index, ids) => ids.indexOf(id) === index && byId.has(id))
        .slice(0, 8);
      if (selectedIds.length === 0) {
        return this.delegatedFallback(query, summaryStore, rawStore, recallBudget, options, "Delegated DAG agent returned no valid summary ids.");
      }
      const selectedSummaries = selectedIds.map((id) => byId.get(id)!);
      const rawResult = this.buildRawRecallFromSummaries(query, selectedSummaries, rawStore, recallBudget, options, traversal.trace);
      return {
        ...rawResult,
        dagExpansion: {
          requestedMode: "delegated_agent",
          executedMode: "delegated_agent",
          agentProvider: requested.agentProvider,
          status: rawResult.items.length > 0 ? "answered" : "safe_no_answer",
          reason: rawResult.items.length > 0
            ? "LLM delegated DAG expansion selected source summaries and OMS expanded them to raw messages."
            : "LLM delegated DAG expansion selected summaries but no raw messages could be resolved.",
          selectedSummaryIds: selectedIds,
        },
      };
    } catch (error) {
      return this.delegatedFallback(
        query,
        summaryStore,
        rawStore,
        recallBudget,
        options,
        `Delegated DAG expansion failed (${error instanceof Error ? error.message : "unknown error"}); falling back to deterministic resolver.`,
      );
    }
  }

  private delegatedFallback(
    query: string,
    summaryStore: SummaryRepository,
    rawStore: RawMessageRepository,
    recallBudget: number,
    options: RecallOptions,
    reason: string,
  ): RecallResult {
    const requested = options.dagExpansion;
    if (requested?.fallbackMode === "safe_no_answer") {
      return {
        items: [],
        consumedTokens: 0,
        sourceTrace: [],
        dagTrace: [],
        strategy: "summary_navigation",
        dagExpansion: {
          requestedMode: "delegated_agent",
          executedMode: "delegated_agent",
          agentProvider: requested.agentProvider,
          status: "safe_no_answer",
          reason,
          selectedSummaryIds: [],
        },
      };
    }
    const fallback = this.resolve(query, summaryStore, rawStore, recallBudget, {
      ...options,
      dagExpansion: undefined,
    });
    return {
      ...fallback,
      dagExpansion: {
        requestedMode: "delegated_agent",
        executedMode: "deterministic",
        agentProvider: requested?.agentProvider ?? "none",
        status: "fallback_deterministic",
        reason,
        selectedSummaryIds: [],
      },
    };
  }

  private buildRawRecallFromSummaries(
    query: string,
    summaries: SummaryEntry[],
    rawStore: RawMessageRepository,
    recallBudget: number,
    options: RecallOptions,
    dagTrace: RecallResult["dagTrace"],
  ): RecallResult {
    const terms = queryTerms(query);
    const exactAnchors = query.match(/\b[A-Z][A-Z0-9_]{2,}\b|\b\d{2,}\b/g) ?? [];
    const items: RecallResult["items"] = [];
    const sourceTrace: RecallResult["sourceTrace"] = [];
    const seenMessageIds = new Set<string>();
    let consumedTokens = 0;
    for (const summary of summaries) {
      const resolution = this.sourceResolver.resolve(rawStore, summary);
      sourceTrace.push(SourceMessageResolver.traceFromResolution(resolution, {
        route: "summary_tree",
        summaryId: summary.id,
      }));
      const messages = this.expandAndPrioritizeMessages(
        rawStore,
        resolution,
        query,
        options,
        terms,
        exactAnchors,
      );
      for (const message of messages) {
        if (seenMessageIds.has(message.id)) {
          continue;
        }
        if (consumedTokens + message.tokenCount > recallBudget && items.length > 0) {
          return { items, consumedTokens, sourceTrace, dagTrace, strategy: "summary_navigation" };
        }
        seenMessageIds.add(message.id);
        consumedTokens += message.tokenCount;
        items.push({
          kind: "message",
          tokenCount: message.tokenCount,
          turnNumber: message.turnNumber,
          role: message.role,
          content: message.content,
          metadata: {
            ...(message.metadata ?? {}),
            messageId: message.id,
            sourceSummaryId: summary.id,
            sourceResolutionStrategy: resolution.strategy,
            sourceVerified: resolution.verified,
            dagExpansionMode: "delegated_agent",
            dagExpansionAgentProvider: options.dagExpansion?.agentProvider,
          },
        });
      }
    }
    return { items, consumedTokens, sourceTrace, dagTrace, strategy: "summary_navigation" };
  }

  private buildDelegatedDagPrompt(query: string, summaries: SummaryEntry[]): string {
    const candidates = summaries.map((summary) => ({
      id: summary.id,
      level: summary.summaryLevel ?? 1,
      kind: summary.nodeKind ?? "leaf",
      turns: `${summary.startTurn}-${summary.endTurn}`,
      parentSummaryIds: summary.parentSummaryIds ?? (summary.parentSummaryId ? [summary.parentSummaryId] : []),
      childSummaryIds: summary.childSummaryIds ?? summary.sourceSummaryIds ?? [],
      summary: this.truncate(summary.summary, 500),
      exactFacts: summary.exactFacts.slice(0, 8),
      constraints: summary.constraints.slice(0, 6),
      decisions: summary.decisions.slice(0, 6),
      keyEntities: (summary.keyEntities ?? []).slice(0, 10),
      keywords: summary.keywords.slice(0, 12),
    }));
    return [
      "You are the delegated ChaunyOMS DAG expansion sub-agent.",
      "Goal: choose only the summary ids that should be expanded back to raw source messages for the user query.",
      "Hard rules:",
      "- Return JSON only: {\"selectedSummaryIds\":[\"id\"],\"reason\":\"short reason\"}.",
      "- Never invent ids. Choose ids only from the provided candidates.",
      "- Prefer leaf nodes when available; choose branch nodes only when their children are missing or all needed.",
      "- Choose the smallest sufficient set. Raw messages will be expanded by OMS after your selection.",
      `Query: ${query}`,
      `Candidates: ${JSON.stringify(candidates)}`,
    ].join("\n");
  }

  private parseDelegatedSummaryIds(raw: string): string[] {
    const trimmed = raw.trim();
    const jsonText = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonText) {
      return [];
    }
    try {
      const parsed = JSON.parse(jsonText) as { selectedSummaryIds?: unknown; summaryIds?: unknown };
      const ids = Array.isArray(parsed.selectedSummaryIds)
        ? parsed.selectedSummaryIds
        : Array.isArray(parsed.summaryIds) ? parsed.summaryIds : [];
      return ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim());
    } catch {
      return [];
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("delegated DAG expansion timed out")), Math.max(1, timeoutMs));
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
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

  private expandAndPrioritizeMessages(
    rawStore: RawMessageRepository,
    resolution: SourceMessageResolution,
    query: string,
    options: RecallOptions,
    queryTerms: string[],
    exactAnchors: string[],
  ): ReturnType<RawMessageRepository["getByRange"]> {
    const anchorMessages = options.sessionId
      ? resolution.messages.filter((message) => message.sessionId === options.sessionId)
      : resolution.messages;
    const neighborhood = this.buildLocalNeighborhood(rawStore, resolution, options, anchorMessages);
    const prioritized = this.prioritizeMessages(neighborhood, query, queryTerms, exactAnchors, anchorMessages);
    if (prioritized.length > 0) {
      return prioritized;
    }
    return anchorMessages;
  }

  private buildLocalNeighborhood(
    rawStore: RawMessageRepository,
    resolution: SourceMessageResolution,
    options: RecallOptions,
    anchorMessages: RawMessage[],
  ): RawMessage[] {
    if (anchorMessages.length === 0) {
      return [];
    }

    const sessionId = options.sessionId ?? resolution.binding.sessionId;
    const scopedQuery = sessionId ? { sessionId } : {};
    const turnNumbers = anchorMessages.map((message) => message.turnNumber).filter(Number.isFinite);
    const sequences = anchorMessages
      .map((message) => message.sequence)
      .filter((sequence): sequence is number => Number.isFinite(sequence));
    const turnMin = turnNumbers.length > 0 ? Math.min(...turnNumbers) : resolution.binding.turnStart;
    const turnMax = turnNumbers.length > 0 ? Math.max(...turnNumbers) : resolution.binding.turnEnd;
    const sequenceMin = sequences.length > 0 ? Math.min(...sequences) : resolution.binding.sequenceMin;
    const sequenceMax = sequences.length > 0 ? Math.max(...sequences) : resolution.binding.sequenceMax;
    const turnPadding = anchorMessages.length <= 2 ? 1 : 2;
    const sequencePadding = Math.max(2, Math.min(8, anchorMessages.length * 2));
    const byId = new Map<string, RawMessage>();

    const addMessages = (messages: RawMessage[]): void => {
      for (const message of messages) {
        if (options.sessionId && message.sessionId !== options.sessionId) {
          continue;
        }
        byId.set(message.id, message);
      }
    };

    addMessages(anchorMessages);
    if (Number.isFinite(turnMin) && Number.isFinite(turnMax)) {
      addMessages(rawStore.getByRange(
        Math.max(1, (turnMin as number) - turnPadding),
        (turnMax as number) + turnPadding,
        scopedQuery,
      ));
    }
    if (Number.isFinite(sequenceMin) && Number.isFinite(sequenceMax)) {
      const sequenceNeighbors = rawStore.getBySequenceRange(
        Math.max(1, (sequenceMin as number) - sequencePadding),
        (sequenceMax as number) + sequencePadding,
        scopedQuery,
      ).filter((message) => {
        if (!Number.isFinite(message.turnNumber) || !Number.isFinite(turnMin) || !Number.isFinite(turnMax)) {
          return true;
        }
        return message.turnNumber >= (turnMin as number) - turnPadding &&
          message.turnNumber <= (turnMax as number) + turnPadding;
      });
      addMessages(sequenceNeighbors);
    }

    return [...byId.values()].sort((left, right) => {
      const leftSequence = Number.isFinite(left.sequence) ? left.sequence as number : Number.MAX_SAFE_INTEGER;
      const rightSequence = Number.isFinite(right.sequence) ? right.sequence as number : Number.MAX_SAFE_INTEGER;
      if (leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      if (left.turnNumber !== right.turnNumber) {
        return left.turnNumber - right.turnNumber;
      }
      return left.createdAt.localeCompare(right.createdAt);
    });
  }

  private prioritizeMessages(
    messages: ReturnType<RawMessageRepository["getByRange"]>,
    query: string,
    queryTerms: string[],
    exactAnchors: string[],
    anchorMessages: RawMessage[] = [],
  ): ReturnType<RawMessageRepository["getByRange"]> {
    const anchorIds = new Set(anchorMessages.map((message) => message.id));
    const anchorTurns = anchorMessages.map((message) => message.turnNumber).filter(Number.isFinite);
    const minAnchorTurn = anchorTurns.length > 0 ? Math.min(...anchorTurns) : null;
    const maxAnchorTurn = anchorTurns.length > 0 ? Math.max(...anchorTurns) : null;
    const scored = messages.map((message, index) => ({
      message,
      index,
      score: this.scoreMessage(
        message,
        query,
        queryTerms,
        exactAnchors,
        anchorIds,
        minAnchorTurn,
        maxAnchorTurn,
      ),
    }));

    if (!scored.some((item) => item.score > 0)) {
      return messages;
    }

    const selected = scored
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.message.turnNumber !== right.message.turnNumber) {
          return left.message.turnNumber - right.message.turnNumber;
        }
        return left.index - right.index;
      })
      .filter((item) => {
        if (anchorIds.has(item.message.id)) {
          return true;
        }
        if (item.score <= 0) {
          return false;
        }
        if (exactAnchors.length > 0 && !exactAnchors.some((anchor) => item.message.content.includes(anchor))) {
          return false;
        }
        return true;
      })
      .slice(0, Math.max(4, anchorMessages.length + 2))
      .map((item) => item.message);

    return selected.sort((left, right) => {
      const leftSequence = Number.isFinite(left.sequence) ? left.sequence as number : Number.MAX_SAFE_INTEGER;
      const rightSequence = Number.isFinite(right.sequence) ? right.sequence as number : Number.MAX_SAFE_INTEGER;
      if (leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      if (left.turnNumber !== right.turnNumber) {
        return left.turnNumber - right.turnNumber;
      }
      return left.createdAt.localeCompare(right.createdAt);
    });
  }

  private scoreMessage(
    message: RawMessage,
    query: string,
    queryTerms: string[],
    exactAnchors: string[],
    anchorIds: Set<string>,
    minAnchorTurn: number | null,
    maxAnchorTurn: number | null,
  ): number {
    const content = message.content;
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

    const contentScore = score + scoreIntentRoleMatch(query, content).score;

    if (anchorIds.has(message.id)) {
      score = contentScore + 5;
    } else if (contentScore > 0 && minAnchorTurn !== null && maxAnchorTurn !== null) {
      const turnDistance = message.turnNumber < minAnchorTurn
        ? minAnchorTurn - message.turnNumber
        : message.turnNumber > maxAnchorTurn
          ? message.turnNumber - maxAnchorTurn
          : 0;
      if (turnDistance === 0) {
        score = contentScore + 4;
      } else if (turnDistance === 1) {
        score = contentScore + 2;
      } else if (turnDistance === 2) {
        score = contentScore + 1;
      } else {
        score = contentScore;
      }
    } else {
      score = contentScore;
    }

    return score;
  }

}
