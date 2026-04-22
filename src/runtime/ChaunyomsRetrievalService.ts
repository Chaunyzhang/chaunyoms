import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { MemoryRetrievalRouter } from "../routing/MemoryRetrievalRouter";
import { RecallResolver } from "../resolvers/RecallResolver";
import { StablePrefixAdapter } from "../data/StablePrefixAdapter";
import { ContextItem, DurableMemoryEntry, FixedPrefixProvider, NavigationRepository, RetrievalDecision } from "../types";
import {
  LifecycleContext,
  OpenClawPayloadAdapter,
} from "../host/OpenClawPayloadAdapter";
import { ChaunyomsSessionRuntime } from "./ChaunyomsSessionRuntime";

const EMBEDDINGS_API_PROMPT =
  "Current retrieval path needs embeddings search. Ask the user whether to configure an embeddings API now (for example OpenAI or SiliconFlow), or let them skip for now.";

interface ToolResponse {
  content: Array<Record<string, unknown>>;
  details: Record<string, unknown>;
}

export class ChaunyomsRetrievalService {
  private readonly recallResolver = new RecallResolver();
  private readonly retrievalRouter = new MemoryRetrievalRouter();
  private readonly fixedPrefixProvider: FixedPrefixProvider;
  private readonly navigationRepository: NavigationRepository;

  constructor(
    private readonly runtime: ChaunyomsSessionRuntime,
    private readonly payloadAdapter: OpenClawPayloadAdapter,
    private readonly getApi: () => any,
    fixedPrefixProvider?: FixedPrefixProvider,
    navigationRepository?: NavigationRepository,
  ) {
    const sharedAdapter = new StablePrefixAdapter();
    this.fixedPrefixProvider = fixedPrefixProvider ?? sharedAdapter;
    this.navigationRepository = navigationRepository ?? sharedAdapter;
  }

