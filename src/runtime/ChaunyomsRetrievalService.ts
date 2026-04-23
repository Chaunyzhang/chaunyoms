import path from "node:path";

import { MemoryRetrievalRouter } from "../routing/MemoryRetrievalRouter";
import { RecallResolver } from "../resolvers/RecallResolver";
import { KnowledgeDocumentIndexEntry, KnowledgeImportDocument, KnowledgeImportHit, ContextItem, DurableMemoryEntry, FixedPrefixProvider, KnowledgeRepository, NavigationRepository, ProjectRecord, RetrievalDecision, VectorSearchFallbackRepository } from "../types";
import {
  LifecycleContext,
  OpenClawPayloadAdapter,
} from "../host/OpenClawPayloadAdapter";
import { ChaunyomsSessionRuntime } from "./ChaunyomsSessionRuntime";
import { KnowledgeImportStore } from "../stores/KnowledgeImportStore";

const EMBEDDINGS_API_PROMPT =
  "Current retrieval path needs embeddings search. Ask the user whether to configure an embeddings API now (for example OpenAI or SiliconFlow), or let them skip for now.";

interface ToolResponse {
  content: Array<Record<string, unknown>>;
  details: Record<string, unknown>;
}

export interface RetrievalLayerDependencies {
  fixedPrefixProvider: FixedPrefixProvider;
  navigationRepository: NavigationRepository;
  vectorSearchFallback: VectorSearchFallbackRepository;
}

export class ChaunyomsRetrievalService {
  private readonly recallResolver = new RecallResolver();
  private readonly retrievalRouter = new MemoryRetrievalRouter();
  private readonly fixedPrefixProvider: FixedPrefixProvider;
  private readonly navigationRepository: NavigationRepository;
  private readonly vectorSearchFallback: VectorSearchFallbackRepository;
  private readonly knowledgeImportStores = new Map<string, KnowledgeImportStore>();

