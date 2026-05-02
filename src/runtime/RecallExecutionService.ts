import { ContextPlanner } from "../engines/ContextPlanner";
import { DeterministicReranker, type RerankAudit } from "../retrieval/RetrievalEnhancementProviders";
import type { LifecycleContext } from "../host/OpenClawPayloadAdapter";
import { ChaunyomsSessionRuntime } from "./ChaunyomsSessionRuntime";
import type {
  ContextItem,
  MemoryItemEntry,
  ProjectRecord,
  RecallResult,
  RetrievalDecision,
  RetrievalStrength,
  SummaryEntry,
} from "../types";
import type { OmsGrepHit, SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import { estimateTokens } from "../utils/tokenizer";
import type {
  RecallLayer,
  RetrievalBudgetPlan,
  SemanticExpansionResult,
} from "./RetrievalServiceContracts";

export interface RecallExecutionServiceDeps {
  matchProject: (query: string, projects: ProjectRecord[]) => ProjectRecord | null;
  queryTerms: (query: string) => string[];
  scoreMemoryItemEntry: (entry: MemoryItemEntry, terms: string[], query: string) => number;
  scoreSemanticHaystack: (haystack: string, terms: string[], query: string) => number;
  scoreSummaryEntry: (entry: SummaryEntry, terms: string[], query: string) => number;
  semanticTerms: (query: string) => string[];
}

export class RecallExecutionService {
  private readonly contextPlanner = new ContextPlanner();
  private readonly deterministicReranker = new DeterministicReranker();

  constructor(
    private readonly runtime: ChaunyomsSessionRuntime,
    private readonly deps: RecallExecutionServiceDeps,
  ) {}

  async collectSemanticExpansion(args: {
    query: string;
    context: LifecycleContext;
    decision: RetrievalDecision;
    runtimeStore: SQLiteRuntimeStore;
    allowIndexing?: boolean;
    memoryItems: MemoryItemEntry[];
    summaryHits: SummaryEntry[];
    projects: ProjectRecord[];
    matchedProject: ProjectRecord | null;
  }): Promise<SemanticExpansionResult> {
    const expansionEnabled = args.context.config.semanticCandidateExpansionEnabled;
    const shouldUseRag = args.context.config.ragEnabled &&
      args.context.config.ragProvider !== "none" &&
      args.decision.planner?.routeSteps.some((step) => step.layer === "rag_candidates") === true;
    const shouldUseGraph = args.context.config.graphEnabled &&
      args.context.config.graphProvider !== "none" &&
      args.decision.planner?.routeSteps.some((step) => step.layer === "graph_neighbors") === true;
    if (!expansionEnabled && !shouldUseRag && !shouldUseGraph) {
      return {
        candidates: [],
        memoryItemHits: [],
        summaryHits: [],
        projectHit: args.matchedProject,
      };
    }
    const terms = this.deps.semanticTerms(args.query);
    const candidates: import("../types").SemanticCandidate[] = [];
    const indexReport = (shouldUseRag || shouldUseGraph) && args.allowIndexing !== false
      ? args.runtimeStore.indexRetrievalEnhancements(args.context.config, {
          sessionId: args.context.sessionId,
          agentId: args.context.config.agentId,
        })
      : null;
    const ragSearch = shouldUseRag
      ? args.runtimeStore.searchVectorCandidates(args.query, args.context.config, {
          sessionId: args.context.sessionId,
          agentId: args.context.config.agentId,
          limit: args.context.config.vectorSearchMaxCandidates,
        })
      : undefined;
    const graphSearch = shouldUseGraph
      ? args.runtimeStore.searchGraphCandidates(args.query, args.context.config, {
          sessionId: args.context.sessionId,
          agentId: args.context.config.agentId,
          seedIds: ragSearch?.candidates
            .map((candidate) => typeof candidate.metadata?.sourceId === "string" ? `node:${candidate.metadata.sourceKind}:${candidate.metadata.sourceId}` : "")
            .filter(Boolean),
          limit: args.context.config.graphCandidateLimit,
        })
      : undefined;
    for (const search of [ragSearch, graphSearch].filter(Boolean) as import("../data/SQLiteRuntimeStore").RuntimeEnhancementSearchResult[]) {
      for (const candidate of search.candidates) {
        const sourceKind = typeof candidate.metadata?.sourceKind === "string"
          ? candidate.metadata.sourceKind
          : candidate.kind;
        candidates.push({
          kind: (candidate.kind === "raw_message"
            ? "summary"
            : candidate.kind === "evidence_atom"
              ? "memory_item"
              : candidate.kind) as import("../types").SemanticCandidate["kind"],
          id: typeof candidate.metadata?.sourceId === "string" ? candidate.metadata.sourceId : candidate.id,
          title: candidate.title ?? candidate.content?.slice(0, 80) ?? candidate.id,
          score: candidate.score,
          reasons: [
            `${search.mode}:${candidate.reason}`,
            ...(indexReport?.warnings ?? []),
            ...(search.warnings ?? []),
          ],
          authority: candidate.sourceVerified ? "authoritative" : "hint",
          sourceRoute: "semantic_candidate_expansion",
          requiresSourceRecall: sourceKind === "summary",
          matchedProjectId: typeof candidate.metadata?.projectId === "string" ? candidate.metadata.projectId : undefined,
        });
      }
    }

    const memoryItemHits = [...args.memoryItems]
      .filter((entry) => entry.status === "active" && entry.contextPolicy !== "never")
      .map((entry) => ({
        entry,
        score: this.deps.scoreMemoryItemEntry(entry, terms, args.query) +
          (args.matchedProject?.id && entry.projectId === args.matchedProject.id ? 4 : 0),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt))
      .slice(0, Math.max(args.context.config.semanticCandidateLimit, 1));
    for (const item of memoryItemHits) {
      const matchedProjectTitle = args.matchedProject && args.matchedProject.id === item.entry.projectId
        ? args.matchedProject.title
        : undefined;
      candidates.push({
        kind: "memory_item",
        id: item.entry.id,
        title: `[${item.entry.kind}] ${item.entry.text.slice(0, 72)}`,
        score: item.score,
        reasons: [
          `memory_item:${item.entry.kind}`,
          `source:${item.entry.sourceTable}`,
          `evidence:${item.entry.evidenceLevel}`,
          ...(args.matchedProject?.id && item.entry.projectId === args.matchedProject.id
            ? ["matched_project"]
            : []),
        ],
        authority: item.entry.inferred ? "hint" : "authoritative",
        sourceRoute: "semantic_candidate_expansion",
        matchedProjectId: item.entry.projectId,
        matchedProjectTitle,
      });
    }

    const summaryHits = [...args.summaryHits]
      .map((entry) => ({
        entry,
        score: this.deps.scoreSummaryEntry(entry, terms, args.query),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.createdAt.localeCompare(left.entry.createdAt))
      .slice(0, Math.max(args.context.config.semanticCandidateLimit, 1));
    for (const item of summaryHits) {
      const matchedProjectTitle = args.matchedProject && args.matchedProject.id === item.entry.projectId
        ? args.matchedProject.title
        : undefined;
      candidates.push({
        kind: "summary",
        id: item.entry.id,
        title: item.entry.summary.slice(0, 80),
        score: item.score,
        reasons: [
          `summary_level:${item.entry.summaryLevel ?? 1}`,
          `memory_type:${item.entry.memoryType ?? "general"}`,
        ],
        authority: "authoritative",
        sourceRoute: "semantic_candidate_expansion",
        requiresSourceRecall: true,
        matchedProjectId: item.entry.projectId,
        matchedProjectTitle,
      });
    }

    const projectHit = args.matchedProject ?? this.deps.matchProject(args.query, args.projects);
    if (projectHit) {
      const projectScore = this.deps.scoreSemanticHaystack(
        [
          projectHit.title,
          projectHit.summary,
          projectHit.activeFocus,
          projectHit.currentDecision,
          projectHit.nextStep,
          projectHit.todo,
          projectHit.blocker,
          projectHit.risk,
          ...projectHit.tags,
        ].join(" "),
        terms,
        args.query,
      );
      if (projectScore > 0) {
        candidates.push({
          kind: "project_registry",
          id: projectHit.id,
          title: projectHit.title,
          score: projectScore + 2,
          reasons: ["project_registry", "matched_project_state"],
          authority: "authoritative",
          sourceRoute: "semantic_candidate_expansion",
          matchedProjectId: projectHit.id,
          matchedProjectTitle: projectHit.title,
        });
      }
    }

    return {
      candidates: [...candidates]
        .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
        .slice(0, Math.max(args.context.config.semanticCandidateLimit, 1)),
      memoryItemHits: memoryItemHits.map((item) => item.entry),
      summaryHits: summaryHits.map((item) => item.entry),
      projectHit,
      ragSearch,
      graphSearch,
    };
  }

  emptySemanticExpansion(projectHit: ProjectRecord | null = null): SemanticExpansionResult {
    return {
      candidates: [],
      memoryItemHits: [],
      summaryHits: [],
      projectHit,
      ragSearch: undefined,
      graphSearch: undefined,
    };
  }

  mergeEnhancementCandidatesIntoRecallResult(
    result: RecallResult,
    semanticExpansion: SemanticExpansionResult,
    tokenBudget: number,
  ): RecallResult {
    const existing = new Set(
      result.items.map((item) =>
        [
          item.kind,
          item.summaryId ?? item.metadata?.messageId ?? "",
          item.content.slice(0, 120),
        ].join("|"),
      ),
    );
    const enhancementCandidates = [
      ...(semanticExpansion.ragSearch?.candidates ?? []),
      ...(semanticExpansion.graphSearch?.candidates ?? []),
    ].sort((left, right) => right.score - left.score);
    const enhancementItems: ContextItem[] = [];
    let consumed = result.consumedTokens;
    for (const candidate of enhancementCandidates) {
      const content = candidate.content?.trim();
      if (!content) {
        continue;
      }
      const tokenCount = Math.max(candidate.tokenCount ?? estimateTokens(content), 1);
      if (consumed + tokenCount > tokenBudget) {
        break;
      }
      const sourceKind = typeof candidate.metadata?.sourceKind === "string"
        ? candidate.metadata.sourceKind
        : candidate.kind;
      const sourceId = typeof candidate.metadata?.sourceId === "string"
        ? candidate.metadata.sourceId
        : candidate.id;
      const key = ["enhancement", sourceKind, sourceId, content.slice(0, 120)].join("|");
      if (existing.has(key)) {
        continue;
      }
      existing.add(key);
      consumed += tokenCount;
      enhancementItems.push({
        kind: "summary",
        summaryId: candidate.kind === "summary" ? sourceId : undefined,
        tokenCount,
        content,
        metadata: {
          retrievalEnhancement: true,
          enhancementReason: candidate.reason,
          enhancementScore: candidate.score,
          sourceKind,
          sourceId,
          sourceVerified: candidate.sourceVerified === true,
          ...(candidate.metadata ?? {}),
        },
      });
    }
    if (enhancementItems.length === 0) {
      return result;
    }
    return {
      ...result,
      items: [...enhancementItems, ...result.items],
      consumedTokens: consumed,
    };
  }

  async collectRawFtsHints(
    context: LifecycleContext,
    queries: string[],
    sessionId: string | undefined,
    limit: number,
  ): Promise<OmsGrepHit[]> {
    const runtimeStore = await this.runtime.getRuntimeStore(context);
    const byId = new Map<string, OmsGrepHit>();
    for (const query of queries) {
      for (const hit of runtimeStore.grepMessages(query, {
        sessionId,
        limit,
        contextTurns: 0,
      })) {
        if (!byId.has(hit.message.id)) {
          byId.set(hit.message.id, hit);
        }
        if (byId.size >= limit) {
          break;
        }
      }
      if (byId.size >= limit) {
        break;
      }
    }
    return [...byId.values()];
  }

  resolveRetrievalBudgetPlan(args: unknown, totalBudget: number): RetrievalBudgetPlan {
    const budget = this.isRecord(args) ? args.budget : undefined;
    const deepRecall = this.isRecord(args) && (args.deepRecall === true || args.qualityMode === true);
    const maxAutomaticBudget = deepRecall
      ? Math.min(totalBudget * 0.05, 10000)
      : Math.min(totalBudget * 0.015, 3000);
    const resolvedBudget = typeof budget === "number" && Number.isFinite(budget)
      ? Math.min(budget, totalBudget * 0.1, 20000)
      : maxAutomaticBudget;
    const total = Math.max(256, Math.floor(resolvedBudget));
    const atom = Math.max(80, Math.min(deepRecall ? 3000 : 1600, Math.floor(total * (deepRecall ? 0.35 : 0.42))));
    let raw = Math.max(80, Math.min(deepRecall ? 4500 : 1800, Math.floor(total * (deepRecall ? 0.35 : 0.28))));
    let summary = total - atom - raw;
    if (summary < 80) {
      raw = Math.max(40, raw - (80 - summary));
      summary = total - atom - raw;
    }
    return {
      total,
      atom,
      summary,
      raw,
      perItem: {
        atom: Math.max(120, Math.min(atom, deepRecall ? 420 : 260)),
        summary: Math.max(240, Math.min(summary, deepRecall ? 1400 : 800)),
        raw: Math.max(300, Math.min(raw, deepRecall ? 1600 : 900)),
      },
    };
  }

  resolveRawFtsHintLimit(args: unknown): number {
    const deepRecall = this.isRecord(args) && (args.deepRecall === true || args.qualityMode === true);
    const defaultLimit = deepRecall ? 48 : 16;
    const explicit = this.getOptionalNumberArg(args, "rawFtsLimit");
    if (typeof explicit === "number") {
      const floor = deepRecall ? defaultLimit : 1;
      return Math.max(floor, Math.min(100, Math.floor(explicit)));
    }
    return defaultLimit;
  }

  shouldUseFtsRecallHints(args: unknown, context: LifecycleContext): boolean {
    if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
      return false;
    }
    if (this.isRecord(args) && args.rawFts === false) {
      return false;
    }
    return true;
  }

  allowWideRawFallback(args: unknown, decision: RetrievalDecision): boolean {
    if (this.isRecord(args) && args.wideRawFallback === true) {
      return true;
    }
    return decision.reason !== "keyword_query_with_compacted_history" ||
      (this.isRecord(args) && (args.deepRecall === true || args.qualityMode === true));
  }

  async planRecallItems(
    query: string,
    result: RecallResult,
    retrievalBudget: RetrievalBudgetPlan,
    config: LifecycleContext["config"],
    decision?: RetrievalDecision,
  ): Promise<{
    items: ContextItem[];
    consumedTokens: number;
    plan: ReturnType<ContextPlanner["plan"]>;
    rerankAudit: RerankAudit;
  }> {
    const answerEvidenceIds = new Set((result.answerCandidates ?? []).flatMap((candidate) => candidate.evidenceMessageIds));
    const recallItems = result.items.map((item) =>
      this.buildBudgetAwareRecallItem(query, item, this.layerPerItemBudget(this.classifyRecallLayer(item), retrievalBudget)),
    );
    const candidates = recallItems.map((item, index) => {
      const source = this.contextSourceForRecallItem(item, result);
      const candidate = this.contextPlanner.buildCandidate(item, source, index);
      const messageId = typeof item.metadata?.messageId === "string" ? item.metadata.messageId : null;
      if (messageId && answerEvidenceIds.has(messageId)) {
        candidate.score += 120;
        candidate.reasons.push("answer_evidence");
      }
      const layer = this.classifyRecallLayer(item);
      if (layer === "atom") {
        candidate.score += 40;
        candidate.reasons.push("evidence_atom_first");
      } else if (layer === "raw" && this.queryNeedsRawSource(query)) {
        candidate.score += 30;
        candidate.reasons.push("raw_source_requested");
      }
      return candidate;
    });
    const forceRerank = Boolean(decision?.planner?.routeSteps.some((step) => step.layer === "rerank" && step.action === "order"));
    const reranked = this.deterministicReranker.rerank(
      candidates.map((candidate) => ({
        id: candidate.id,
        lane: this.classifyRecallLayer(candidate.item),
        score: candidate.score,
        sourceVerified: candidate.authority === "raw_evidence" || candidate.authority === "source_backed_summary",
        authority: candidate.authority,
        tokenCount: candidate.item.tokenCount,
        payload: candidate,
      })),
      config,
      {
        force: forceRerank,
        strictConflict: this.hasStrictCandidateConflict(config.retrievalStrength, result),
      },
    );
    const modelReranked = await this.tryModelRerank(query, reranked, config);
    const orderedCandidates = modelReranked.candidates.map((candidate) => ({
      ...candidate.payload,
      reasons: modelReranked.audit.used
        ? [...candidate.payload.reasons, `rerank:${modelReranked.audit.provider}`]
        : candidate.payload.reasons,
    }));
    const layerLimitedCandidates = this.applyRecallLayerBudgets(orderedCandidates, retrievalBudget);
    const plan = this.contextPlanner.plan(layerLimitedCandidates, { budget: retrievalBudget.total });
    return {
      items: plan.selected.map((candidate) => candidate.item),
      consumedTokens: plan.selectedTokens,
      plan,
      rerankAudit: modelReranked.audit,
    };
  }

  private async tryModelRerank<T>(
    query: string,
    reranked: {
      candidates: Array<{
        id: string;
        lane: string;
        score: number;
        sourceVerified?: boolean;
        authority?: string;
        tokenCount?: number;
        payload: T;
      }>;
      audit: RerankAudit;
    },
    config: LifecycleContext["config"],
  ): Promise<typeof reranked> {
    if (!reranked.audit.required || reranked.audit.used) {
      return reranked;
    }
    if (!config.rerankEnabled || config.rerankProvider !== "llm") {
      return reranked;
    }
    if (!config.rerankModel?.trim()) {
      return {
        ...reranked,
        audit: {
          ...reranked.audit,
          providerUnavailableReason: "rerank_model_required",
        },
      };
    }
    const llmCaller = this.runtime.getLlmCaller();
    if (!llmCaller) {
      return {
        ...reranked,
        audit: {
          ...reranked.audit,
          providerUnavailableReason: "rerank_llm_caller_unavailable",
        },
      };
    }
    try {
      const orderedIds = await this.callLlmReranker(query, reranked.candidates, config);
      const byId = new Map(reranked.candidates.map((candidate) => [candidate.id, candidate]));
      const ordered = orderedIds
        .map((id) => byId.get(id))
        .filter((candidate): candidate is (typeof reranked.candidates)[number] => Boolean(candidate));
      const seen = new Set(ordered.map((candidate) => candidate.id));
      const completeOrder = [
        ...ordered,
        ...reranked.candidates.filter((candidate) => !seen.has(candidate.id)),
      ];
      return {
        candidates: completeOrder,
        audit: {
          ...reranked.audit,
          used: true,
          provider: "llm",
          providerAvailable: true,
          providerUnavailableReason: undefined,
          orderedCandidateIds: completeOrder.map((candidate) => candidate.id),
        },
      };
    } catch (error) {
      if (config.rerankFallbackToDeterministic) {
        const fallback = new DeterministicReranker().rerank(reranked.candidates, {
          ...config,
          rerankEnabled: true,
          rerankProvider: "deterministic",
        }, { force: true });
        return {
          candidates: fallback.candidates,
          audit: {
            ...fallback.audit,
            provider: "deterministic_fallback",
            providerUnavailableReason: `explicit_deterministic_fallback_used:${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
      return {
        ...reranked,
        audit: {
          ...reranked.audit,
          providerUnavailableReason: `rerank_llm_failed:${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private async callLlmReranker<T>(
    query: string,
    candidates: Array<{
      id: string;
      lane: string;
      score: number;
      sourceVerified?: boolean;
      authority?: string;
      tokenCount?: number;
      payload: T;
    }>,
    config: LifecycleContext["config"],
  ): Promise<string[]> {
    const llmCaller = this.runtime.getLlmCaller();
    if (!llmCaller) {
      throw new Error("llm_caller_missing");
    }
    const prompt = [
      "You are ChaunyOMS Rerank. Order candidate ids by usefulness for answering the query.",
      'Return JSON only: {"orderedIds":["id"]}.',
      "Prefer source-verified raw/atom evidence over weak hints when relevance is comparable.",
      `query=${JSON.stringify(query)}`,
      `candidates=${JSON.stringify(candidates.slice(0, config.maxRerankCandidates).map((candidate) => ({
        id: candidate.id,
        lane: candidate.lane,
        score: candidate.score,
        sourceVerified: candidate.sourceVerified === true,
        authority: candidate.authority,
        tokenCount: candidate.tokenCount,
        preview: this.previewRerankPayload(candidate.payload),
      })))}`,
    ].join("\n");
    const raw = await this.withTimeout(
      llmCaller.call({
        model: config.rerankModel,
        prompt,
        temperature: 0,
        maxOutputTokens: 160,
        responseFormat: "json",
      }),
      config.rerankTimeoutMs,
    );
    const parsed = this.parseJsonObject(raw) as { orderedIds?: unknown };
    if (!Array.isArray(parsed.orderedIds)) {
      throw new Error("rerank_response_missing_orderedIds");
    }
    return parsed.orderedIds.map((id) => String(id)).filter(Boolean);
  }

  private previewRerankPayload(payload: unknown): string {
    const item = typeof payload === "object" && payload !== null && "item" in payload
      ? (payload as { item?: { content?: unknown } }).item
      : null;
    const content = typeof item?.content === "string"
      ? item.content
      : JSON.stringify(payload);
    return content.slice(0, 500);
  }

  private parseJsonObject(raw: string): Record<string, unknown> {
    const trimmed = raw.trim();
    const jsonText = trimmed.startsWith("{")
      ? trimmed
      : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
    if (!jsonText || !jsonText.startsWith("{")) {
      throw new Error("invalid_json_response");
    }
    return JSON.parse(jsonText) as Record<string, unknown>;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private hasStrictCandidateConflict(retrievalStrength: RetrievalStrength, result: RecallResult): boolean {
    if (retrievalStrength !== "high" && retrievalStrength !== "xhigh") {
      return false;
    }
    const sourceBackedAnswers = (result.answerCandidates ?? [])
      .filter((candidate) => candidate.sourceVerified)
      .map((candidate) => candidate.text.trim().toLowerCase())
      .filter(Boolean);
    return new Set(sourceBackedAnswers).size > 1;
  }

  private contextSourceForRecallItem(
    item: ContextItem,
    result: RecallResult,
  ): "active_memory" | "summary_context" | "raw_exact_search" {
    const layer = this.classifyRecallLayer(item);
    if (layer === "atom") {
      return "active_memory";
    }
    if (layer === "raw" || result.strategy === "raw_first") {
      return "raw_exact_search";
    }
    return "summary_context";
  }

  private classifyRecallLayer(item: ContextItem): RecallLayer {
    if (item.metadata?.persistentEvidenceAtom === true || item.metadata?.evidenceAtom === true || typeof item.metadata?.atomId === "string") {
      return "atom";
    }
    if (item.kind !== "summary") {
      return "raw";
    }
    return "summary";
  }

  private applyRecallLayerBudgets(
    candidates: ReturnType<ContextPlanner["buildCandidate"]>[],
    retrievalBudget: RetrievalBudgetPlan,
  ): ReturnType<ContextPlanner["buildCandidate"]>[] {
    const used: Record<RecallLayer, number> = { atom: 0, summary: 0, raw: 0 };
    const selected: ReturnType<ContextPlanner["buildCandidate"]>[] = [];
    const sorted = [...candidates].sort((left, right) =>
      right.score - left.score ||
      Math.max(left.item.tokenCount, 0) - Math.max(right.item.tokenCount, 0),
    );

    for (const candidate of sorted) {
      const layer = this.classifyRecallLayer(candidate.item);
      const layerBudget = retrievalBudget[layer];
      const tokenCount = Math.max(candidate.item.tokenCount, 0);
      if (layerBudget > 0 && used[layer] + tokenCount > layerBudget && used[layer] > 0) {
        continue;
      }
      used[layer] += tokenCount;
      selected.push(candidate);
    }

    const selectedIds = new Set(selected.map((candidate) => candidate.id));
    return candidates.filter((candidate) => selectedIds.has(candidate.id));
  }

  private layerPerItemBudget(layer: RecallLayer, retrievalBudget: RetrievalBudgetPlan): number {
    return retrievalBudget.perItem[layer];
  }

  private buildBudgetAwareRecallItem(query: string, item: ContextItem, recallBudget: number): ContextItem {
    const tokenCount = Math.max(item.tokenCount, estimateTokens(String(item.content ?? "")), 1);
    const snippetBudget = Math.max(256, Math.min(recallBudget, Math.floor(recallBudget * 0.8)));
    if (tokenCount <= snippetBudget) {
      return item;
    }

    const content = String(item.content ?? "");
    const excerpt = this.buildRecallExcerpt(query, content, snippetBudget);
    const marker = "\n\n[chaunyoms: evidence snippet; use oms_expand/oms_trace with the listed id for the full source]";
    const snippet = `${excerpt}${marker}`;
    return {
      ...item,
      tokenCount: Math.max(estimateTokens(snippet), 1),
      content: snippet,
      metadata: {
        ...(item.metadata ?? {}),
        recallSnippet: true,
        originalTokenCount: tokenCount,
      },
    };
  }

  private buildRecallExcerpt(query: string, content: string, tokenBudget: number): string {
    const normalizedBudget = Math.max(1, Math.floor(tokenBudget));
    if (estimateTokens(content) <= normalizedBudget) {
      return content;
    }

    const charBudget = Math.max(400, Math.floor(content.length * (normalizedBudget / Math.max(estimateTokens(content), 1))));
    const anchor = this.findBestExcerptAnchor(query, content);
    const start = Math.max(0, anchor - Math.floor(charBudget / 2));
    const end = Math.min(content.length, start + charBudget);
    let excerpt = content.slice(start, end);
    while (excerpt.length > 1 && estimateTokens(excerpt) > normalizedBudget) {
      const trim = Math.max(1, Math.floor(excerpt.length * 0.08));
      excerpt = excerpt.slice(trim, Math.max(trim + 1, excerpt.length - trim));
    }
    const prefix = start > 0 ? "... " : "";
    const suffix = end < content.length ? " ..." : "";
    return `${prefix}${excerpt.trim()}${suffix}`;
  }

  private findBestExcerptAnchor(query: string, content: string): number {
    const lower = content.toLowerCase();
    const terms = this.deps.queryTerms(query)
      .filter((term) => term.length >= 3)
      .sort((left, right) => right.length - left.length);
    for (const term of terms) {
      const index = lower.indexOf(term.toLowerCase());
      if (index >= 0) {
        return index;
      }
    }
    return Math.max(0, content.length - 1);
  }

  private queryNeedsRawSource(query: string): boolean {
    return /(quote|verbatim|exact wording|original text|raw source|source span|trace raw|原文|原话|逐字|引用|精确出处|源消息|源码片段)/i.test(query);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  private getOptionalNumberArg(args: unknown, key: string): number | undefined {
    if (!this.isRecord(args)) {
      return undefined;
    }
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }
}