  async executeMemoryRoute(args: any): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    await this.runtime.getSessionStores(context);
    const query = this.getQuery(args);
    const { decision, promptForApi } = await this.resolveRetrievalDecision(query, context);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              route: decision.route,
              retrievalLabel: this.describeRetrievalRoute(decision),
              reason: decision.reason,
              requiresEmbeddings: decision.requiresEmbeddings,
              requiresSourceRecall: decision.requiresSourceRecall,
              canAnswerDirectly: decision.canAnswerDirectly,
              shouldAutoRecall: this.shouldAutoRecall(decision, context),
              autoRecallReason: this.explainAutoRecall(decision, context),
              promptForApi,
              retrievalHitType: this.getRetrievalHitType(decision),
              apiPrompt: promptForApi ? EMBEDDINGS_API_PROMPT : null,
              autoRecallEnabled: context.config.autoRecallEnabled,
              emergencyBrake: context.config.emergencyBrake,
            },
            null,
            2,
          ),
        },
      ],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        retrievalHitType: this.getRetrievalHitType(decision),
        shouldAutoRecall: this.shouldAutoRecall(decision, context),
        autoRecallReason: this.explainAutoRecall(decision, context),
        promptForApi,
        autoRecallEnabled: context.config.autoRecallEnabled,
        emergencyBrake: context.config.emergencyBrake,
      },
    };
  }

  async executeRecallDetail(args: any): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const { rawStore, summaryStore, durableMemoryStore } = await this.runtime.getSessionStores(context);
    const query = this.getQuery(args);
    if (!query) {
      return this.buildMissingQueryResponse("recall_detail");
    }

    const { decision, promptForApi } = await this.resolveRetrievalDecision(query, context);
    if (promptForApi) {
      return this.buildEmbeddingsPromptResponse(decision);
    }

    if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
      const durableHits = durableMemoryStore.search(query, 5);
      return this.buildRecallDisabledResponse(query, durableHits, context, decision);
    }

    const recallBudget = this.resolveRecallBudget(args, context.totalBudget);
    const result = this.recallResolver.resolve(query, summaryStore, rawStore, recallBudget);
    return {
      content: [{ type: "text", text: this.formatRecallText(query, result.items) }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        recallBudget,
        consumedTokens: result.consumedTokens,
        hitCount: result.items.length,
        retrievalHitType: this.getRetrievalHitType(decision),
      },
    };
  }

  async executeMemoryRetrieve(args: any): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const { rawStore, summaryStore, durableMemoryStore } = await this.runtime.getSessionStores(context);
    const query = this.getQuery(args);
    if (!query) {
      return this.buildMissingQueryResponse("memory_retrieve");
    }

    const { decision, promptForApi } = await this.resolveRetrievalDecision(query, context);
    const durableHits = durableMemoryStore.search(query, 3);
    if (promptForApi) {
      return this.buildEmbeddingsPromptResponse(decision);
    }

    if ((decision.requiresSourceRecall || decision.route === "dag") && (!context.config.autoRecallEnabled || context.config.emergencyBrake)) {
      return this.buildRecallDisabledResponse(query, durableHits, context, decision);
    }

    if (this.shouldAutoRecall(decision, context)) {
      if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
        return this.buildRecallDisabledResponse(query, durableHits, context, decision);
      }

      const recallBudget = this.resolveRecallBudget(args, context.totalBudget);
      const result = this.recallResolver.resolve(query, summaryStore, rawStore, recallBudget);
      return {
        content: [{ type: "text", text: this.formatRecallText(query, result.items) }],
        details: {
          ok: true,
          route: decision.route,
          retrievalLabel: this.describeRetrievalRoute(decision),
          query,
          consumedTokens: result.consumedTokens,
          hitCount: result.items.length,
          retrievalHitType: "dag_recall",
          autoRecall: true,
          autoRecallReason: this.explainAutoRecall(decision, context),
        },
      };
    }

    if (decision.route === "navigation") {
      const hit = await this.navigationRepository.getNavigationStateHit(
        context.config.workspaceDir,
        query,
      );
      return this.buildRouteHitResult(hit, decision, query);
    }

    if (decision.route === "shared_insights") {
      const hit = await this.fixedPrefixProvider.getSharedInsightHit(
        context.config.sharedDataDir,
        query,
      );
      return this.buildRouteHitResult(hit, decision, query);
    }

    if (decision.route === "knowledge_base") {
      const hit = await this.fixedPrefixProvider.getKnowledgeBaseHit(
        context.config.sharedDataDir,
        query,
      );
      return this.buildRouteHitResult(hit, decision, query);
    }

    if (decision.route === "vector_search") {
      const vector = await this.tryVectorRetrieve(query, context.config);
      if (vector) {
        return {
          content: [{ type: "text", text: vector.text }],
          details: {
            ok: true,
            route: decision.route,
            retrievalLabel: this.describeRetrievalRoute(decision),
            query,
            retrievalHitType: "vector_retrieval",
            autoRecall: false,
            autoRecallReason: null,
            source: vector.source,
            score: vector.score ?? null,
          },
        };
      }
    }

    if (durableHits.length > 0) {
      return {
        content: [{ type: "text", text: this.formatDurableMemoryText(query, durableHits) }],
        details: {
          ok: true,
          route: decision.route,
          retrievalLabel: this.describeRetrievalRoute(decision),
          query,
          hitCount: durableHits.length,
          retrievalHitType: "durable_memory",
          autoRecall: false,
          autoRecallReason: null,
        },
      };
    }

    const recallBudget = this.resolveRecallBudget(args, context.totalBudget);
    const result = this.recallResolver.resolve(query, summaryStore, rawStore, recallBudget);
    return {
      content: [{ type: "text", text: this.formatRecallText(query, result.items) }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        consumedTokens: result.consumedTokens,
        hitCount: result.items.length,
        retrievalHitType: this.getRetrievalHitType(decision),
      },
    };
  }

  private resolveContext(args: any): LifecycleContext {
    return this.payloadAdapter.resolveLifecycleContext(args, this.runtime.getConfig());
  }

  private getQuery(args: any): string {
    return typeof args?.query === "string" ? args.query.trim() : "";
  }

  private resolveRecallBudget(args: any, totalBudget: number): number {
    return Math.max(
      256,
      Math.floor(
        typeof args?.budget === "number" && Number.isFinite(args.budget)
          ? args.budget
          : totalBudget * 0.2,
      ),
    );
  }

  private async resolveRetrievalDecision(
    query: string,
    context: LifecycleContext,
  ): Promise<{ decision: RetrievalDecision; promptForApi: boolean }> {
    const memorySearchEnabled = this.payloadAdapter.hasEmbeddingsRetrievalReady();
    const { rawStore, summaryStore } = await this.runtime.getSessionStores(context);
    const [hasTopicIndexHit, hasSharedInsightHint, hasNavigationHint, hasStructuredNavigationState] =
      await Promise.all([
        this.fixedPrefixProvider.hasKnowledgeBaseTopicHit(
          context.config.sharedDataDir,
          query,
        ),
        this.fixedPrefixProvider.hasSharedInsightHint(
          context.config.sharedDataDir,
          query,
        ),
        this.navigationRepository.hasNavigationHint(
          context.config.workspaceDir,
          query,
        ),
        this.navigationRepository.hasStructuredNavigationState(
          context.config.workspaceDir,
        ),
      ]);
    const decision = this.retrievalRouter.decide(query, {
      memorySearchEnabled,
      hasTopicIndexHit,
      hasSharedInsightHint,
      hasNavigationHint,
      hasStructuredNavigationState,
      hasCompactedHistory: summaryStore.getAllSummaries().length > 0,
      recentAssistantUncertainty: this.hasRecentAssistantUncertainty(rawStore),
      queryComplexity: this.classifyQueryComplexity(query),
      referencesCurrentWork: this.referencesCurrentWork(query),
    });
    return {
      decision,
      promptForApi: decision.requiresEmbeddings && !memorySearchEnabled,
    };
  }

  private classifyQueryComplexity(query: string): "low" | "medium" | "high" {
    const normalized = query.toLowerCase();
    const highSignals = [
      /how should/i,
      /tradeoff/i,
      /compare/i,
      /versus/i,
      /\bvs\b/i,
      /sequence/i,
      /migration/i,
      /dependency/i,
      /dependencies/i,
      /rollout/i,
      /取舍|方案|顺序|依赖|风险|怎么推进|怎么做/i,
    ];
    if (
      normalized.length > 120 ||
      highSignals.some((pattern) => pattern.test(query)) ||
      (query.match(/\?/g)?.length ?? 0) >= 2
    ) {
      return "high";
    }

    if (
      normalized.length > 60 ||
      /(next|status|state|blocker|pending|decision|plan|steps|progress|当前|状态|下一步)/i.test(
        query,
      )
    ) {
      return "medium";
    }

    return "low";
  }

  private referencesCurrentWork(query: string): boolean {
    return /(this project|current task|current work|our work|what we are doing|where we left off|这个项目|当前任务|当前工作|这件事|我们现在|当前主线)/i.test(
      query,
    );
  }

  private hasRecentAssistantUncertainty(rawStore: { getAll(): Array<{ role: string; content: string }> }): boolean {
    return rawStore
      .getAll()
      .slice(-6)
      .some(
        (message) =>
          message.role === "assistant" &&
          /(not sure|unclear|need more context|need context|I may be missing|might need|不确定|不清楚|需要更多上下文|可能需要更多信息)/i.test(
            message.content,
          ),
      );
  }

  private formatRecallText(query: string, items: ContextItem[]): string {
    if (items.length === 0) {
      return `No matching historical details found for query: ${query}`;
    }
    return items
      .map(
        (item) =>
          `[turn ${(item.turnNumber as number | undefined) ?? "?"}] ${(item.role as string | undefined) ?? "user"}: ${String(item.content ?? "")}`,
      )
      .join("\n\n");
  }

  private formatDurableMemoryText(query: string, items: DurableMemoryEntry[]): string {
    return [
      `Durable memory hits for: ${query}`,
      ...items.map((item, index) => `${index + 1}. [${item.kind}] ${item.text}`),
    ].join("\n");
  }

  private buildMissingQueryResponse(toolName: string): ToolResponse {
    return {
      content: [
        {
          type: "text",
          text: `${toolName} requires a non-empty \`query\`.`,
        },
      ],
      details: { ok: false, missingParam: "query" },
    };
  }

  private buildEmbeddingsPromptResponse(decision: RetrievalDecision): ToolResponse {
    return {
      content: [{ type: "text", text: EMBEDDINGS_API_PROMPT }],
      details: {
        ok: false,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        promptForApi: true,
        requiresEmbeddings: true,
        retrievalHitType: this.getRetrievalHitType(decision),
      },
    };
  }

  private buildRecallDisabledResponse(
    query: string,
    durableHits: DurableMemoryEntry[],
    context: LifecycleContext,
    decision: RetrievalDecision,
  ): ToolResponse {
    const text = durableHits.length > 0
      ? `${this.formatDurableMemoryText(query, durableHits)}\n\nSource recall is currently disabled by safety policy.`
      : `Source recall is currently disabled${context.config.emergencyBrake ? " because emergency brake is enabled" : " by configuration"}.`;
    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        hitCount: durableHits.length,
        retrievalHitType: durableHits.length > 0 ? "durable_memory" : this.getRetrievalHitType(decision),
        autoRecall: false,
        autoRecallReason: context.config.emergencyBrake ? "emergency_brake_enabled" : "auto_recall_disabled",
        emergencyBrake: context.config.emergencyBrake,
        autoRecallEnabled: context.config.autoRecallEnabled,
      },
    };
  }

  private async tryVectorRetrieve(
    query: string,
    config: LifecycleContext["config"],
  ): Promise<{ text: string; source?: string; score?: number } | null> {
    const api = this.getApi();
    const callCandidate = async (
      target: any,
      method: "search" | "query",
    ): Promise<{ text: string; source?: string; score?: number } | null> => {
      const fn = target?.[method];
      if (typeof fn !== "function") {
        return null;
      }

      const tryParse = (
        value: any,
      ): { text: string; source?: string; score?: number } | null => {
        if (!value) {
          return null;
        }
        const list = Array.isArray(value)
          ? value
          : Array.isArray(value?.hits)
            ? value.hits
            : Array.isArray(value?.items)
              ? value.items
              : Array.isArray(value?.results)
                ? value.results
                : [];
        const first = list[0] ?? value?.hit ?? value?.result;
        if (!first) {
          return null;
        }
        if (typeof first === "string") {
          return { text: first, source: method };
        }
        const text =
          first.content ??
          first.text ??
          first.chunk ??
          first.snippet ??
          first.document;
        if (typeof text !== "string" || !text.trim()) {
          return null;
        }
        return {
          text: text.trim(),
          source: first.source ?? first.filePath ?? first.path ?? method,
          score: typeof first.score === "number" ? first.score : undefined,
        };
      };

      try {
        const byObject = await Promise.resolve(fn.call(target, { query, topK: 3, k: 3 }));
        const parsed = tryParse(byObject);
        if (parsed) {
          return parsed;
        }
      } catch {}

      try {
        const byString = await Promise.resolve(fn.call(target, query));
        const parsed = tryParse(byString);
        if (parsed) {
          return parsed;
        }
      } catch {}

      return null;
    };

    const runtimeCandidate =
      (await callCandidate(api?.memorySearch, "search")) ??
      (await callCandidate(api?.memorySearch, "query")) ??
      (await callCandidate(api?.context?.memorySearch, "search")) ??
      (await callCandidate(api?.context?.memorySearch, "query")) ??
      (await callCandidate(api?.runtime?.memorySearch, "search")) ??
      (await callCandidate(api?.runtime?.memorySearch, "query"));
    if (runtimeCandidate) {
      return runtimeCandidate;
    }

    const vectorDir = path.join(config.sharedDataDir, "vector-store");
    let files: string[] = [];
    try {
      files = await readdir(vectorDir);
    } catch {
      return null;
    }

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return null;
    }

    let best: { text: string; source?: string; score?: number } | null = null;
    for (const file of files.filter((item) => /\.(jsonl|json|txt|md)$/i.test(item))) {
      const filePath = path.join(vectorDir, file);
      let body = "";
      try {
        body = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      if (!body.trim()) {
        continue;
      }
      const lower = body.toLowerCase();
      const score = terms.reduce((sum, term) => (lower.includes(term) ? sum + 1 : sum), 0);
      if (score <= 0) {
        continue;
      }
      if (!best || score > (best.score ?? 0)) {
        best = {
          text: body.length > 1200 ? `${body.slice(0, 1200)}...` : body,
          source: filePath,
          score,
        };
      }
    }

    return best;
  }

  private shouldAutoRecall(decision: RetrievalDecision, context: LifecycleContext): boolean {
    if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
      return false;
    }
    return decision.requiresSourceRecall || decision.route === "dag";
  }

  private explainAutoRecall(decision: RetrievalDecision, context: LifecycleContext): string | null {
    if (context.config.emergencyBrake) {
      return "emergency_brake_enabled";
    }
    if (!context.config.autoRecallEnabled) {
      return "auto_recall_disabled";
    }
    if (!this.shouldAutoRecall(decision, context)) {
      return null;
    }
    if (decision.requiresSourceRecall) {
      return "fact_or_constraint_query_requires_source_recall";
    }
    if (decision.route === "dag") {
      return "historical_dialog_route_requires_recall";
    }
    return "route_policy_requires_recall";
  }

  private getRetrievalHitType(
    decision: RetrievalDecision,
  ): "route_hit" | "dag_recall" | "vector_retrieval" | "recent_tail" {
    if (
      decision.route === "navigation" ||
      decision.route === "shared_insights" ||
      decision.route === "knowledge_base"
    ) {
      return "route_hit";
    }
    if (decision.route === "dag") {
      return "dag_recall";
    }
    if (decision.route === "vector_search") {
      return "vector_retrieval";
    }
    return "recent_tail";
  }

  private describeRetrievalRoute(decision: RetrievalDecision): string {
    switch (decision.route) {
      case "recent_tail":
        return "recent-tail direct context";
      case "navigation":
        return "navigation route hit";
      case "dag":
        return "oms DAG/source recall";
      case "shared_insights":
        return "shared-insights route hit";
      case "knowledge_base":
        return "knowledge-base route hit";
      case "vector_search":
        return "vector retrieval";
      default:
        return decision.route;
    }
  }

  private buildRouteHitResult(
    hit: { title: string; content: string; filePath?: string } | null,
    decision: RetrievalDecision,
    query: string,
  ): ToolResponse {
    const text =
      hit && hit.content.trim()
        ? hit.content
        : `No direct route-hit content found for query: ${query}`;
    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        title: hit?.title ?? null,
        filePath: hit?.filePath ?? null,
        retrievalHitType: "route_hit",
        autoRecall: false,
        autoRecallReason: null,
      },
    };
  }
}