  constructor(
    private readonly runtime: ChaunyomsSessionRuntime,
    private readonly payloadAdapter: OpenClawPayloadAdapter,
    private readonly getApi: () => any,
    dependencies: RetrievalLayerDependencies,
  ) {
    this.fixedPrefixProvider = dependencies.fixedPrefixProvider;
    this.navigationRepository = dependencies.navigationRepository;
    this.vectorSearchFallback = dependencies.vectorSearchFallback;
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
              routePlan: decision.routePlan,
              explanation: decision.explanation,
              matchedProjectId: decision.matchedProjectId ?? null,
              matchedProjectTitle: decision.matchedProjectTitle ?? null,
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
        routePlan: decision.routePlan,
        explanation: decision.explanation,
        retrievalHitType: this.getRetrievalHitType(decision),
        matchedProjectId: decision.matchedProjectId ?? null,
        matchedProjectTitle: decision.matchedProjectTitle ?? null,
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
    const { rawStore, summaryStore, durableMemoryStore, projectStore } = await this.runtime.getSessionStores(context);
    const query = this.getQuery(args);
    if (!query) {
      return this.buildMissingQueryResponse("recall_detail");
    }

    const { decision, promptForApi } = await this.resolveRetrievalDecision(query, context);
    const matchedProject = this.matchProject(
      query,
      projectStore.getAll().filter((project) => project.status !== "archived"),
    );
    if (promptForApi) {
      return this.buildEmbeddingsPromptResponse(decision);
    }

    if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
      const durableHits = this.searchDurableHits(
        durableMemoryStore.getAll(),
        query,
        matchedProject?.id,
        5,
      );
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
        routePlan: decision.routePlan,
        explanation: decision.explanation,
      },
    };
  }

  async executeMemoryRetrieve(args: any): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const { rawStore, summaryStore, durableMemoryStore, projectStore, knowledgeStore } = await this.runtime.getSessionStores(context);
    const query = this.getQuery(args);
    if (!query) {
      return this.buildMissingQueryResponse("memory_retrieve");
    }

    const { decision, promptForApi } = await this.resolveRetrievalDecision(query, context);
    const matchedProject = this.matchProject(
      query,
      projectStore.getAll().filter((project) => project.status !== "archived"),
    );
    const durableHits = this.searchDurableHits(
      durableMemoryStore.getAll(),
      query,
      matchedProject?.id,
      3,
    );
    const managedKnowledgeHits = knowledgeStore.searchRelatedDocuments(query, 3);
    const knowledgeImportStore = this.createKnowledgeImportStore(context);
    const importedKnowledgeHits = await knowledgeImportStore.search(query, 3);
    if (promptForApi) {
      return this.buildEmbeddingsPromptResponse(decision);
    }

    if ((decision.requiresSourceRecall || decision.route === "summary_tree") && (!context.config.autoRecallEnabled || context.config.emergencyBrake)) {
      return this.buildRecallDisabledResponse(query, durableHits, context, decision);
    }

    if (decision.route === "project_registry") {
      const project = this.matchProject(query, projectStore.getAll());
      return this.buildProjectRegistryResult(project, decision, query);
    }

    if (decision.route === "durable_memory" && durableHits.length > 0) {
      return {
        content: [{ type: "text", text: this.formatDurableMemoryText(query, durableHits) }],
        details: {
          ok: true,
          route: decision.route,
          routePlan: decision.routePlan,
          explanation: decision.explanation,
          retrievalLabel: this.describeRetrievalRoute(decision),
          query,
          hitCount: durableHits.length,
          retrievalHitType: "durable_memory",
          autoRecall: false,
          autoRecallReason: null,
          matchedProjectId: decision.matchedProjectId ?? null,
          matchedProjectTitle: decision.matchedProjectTitle ?? null,
        },
      };
    }

    if (decision.route === "knowledge" && (managedKnowledgeHits.length > 0 || importedKnowledgeHits.length > 0)) {
      return await this.buildUnifiedKnowledgeResult(
        query,
        knowledgeStore,
        managedKnowledgeHits,
        knowledgeImportStore,
        importedKnowledgeHits,
        decision,
      );
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
            retrievalHitType: "summary_tree_recall",
            autoRecall: true,
            autoRecallReason: this.explainAutoRecall(decision, context),
            routePlan: decision.routePlan,
            explanation: decision.explanation,
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

    if (decision.route === "knowledge") {
      const hit = await this.fixedPrefixProvider.getKnowledgeBaseHit(
        context.config.sharedDataDir,
        query,
      );
      if (hit) {
        return this.buildRouteHitResult(hit, decision, query);
      }
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
            routePlan: decision.routePlan,
            explanation: decision.explanation,
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
          routePlan: decision.routePlan,
          explanation: decision.explanation,
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
        routePlan: decision.routePlan,
        explanation: decision.explanation,
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
    const { rawStore, summaryStore, durableMemoryStore, projectStore, knowledgeStore } = await this.runtime.getSessionStores(context);
    const [hasKnowledgeImportHint, hasSharedInsightHint, hasNavigationHint, hasStructuredNavigationState] =
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
    const projects = projectStore.getAll().filter((project) => project.status !== "archived");
    const matchedProject = this.matchProject(query, projects);
    const scopedDurableHits = this.searchDurableHits(
      durableMemoryStore.getAll(),
      query,
      matchedProject?.id,
      3,
    );
    const hasKnowledgeHits = knowledgeStore.searchRelatedDocuments(query, 1).length > 0;
    const decision = this.retrievalRouter.decide(query, {
      memorySearchEnabled,
      hasKnowledgeHits,
      hasKnowledgeImportHint,
      hasSharedInsightHint,
      hasNavigationHint,
      hasStructuredNavigationState,
      hasCompactedHistory: summaryStore.getAllSummaries().length > 0,
      hasProjectRegistry: projects.length > 0,
      hasDurableHits: scopedDurableHits.length > 0,
      recentAssistantUncertainty: this.hasRecentAssistantUncertainty(rawStore),
      queryComplexity: this.classifyQueryComplexity(query),
      referencesCurrentWork: this.referencesCurrentWork(query),
      matchedProjectId: matchedProject?.id,
      matchedProjectTitle: matchedProject?.title,
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

  private searchDurableHits(
    entries: DurableMemoryEntry[],
    query: string,
    projectId?: string,
    limit = 5,
  ): DurableMemoryEntry[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return [];
    }

    const scored = entries
      .filter((entry) => entry.recordStatus === "active")
      .map((entry) => {
        const haystack = [
          entry.kind,
          entry.projectId ?? "",
          entry.topicId ?? "",
          ...entry.tags,
          entry.text,
        ].join(" ").toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (haystack.includes(term)) {
            score += term.length >= 6 ? 3 : 2;
          }
        }
        if (terms.every((term) => haystack.includes(term))) {
          score += 4;
        }
        if (projectId && entry.projectId === projectId) {
          score += 5;
        }
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.entry.createdAt.localeCompare(left.entry.createdAt);
      });

    return scored.slice(0, Math.max(limit, 1)).map((item) => item.entry);
  }

  private queryTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
  }

  private scoreManagedKnowledge(
    entry: KnowledgeDocumentIndexEntry,
    terms: string[],
  ): number {
    const haystack = [
      entry.slug,
      entry.title,
      entry.summary,
      entry.canonicalKey,
      entry.origin,
      ...entry.tags,
      ...entry.sourceRefs,
    ].join(" ").toLowerCase();
    return this.scoreHaystack(haystack, terms);
  }

  private scoreImportedKnowledge(
    document: KnowledgeImportDocument | null,
    terms: string[],
  ): number {
    const haystack = [
      document?.title ?? "",
      document?.summary ?? "",
      document?.canonicalKey ?? "",
      document?.ref ?? "",
      ...(document?.tags ?? []),
    ].join(" ").toLowerCase();
    return this.scoreHaystack(haystack, terms);
  }

  private scoreHaystack(haystack: string, terms: string[]): number {
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += term.length >= 6 ? 3 : 2;
      }
    }
    if (terms.length > 0 && terms.every((term) => haystack.includes(term))) {
      score += 4;
    }
    return score;
  }

  private prefersImportedKnowledge(query: string): boolean {
    return /(imported knowledge|import source|obsidian|graph|外部知识|外部资料|导入知识|导入资料)/i.test(query);
  }

  private createKnowledgeImportStore(
    context: LifecycleContext,
  ): KnowledgeImportStore {
    const cacheKey = path.normalize(context.config.knowledgeBaseDir);
    const existing = this.knowledgeImportStores.get(cacheKey);
    if (existing) {
      return existing;
    }
    const store = new KnowledgeImportStore(context.config.knowledgeBaseDir, {
      cacheDir: path.join(
        context.config.sharedDataDir,
        "plugin-cache",
        "knowledge-import",
        Buffer.from(cacheKey).toString("hex").slice(0, 24),
      ),
    });
    this.knowledgeImportStores.set(cacheKey, store);
    return store;
  }

  private async buildUnifiedKnowledgeResult(
    query: string,
    knowledgeStore: KnowledgeRepository,
    managedHits: Array<ReturnType<KnowledgeRepository["searchRelatedDocuments"]>[number]>,
    importStore: KnowledgeImportStore,
    importHits: KnowledgeImportHit[],
    decision: RetrievalDecision,
  ): Promise<ToolResponse> {
    const terms = this.queryTerms(query);
    const importedPreference = this.prefersImportedKnowledge(query);
    const managedDocuments = (
      await Promise.all(managedHits.map((hit) => knowledgeStore.getById(hit.docId)))
    ).filter((document): document is NonNullable<typeof document> => Boolean(document));
    const importedDocuments = (
      await Promise.all(importHits.map((hit) => importStore.getById(hit.id)))
    ).filter((document): document is NonNullable<typeof document> => Boolean(document));
    const unifiedHits = [
      ...managedDocuments.map((document) => ({
        recordType: "managed_record" as const,
        score:
          this.scoreManagedKnowledge(document.entry, terms) +
          (importedPreference ? 0 : 1.5),
        title: document.entry.title,
        body: document.content.trim(),
        metadata: [
          `type: managed_record`,
          `origin: ${document.entry.origin}`,
          `bucket: ${document.entry.bucket}`,
          `canonicalKey: ${document.entry.canonicalKey}`,
          `status: ${document.entry.status}`,
          `linked summaries: ${document.entry.linkedSummaryIds.join(", ") || "none"}`,
          `source refs: ${document.entry.sourceRefs.join(", ") || "none"}`,
        ],
      })),
      ...importedDocuments.map((document, index) => ({
        recordType: "source_record" as const,
        score:
          (importHits[index]?.score ?? this.scoreImportedKnowledge(document, terms)) +
          (importedPreference ? 3 : 0),
        title: document.title,
        body: document.content.trim() || document.summary.trim(),
        metadata: [
          "type: external_reference",
          "origin: imported_reference",
          `source: ${document.sourceId}`,
          `canonicalKey: ${document.canonicalKey ?? "none"}`,
          `ref: ${document.ref ?? document.filePath ?? document.id}`,
        ],
      })),
    ]
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, 6);
    const conflictCanonicalKeys = this.detectKnowledgeConflicts(
      managedDocuments.map((document) => document.entry),
      importedDocuments,
    );

    const text = unifiedHits.length > 0
      ? unifiedHits
        .map((hit, index) => [
          `${index + 1}. ${hit.title}`,
          ...hit.metadata.map((line) => `   ${line}`),
          "",
          hit.body,
        ].join("\n"))
        .join("\n\n---\n\n")
      : `No managed knowledge documents matched query: ${query}`;

    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        hitCount: unifiedHits.length,
        managedHitCount: managedDocuments.length,
        importedHitCount: importedDocuments.length,
        topRecordType: unifiedHits[0]?.recordType ?? null,
        conflictDetected: conflictCanonicalKeys.length > 0,
        conflictCanonicalKeys,
        retrievalHitType: "knowledge",
        autoRecall: false,
        autoRecallReason: null,
        routePlan: decision.routePlan,
        explanation: decision.explanation,
      },
      };
  }

  private detectKnowledgeConflicts(
    managedEntries: KnowledgeDocumentIndexEntry[],
    importedDocuments: KnowledgeImportDocument[],
  ): string[] {
    const managedKeys = new Set(
      managedEntries
        .map((entry) => entry.canonicalKey)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    );
    return [...new Set(
      importedDocuments
        .map((document) => document.canonicalKey)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .filter((value) => managedKeys.has(value)),
    )];
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
        routePlan: decision.routePlan,
        explanation: decision.explanation,
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
        routePlan: decision.routePlan,
        explanation: decision.explanation,
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

    return await this.vectorSearchFallback.search(query, config);
  }

  private shouldAutoRecall(decision: RetrievalDecision, context: LifecycleContext): boolean {
    if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
      return false;
    }
    return decision.requiresSourceRecall || decision.route === "summary_tree";
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
    if (decision.route === "summary_tree") {
      return "historical_summary_tree_route_requires_recall";
    }
    return "route_policy_requires_recall";
  }

  private getRetrievalHitType(
    decision: RetrievalDecision,
  ): "route_hit" | "summary_tree_recall" | "vector_retrieval" | "recent_tail" | "project_registry" | "durable_memory" | "knowledge" {
    if (decision.route === "project_registry") {
      return "project_registry";
    }
    if (decision.route === "durable_memory") {
      return "durable_memory";
    }
    if (decision.route === "knowledge") {
      return "knowledge";
    }
    if (
      decision.route === "navigation" ||
      decision.route === "shared_insights"
    ) {
      return "route_hit";
    }
    if (decision.route === "summary_tree") {
      return "summary_tree_recall";
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
      case "project_registry":
        return "project registry state";
      case "durable_memory":
        return "durable memory";
      case "summary_tree":
        return "summary tree -> raw recall";
      case "knowledge":
        return "managed knowledge";
      case "navigation":
        return "navigation route hit";
      case "shared_insights":
        return "shared-insights route hit";
      case "vector_search":
        return "vector retrieval";
      default:
        return decision.route;
    }
  }

  private buildProjectRegistryResult(
    project: ProjectRecord | null,
    decision: RetrievalDecision,
    query: string,
  ): ToolResponse {
    const text = project
      ? [
          `Project: ${project.title}`,
          `Status: ${project.status}`,
          `Summary: ${project.summary}`,
          `Active focus: ${project.activeFocus}`,
          `Current decision: ${project.currentDecision}`,
          `Next step: ${project.nextStep}`,
          `Todo: ${project.todo}`,
          `Blocker: ${project.blocker}`,
          `Risk: ${project.risk}`,
        ].join("\n")
      : `No matching project registry entry found for query: ${query}`;

    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        retrievalHitType: "project_registry",
        routePlan: decision.routePlan,
        explanation: decision.explanation,
        matchedProjectId: project?.id ?? decision.matchedProjectId ?? null,
        matchedProjectTitle: project?.title ?? decision.matchedProjectTitle ?? null,
        autoRecall: false,
        autoRecallReason: null,
      },
    };
  }

  private matchProject(query: string, projects: ProjectRecord[]): ProjectRecord | null {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return projects[0] ?? null;
    }

    let best: { project: ProjectRecord; score: number } | null = null;
    for (const project of projects) {
      const haystack = [
        project.title,
        project.canonicalKey,
        project.summary,
        project.activeFocus,
        ...project.tags,
        ...project.topicIds,
      ].join(" ").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) {
          score += term.length >= 6 ? 3 : 2;
        }
      }
      if (project.title && query.toLowerCase().includes(project.title.toLowerCase())) {
        score += 6;
      }
      if (score <= 0) {
        continue;
      }
      if (!best || score > best.score) {
        best = { project, score };
      }
    }
    return best?.project ?? null;
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
        retrievalHitType: decision.route === "knowledge" ? "knowledge" : "route_hit",
        autoRecall: false,
        autoRecallReason: null,
        routePlan: decision.routePlan,
        explanation: decision.explanation,
        matchedProjectId: decision.matchedProjectId ?? null,
        matchedProjectTitle: decision.matchedProjectTitle ?? null,
      },
    };
  }
}


