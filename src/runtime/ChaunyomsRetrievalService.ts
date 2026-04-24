import { MemoryRetrievalRouter } from "../routing/MemoryRetrievalRouter";
import { RecallResolver } from "../resolvers/RecallResolver";
import {
  ContextItem,
  DurableMemoryEntry,
  FixedPrefixProvider,
  KnowledgeDocumentIndexEntry,
  KnowledgeRepository,
  NavigationRepository,
  ProjectRecord,
  RetrievalDecision,
  SemanticCandidate,
  SummaryEntry,
  VectorSearchFallbackRepository,
} from "../types";
import {
  LifecycleContext,
  OpenClawPayloadAdapter,
} from "../host/OpenClawPayloadAdapter";
import {
  HostFunctionContainer,
  OpenClawApiLike,
} from "../host/OpenClawHostTypes";
import { ChaunyomsSessionRuntime } from "./ChaunyomsSessionRuntime";

const EMBEDDINGS_API_PROMPT =
  "Current retrieval path needs embeddings search. Ask the user whether to configure an embeddings API now (for example OpenAI or SiliconFlow), or let them skip for now.";

interface ToolResponse {
  content: Array<Record<string, unknown>>;
  details: Record<string, unknown>;
}

interface SemanticExpansionResult {
  candidates: SemanticCandidate[];
  knowledgeHits: KnowledgeDocumentIndexEntry[];
  durableHits: DurableMemoryEntry[];
  summaryHits: SummaryEntry[];
  projectHit: ProjectRecord | null;
  vectorHint: { text: string; source?: string; score?: number } | null;
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

  constructor(
    private readonly runtime: ChaunyomsSessionRuntime,
    private readonly payloadAdapter: OpenClawPayloadAdapter,
    private readonly getApi: () => OpenClawApiLike | undefined,
    dependencies: RetrievalLayerDependencies,
  ) {
    this.fixedPrefixProvider = dependencies.fixedPrefixProvider;
    this.navigationRepository = dependencies.navigationRepository;
    this.vectorSearchFallback = dependencies.vectorSearchFallback;
  }

  async executeMemoryRoute(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const stores = await this.runtime.getSessionStores(context);
    const query = this.getQuery(args);
    const { decision, promptForApi } = await this.resolveRetrievalDecision(query, context);
    const semanticExpansion = await this.collectSemanticExpansion({
      query,
      context,
      decision,
      durableEntries: stores.durableMemoryStore.getAll(),
      knowledgeHits: stores.knowledgeStore.searchRelatedDocuments(
        query,
        context.config.semanticCandidateLimit,
      ),
      summaryHits: stores.summaryStore.search(query, { sessionId: context.sessionId }),
      projects: stores.projectStore.getAll().filter((project) => project.status !== "archived"),
      matchedProject: decision.matchedProjectId
        ? stores.projectStore.findById(decision.matchedProjectId)
        : null,
    });
    const configGuidance = this.payloadAdapter.describeConfigGuidance(context.config);
    const diagnostics = this.buildDiagnosticsEnvelope(
      query,
      context,
      decision,
      promptForApi,
      semanticExpansion,
      configGuidance.warnings,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(diagnostics, null, 2),
        },
      ],
      details: diagnostics,
    };
  }

  async executeRecallDetail(args: unknown): Promise<ToolResponse> {
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
    const semanticExpansion = await this.collectSemanticExpansion({
      query,
      context,
      decision,
      durableEntries: durableMemoryStore.getAll(),
      knowledgeHits: [],
      summaryHits: summaryStore.search(query, { sessionId: context.sessionId }),
      projects: projectStore.getAll().filter((project) => project.status !== "archived"),
      matchedProject,
    });
    if (promptForApi) {
      return this.attachDiagnostics(
        this.buildEmbeddingsPromptResponse(decision),
        query,
        context,
        decision,
        semanticExpansion,
        true,
      );
    }

    if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
      const durableHits = this.searchDurableHits(
        durableMemoryStore.getAll(),
        query,
        matchedProject?.id,
        5,
      );
      return this.attachDiagnostics(
        this.buildRecallDisabledResponse(query, durableHits, context, decision),
        query,
        context,
        decision,
        semanticExpansion,
      );
    }

    const recallBudget = this.resolveRecallBudget(args, context.totalBudget);
    const result = this.recallResolver.resolve(query, summaryStore, rawStore, recallBudget);
    return this.attachDiagnostics({
      content: [{ type: "text", text: this.formatRecallText(query, result.items, result.sourceTrace) }],
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
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        dagTrace: result.dagTrace,
        sourceTrace: result.sourceTrace,
      },
    }, query, context, decision, semanticExpansion);
  }

  async executeMemoryRetrieve(args: unknown): Promise<ToolResponse> {
    const context = this.resolveContext(args);
    const { rawStore, summaryStore, durableMemoryStore, projectStore, knowledgeStore } = await this.runtime.getSessionStores(context);
    const query = this.getQuery(args);
    if (!query) {
      return this.buildMissingQueryResponse("memory_retrieve");
    }

    const { decision, promptForApi } = await this.resolveRetrievalDecision(query, context);
    const activeProjects = projectStore.getAll().filter((project) => project.status !== "archived");
    const matchedProject = this.matchProject(query, activeProjects);
    const durableHits = this.searchDurableHits(
      durableMemoryStore.getAll(),
      query,
      matchedProject?.id,
      3,
    );
    const managedKnowledgeHits = knowledgeStore.searchRelatedDocuments(query, 6);
    const semanticExpansion = await this.collectSemanticExpansion({
      query,
      context,
      decision,
      durableEntries: durableMemoryStore.getAll(),
      knowledgeHits: managedKnowledgeHits,
      summaryHits: summaryStore.search(query, { sessionId: context.sessionId }),
      projects: activeProjects,
      matchedProject,
    });
    if (promptForApi) {
      return this.attachDiagnostics(
        this.buildEmbeddingsPromptResponse(decision),
        query,
        context,
        decision,
        semanticExpansion,
        true,
      );
    }

    if ((decision.requiresSourceRecall || decision.route === "summary_tree") && (!context.config.autoRecallEnabled || context.config.emergencyBrake)) {
      return this.attachDiagnostics(
        this.buildRecallDisabledResponse(query, durableHits, context, decision),
        query,
        context,
        decision,
        semanticExpansion,
      );
    }

    if (decision.route === "project_registry") {
      const project = this.matchProject(query, projectStore.getAll());
      return this.attachDiagnostics(
        this.buildProjectRegistryResult(project, decision, query),
        query,
        context,
        decision,
        semanticExpansion,
      );
    }

    if (decision.route === "durable_memory" && durableHits.length > 0) {
      return this.attachDiagnostics({
        content: [{ type: "text", text: this.formatDurableMemoryText(query, durableHits) }],
        details: {
          ok: true,
          route: decision.route,
          routePlan: decision.routePlan,
          layerScores: decision.layerScores ?? [],
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
      }, query, context, decision, semanticExpansion);
    }

    if (decision.route === "knowledge" && managedKnowledgeHits.length > 0) {
      return this.attachDiagnostics(
        await this.buildUnifiedKnowledgeResult(
          query,
          knowledgeStore,
          managedKnowledgeHits,
          decision,
        ),
        query,
        context,
        decision,
        semanticExpansion,
      );
    }

    if (this.shouldAutoRecall(decision, context)) {
      if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
        return this.attachDiagnostics(
          this.buildRecallDisabledResponse(query, durableHits, context, decision),
          query,
          context,
          decision,
          semanticExpansion,
        );
      }

      const recallBudget = this.resolveRecallBudget(args, context.totalBudget);
      const result = this.recallResolver.resolve(query, summaryStore, rawStore, recallBudget);
      return this.attachDiagnostics({
        content: [{ type: "text", text: this.formatRecallText(query, result.items, result.sourceTrace) }],
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
          layerScores: decision.layerScores ?? [],
          explanation: decision.explanation,
          dagTrace: result.dagTrace,
          sourceTrace: result.sourceTrace,
        },
      }, query, context, decision, semanticExpansion);
    }

    if (decision.route === "navigation") {
      const hit = await this.navigationRepository.getNavigationStateHit(
        context.config.workspaceDir,
        query,
      );
      return this.attachDiagnostics(
        this.buildRouteHitResult(hit, decision, query),
        query,
        context,
        decision,
        semanticExpansion,
      );
    }

    if (decision.route === "shared_insights") {
      const hit = await this.fixedPrefixProvider.getSharedInsightHit(
        context.config.sharedDataDir,
        query,
      );
      return this.attachDiagnostics(
        this.buildRouteHitResult(hit, decision, query),
        query,
        context,
        decision,
        semanticExpansion,
      );
    }

    if (decision.route === "knowledge") {
      const hit = await this.fixedPrefixProvider.getKnowledgeBaseHit(
        context.config.sharedDataDir,
        query,
      );
      if (hit) {
        return this.attachDiagnostics(
          this.buildRouteHitResult(hit, decision, query),
          query,
          context,
          decision,
          semanticExpansion,
        );
      }
    }

    const semanticAuthority = await this.buildSemanticAuthorityResult(
      query,
      args,
      context,
      decision,
      semanticExpansion,
      rawStore,
      summaryStore,
      knowledgeStore,
    );
    if (semanticAuthority) {
      return this.attachDiagnostics(
        semanticAuthority,
        query,
        context,
        decision,
        semanticExpansion,
      );
    }

    if (decision.route === "vector_search" && semanticExpansion.vectorHint) {
      return this.attachDiagnostics({
        content: [{
          type: "text",
          text: [
            "Semantic vector hint only. Treat as a candidate, not as source-verified fact.",
            "",
            semanticExpansion.vectorHint.text,
          ].join("\n"),
        }],
        details: {
          ok: true,
          route: decision.route,
          retrievalLabel: this.describeRetrievalRoute(decision),
          query,
          retrievalHitType: "vector_retrieval",
          autoRecall: false,
          autoRecallReason: null,
          routePlan: decision.routePlan,
          layerScores: decision.layerScores ?? [],
          explanation: decision.explanation,
          source: semanticExpansion.vectorHint.source,
          score: semanticExpansion.vectorHint.score ?? null,
          vectorActsAsAuthority: false,
          fallbackTrace: [{
            from: decision.route,
            to: "none",
            reason: "vector_hint_available_but_no_authoritative_follow_up_hit",
          }],
        },
      }, query, context, decision, semanticExpansion);
    }

    if (durableHits.length > 0) {
      return this.attachDiagnostics({
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
          layerScores: decision.layerScores ?? [],
          explanation: decision.explanation,
          fallbackTrace: [{
            from: decision.route,
            to: "durable_memory",
            reason: "primary_route_empty_but_durable_hits_available",
          }],
        },
      }, query, context, decision, semanticExpansion);
    }

    const recallBudget = this.resolveRecallBudget(args, context.totalBudget);
    const result = this.recallResolver.resolve(query, summaryStore, rawStore, recallBudget);
    return this.attachDiagnostics({
      content: [{ type: "text", text: this.formatRecallText(query, result.items, result.sourceTrace) }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        consumedTokens: result.consumedTokens,
        hitCount: result.items.length,
        retrievalHitType: this.getRetrievalHitType(decision),
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        fallbackTrace: [{
          from: decision.route,
          to: "summary_tree",
          reason: "primary_route_empty_or_no_direct_hit",
        }],
        dagTrace: result.dagTrace,
        sourceTrace: result.sourceTrace,
      },
    }, query, context, decision, semanticExpansion);
  }

  private attachDiagnostics(
    response: ToolResponse,
    query: string,
    context: LifecycleContext,
    decision: RetrievalDecision,
    semanticExpansion: SemanticExpansionResult,
    promptForApi = false,
  ): ToolResponse {
    const configGuidance = this.payloadAdapter.describeConfigGuidance(context.config);
    return {
      ...response,
      details: {
        ...this.buildDiagnosticsEnvelope(
          query,
          context,
          decision,
          promptForApi,
          semanticExpansion,
          configGuidance.warnings,
        ),
        ...response.details,
      },
    };
  }

  private buildDiagnosticsEnvelope(
    query: string,
    context: LifecycleContext,
    decision: RetrievalDecision,
    promptForApi: boolean,
    semanticExpansion: SemanticExpansionResult,
    configWarnings: string[],
  ): Record<string, unknown> {
    const embeddingsReady = this.payloadAdapter.hasEmbeddingsRetrievalReady();
    return {
      ok: true,
      query,
      route: decision.route,
      retrievalLabel: this.describeRetrievalRoute(decision),
      reason: decision.reason,
      requiresEmbeddings: decision.requiresEmbeddings,
      requiresSourceRecall: decision.requiresSourceRecall,
      canAnswerDirectly: decision.canAnswerDirectly,
      routePlan: decision.routePlan,
      layerScores: decision.layerScores ?? [],
      explanation: decision.explanation,
      retrievalHitType: this.getRetrievalHitType(decision),
      matchedProjectId: decision.matchedProjectId ?? null,
      matchedProjectTitle: decision.matchedProjectTitle ?? null,
      shouldAutoRecall: this.shouldAutoRecall(decision, context),
      autoRecallReason: this.explainAutoRecall(decision, context),
      promptForApi,
      apiPrompt: promptForApi ? EMBEDDINGS_API_PROMPT : null,
      autoRecallEnabled: context.config.autoRecallEnabled,
      emergencyBrake: context.config.emergencyBrake,
      configPreset: context.config.configPreset,
      configWarnings,
      semanticCandidateExpansionEnabled: context.config.semanticCandidateExpansionEnabled,
      semanticCandidateLimit: context.config.semanticCandidateLimit,
      embeddingsReady,
      candidateExpansionMode:
        context.config.semanticCandidateExpansionEnabled
          ? (embeddingsReady ? "hybrid" : "heuristic_only")
          : "disabled",
      semanticCandidates: semanticExpansion.candidates.map((candidate) => ({
        kind: candidate.kind,
        id: candidate.id,
        title: candidate.title,
        score: candidate.score,
        reasons: candidate.reasons,
        authority: candidate.authority,
        sourceRoute: candidate.sourceRoute,
        requiresSourceRecall: candidate.requiresSourceRecall ?? false,
        matchedProjectId: candidate.matchedProjectId ?? null,
        matchedProjectTitle: candidate.matchedProjectTitle ?? null,
      })),
      semanticAuthorityAvailable: semanticExpansion.candidates.some(
        (candidate) => candidate.authority === "authoritative",
      ),
      semanticHintAvailable: Boolean(semanticExpansion.vectorHint),
    };
  }

  private async collectSemanticExpansion(args: {
    query: string;
    context: LifecycleContext;
    decision: RetrievalDecision;
    durableEntries: DurableMemoryEntry[];
    knowledgeHits: KnowledgeDocumentIndexEntry[];
    summaryHits: SummaryEntry[];
    projects: ProjectRecord[];
    matchedProject: ProjectRecord | null;
  }): Promise<SemanticExpansionResult> {
    const expansionEnabled = args.context.config.semanticCandidateExpansionEnabled;
    if (!expansionEnabled && args.decision.route !== "vector_search") {
      return {
        candidates: [],
        knowledgeHits: [],
        durableHits: [],
        summaryHits: [],
        projectHit: args.matchedProject,
        vectorHint: null,
      };
    }
    const terms = this.semanticTerms(args.query);
    const candidates: SemanticCandidate[] = [];
    const knowledgeHits = [...args.knowledgeHits]
      .map((entry) => ({
        entry,
        score: this.scoreKnowledgeEntry(entry, terms, args.query),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title))
      .slice(0, Math.max(args.context.config.semanticCandidateLimit, 1));
    for (const item of knowledgeHits) {
      candidates.push({
        kind: "knowledge",
        id: item.entry.docId,
        title: item.entry.title,
        score: item.score,
        reasons: [
          `knowledge:${item.entry.bucket}`,
          `origin:${item.entry.origin}`,
          `status:${item.entry.status}`,
        ],
        authority: item.entry.status === "superseded" ? "hint" : "authoritative",
        sourceRoute: "semantic_candidate_expansion",
      });
    }

    const durableHits = [...args.durableEntries]
      .filter((entry) => entry.recordStatus !== "superseded" && entry.recordStatus !== "archived")
      .map((entry) => ({
        entry,
        score: this.scoreSemanticHaystack(
          [entry.kind, entry.projectId ?? "", entry.topicId ?? "", ...entry.tags, entry.text].join(" "),
          terms,
          args.query,
        ) + (args.matchedProject?.id && entry.projectId === args.matchedProject.id ? 4 : 0),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.createdAt.localeCompare(left.entry.createdAt))
      .slice(0, Math.max(args.context.config.semanticCandidateLimit, 1));
    for (const item of durableHits) {
      const matchedProjectTitle = args.matchedProject && args.matchedProject.id === item.entry.projectId
        ? args.matchedProject.title
        : undefined;
      candidates.push({
        kind: "durable_memory",
        id: item.entry.id,
        title: `[${item.entry.kind}] ${item.entry.text.slice(0, 72)}`,
        score: item.score,
        reasons: [
          `durable:${item.entry.kind}`,
          ...(args.matchedProject?.id && item.entry.projectId === args.matchedProject.id
            ? ["matched_project"]
            : []),
        ],
        authority: "authoritative",
        sourceRoute: "semantic_candidate_expansion",
        matchedProjectId: item.entry.projectId,
        matchedProjectTitle,
      });
    }

    const summaryHits = [...args.summaryHits]
      .map((entry) => ({
        entry,
        score: this.scoreSummaryEntry(entry, terms, args.query),
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

    const projectHit = args.matchedProject ?? this.matchProject(args.query, args.projects);
    if (projectHit) {
      const projectScore = this.scoreSemanticHaystack(
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

    const vectorHint = (expansionEnabled || args.decision.route === "vector_search")
      ? await this.tryVectorRetrieve(args.query, args.context.config)
      : null;
    if (vectorHint) {
      candidates.push({
        kind: "vector_hint",
        id: vectorHint.source ?? "vector-hint",
        title: "Vector semantic hint",
        score: Number(vectorHint.score ?? 0),
        reasons: ["vector_candidate_hint"],
        authority: "hint",
        sourceRoute: "vector_search",
      });
    }

    return {
      candidates: [...candidates]
        .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
        .slice(0, Math.max(args.context.config.semanticCandidateLimit, 1)),
      knowledgeHits: knowledgeHits.map((item) => item.entry),
      durableHits: durableHits.map((item) => item.entry),
      summaryHits: summaryHits.map((item) => item.entry),
      projectHit,
      vectorHint,
    };
  }

  private async buildSemanticAuthorityResult(
    query: string,
    args: unknown,
    context: LifecycleContext,
    decision: RetrievalDecision,
    semanticExpansion: SemanticExpansionResult,
    rawStore: Parameters<RecallResolver["resolve"]>[2],
    summaryStore: Parameters<RecallResolver["resolve"]>[1],
    knowledgeStore: KnowledgeRepository,
  ): Promise<ToolResponse | null> {
    const candidate = semanticExpansion.candidates.find(
      (item) => item.authority === "authoritative",
    );
    if (!candidate) {
      return null;
    }

    switch (candidate.kind) {
      case "knowledge":
        if (semanticExpansion.knowledgeHits.length === 0) {
          return null;
        }
        {
          const result = await this.buildUnifiedKnowledgeResult(
          query,
          knowledgeStore,
          semanticExpansion.knowledgeHits,
          decision,
        );
          return {
            ...result,
            details: {
              ...result.details,
              fallbackTrace: [{
                from: decision.route,
                to: "knowledge",
                reason: "semantic_candidate_authority_hit",
              }],
            },
          };
        }
      case "durable_memory":
        if (semanticExpansion.durableHits.length === 0) {
          return null;
        }
        return {
          content: [{ type: "text", text: this.formatDurableMemoryText(query, semanticExpansion.durableHits) }],
          details: {
            ok: true,
            route: decision.route,
            retrievalLabel: this.describeRetrievalRoute(decision),
            query,
            hitCount: semanticExpansion.durableHits.length,
            retrievalHitType: "durable_memory",
            fallbackTrace: [{
              from: decision.route,
              to: "durable_memory",
              reason: "semantic_candidate_authority_hit",
            }],
          },
        };
      case "project_registry":
        {
          const result = this.buildProjectRegistryResult(
            semanticExpansion.projectHit,
            decision,
            query,
          );
          return {
            ...result,
            details: {
              ...result.details,
              fallbackTrace: [{
                from: decision.route,
                to: "project_registry",
                reason: "semantic_candidate_authority_hit",
              }],
            },
          };
        }
      case "summary":
        if (!context.config.autoRecallEnabled || context.config.emergencyBrake) {
          return null;
        }
        {
          const recallBudget = this.resolveRecallBudget(args, context.totalBudget);
          const result = this.recallResolver.resolve(query, summaryStore, rawStore, recallBudget);
          return {
            content: [{ type: "text", text: this.formatRecallText(query, result.items, result.sourceTrace) }],
            details: {
              ok: true,
              route: decision.route,
              retrievalLabel: this.describeRetrievalRoute(decision),
              query,
              consumedTokens: result.consumedTokens,
              hitCount: result.items.length,
              retrievalHitType: "summary_tree_recall",
              fallbackTrace: [{
                from: decision.route,
                to: "summary_tree",
                reason: "semantic_candidate_authority_hit",
              }],
              dagTrace: result.dagTrace,
              sourceTrace: result.sourceTrace,
            },
          };
        }
      default:
        return null;
    }
  }

  private resolveContext(args: unknown): LifecycleContext {
    return this.payloadAdapter.resolveLifecycleContext(args, this.runtime.getConfig());
  }

  private getQuery(args: unknown): string {
    return this.isRecord(args) && typeof args.query === "string"
      ? args.query.trim()
      : "";
  }

  private resolveRecallBudget(args: unknown, totalBudget: number): number {
    const budget = this.isRecord(args) ? args.budget : undefined;
    return Math.max(
      256,
      Math.floor(
        typeof budget === "number" && Number.isFinite(budget)
          ? budget
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
    const [hasKnowledgeRawHint, hasSharedInsightHint, hasNavigationHint, hasStructuredNavigationState] =
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
      hasKnowledgeRawHint,
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

  private formatRecallText(query: string, items: ContextItem[], sourceTrace: Array<{ summaryId?: string; strategy: string; verified: boolean; resolvedMessageCount: number }> = []): string {
    if (items.length === 0) {
      return `No matching historical details found for query: ${query}`;
    }
    const messages = items
      .map(
        (item) =>
          `[turn ${(item.turnNumber as number | undefined) ?? "?"}] ${(item.role as string | undefined) ?? "user"}: ${String(item.content ?? "")}`,
      )
      .join("\n\n");
    const traces = sourceTrace.length > 0
      ? [
          "",
          "Source trace:",
          ...sourceTrace.map((trace) =>
            `- summary ${trace.summaryId ?? "?"} -> ${trace.strategy} -> ${trace.verified ? "verified" : "unverified"} (${trace.resolvedMessageCount} messages)`,
          ),
        ].join("\n")
      : "";
    return [
      `Historical source hits for: ${query}`,
      "",
      messages,
      traces,
    ].filter(Boolean).join("\n");
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
          typeof entry.metadata?.factKey === "string" ? entry.metadata.factKey : "",
          typeof entry.metadata?.factValue === "string" ? entry.metadata.factValue : "",
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
        if (entry.metadata?.factRecencyHint === true) {
          score += 3;
        }
        if (/(current|latest|now|currently|现在|当前|最新)/i.test(query) && entry.metadata?.factKey) {
          score += 4;
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

    const scoped = projectId
      ? scored.filter((item) => item.entry.projectId === projectId)
      : [];
    const source = scoped.length > 0 ? scoped : scored;
    return source.slice(0, Math.max(limit, 1)).map((item) => item.entry);
  }

  private queryTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
  }

  private semanticTerms(query: string): string[] {
    const baseTerms = this.queryTerms(query);
    const synonyms = new Map<string, string[]>([
      ["retry", ["backoff", "retries", "retrying"]],
      ["backoff", ["retry", "retries"]],
      ["constraint", ["must", "requirement", "limit", "rule"]],
      ["config", ["setting", "parameter", "configuration"]],
      ["decision", ["decide", "chose", "choice"]],
      ["state", ["status", "progress", "current"]],
      ["next", ["step", "action", "todo"]],
      ["knowledge", ["docs", "documentation", "reference", "manual"]],
      ["summary", ["history", "earlier", "recall"]],
      ["原文", ["细节", "参数", "准确"]],
      ["状态", ["进度", "当前", "项目"]],
      ["下一步", ["下一项", "后续", "todo"]],
      ["知识库", ["文档", "资料", "参考"]],
    ]);
    const expanded = [...baseTerms];
    for (const term of baseTerms) {
      expanded.push(...(synonyms.get(term) ?? []));
    }
    return [...new Set(expanded)];
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

  private scoreKnowledgeEntry(
    entry: KnowledgeDocumentIndexEntry,
    terms: string[],
    query: string,
  ): number {
    let score = this.scoreManagedKnowledge(entry, terms);
    if (entry.status === "active") {
      score += 4;
    } else if (entry.status === "draft") {
      score += 1;
    } else {
      score -= 1;
    }
    if (entry.origin === "synthesized" || entry.origin === "native") {
      score += 2;
    }
    if (entry.sourceRefs.length > 0) {
      score += Math.min(entry.sourceRefs.length, 3);
    }
    score += this.scoreSemanticHaystack(
      [entry.title, entry.summary, entry.canonicalKey, ...entry.tags].join(" "),
      terms,
      query,
    );
    return score;
  }

  private scoreSummaryEntry(
    entry: SummaryEntry,
    terms: string[],
    query: string,
  ): number {
    return this.scoreSemanticHaystack(
      [
        entry.summary,
        ...entry.keywords,
        ...(entry.constraints ?? []),
        ...(entry.decisions ?? []),
        ...(entry.blockers ?? []),
        ...(entry.nextSteps ?? []),
        ...(entry.keyEntities ?? []),
        ...(entry.exactFacts ?? []),
      ].join(" "),
      terms,
      query,
    ) + (entry.summaryLevel === 1 ? 2 : 0);
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

  private scoreSemanticHaystack(
    haystack: string,
    terms: string[],
    query: string,
  ): number {
    const normalizedHaystack = haystack.toLowerCase();
    let score = this.scoreHaystack(normalizedHaystack, terms);
    const similarity = this.computeTrigramSimilarity(query.toLowerCase(), normalizedHaystack);
    if (similarity >= 0.12) {
      score += Math.round(similarity * 20);
    }
    return score;
  }

  private computeTrigramSimilarity(left: string, right: string): number {
    const leftSet = this.buildTrigramSet(left);
    const rightSet = this.buildTrigramSet(right);
    if (leftSet.size === 0 || rightSet.size === 0) {
      return 0;
    }
    let intersection = 0;
    for (const item of leftSet) {
      if (rightSet.has(item)) {
        intersection += 1;
      }
    }
    return intersection / Math.max(leftSet.size, rightSet.size);
  }

  private buildTrigramSet(value: string): Set<string> {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length < 3) {
      return new Set(normalized ? [normalized] : []);
    }
    const grams = new Set<string>();
    for (let index = 0; index <= normalized.length - 3; index += 1) {
      grams.add(normalized.slice(index, index + 3));
    }
    return grams;
  }

  private async buildUnifiedKnowledgeResult(
    query: string,
    knowledgeStore: KnowledgeRepository,
    managedHits: Array<ReturnType<KnowledgeRepository["searchRelatedDocuments"]>[number]>,
    decision: RetrievalDecision,
  ): Promise<ToolResponse> {
    const terms = this.semanticTerms(query);
    const managedDocuments = (
      await Promise.all(managedHits.map((hit) => knowledgeStore.getById(hit.docId)))
    ).filter((document): document is NonNullable<typeof document> => Boolean(document));
    const unifiedHits = managedDocuments
      .map((document) => ({
        recordType: "knowledge_record" as const,
        score: this.scoreKnowledgeEntry(document.entry, terms, query),
        title: document.entry.title,
        body: document.content.trim(),
        metadata: [
          `type: knowledge_record`,
          `origin: ${document.entry.origin}`,
          `bucket: ${document.entry.bucket}`,
          `canonicalKey: ${document.entry.canonicalKey}`,
          `status: ${document.entry.status}`,
          `versions: ${document.entry.versions.length}`,
          `provenance refs: ${document.entry.sourceRefs.length}`,
          `linked summaries: ${document.entry.linkedSummaryIds.join(", ") || "none"}`,
          `source refs: ${document.entry.sourceRefs.join(", ") || "none"}`,
        ],
      }))
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, 6);

    const text = unifiedHits.length > 0
      ? unifiedHits
        .map((hit, index) => [
          `${index + 1}. ${hit.title}`,
          ...hit.metadata.map((line) => `   ${line}`),
          "",
          hit.body,
        ].join("\n"))
        .join("\n\n---\n\n")
      : `No knowledge documents matched query: ${query}`;

    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        hitCount: unifiedHits.length,
        knowledgeHitCount: managedDocuments.length,
        topRecordType: unifiedHits[0]?.recordType ?? null,
        retrievalHitType: "knowledge",
        autoRecall: false,
        autoRecallReason: null,
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
      },
    };
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
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        fallbackTrace: [{
          from: decision.route,
          to: "none",
          reason: "embeddings_configuration_required",
        }],
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
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        fallbackTrace: [{
          from: decision.route,
          to: durableHits.length > 0 ? "durable_memory" : "none",
          reason: context.config.emergencyBrake ? "emergency_brake_enabled" : "auto_recall_disabled",
        }],
      },
    };
  }

  private async tryVectorRetrieve(
    query: string,
    config: LifecycleContext["config"],
  ): Promise<{ text: string; source?: string; score?: number } | null> {
    const api = this.getApi();

    const runtimeCandidate =
      (await this.callVectorSearchCandidate(api?.memorySearch, "search", query)) ??
      (await this.callVectorSearchCandidate(api?.memorySearch, "query", query)) ??
      (await this.callVectorSearchCandidate(api?.context?.memorySearch, "search", query)) ??
      (await this.callVectorSearchCandidate(api?.context?.memorySearch, "query", query)) ??
      (await this.callVectorSearchCandidate(api?.runtime?.memorySearch, "search", query)) ??
      (await this.callVectorSearchCandidate(api?.runtime?.memorySearch, "query", query));
    if (runtimeCandidate) {
      return runtimeCandidate;
    }

    return await this.vectorSearchFallback.search(query, config);
  }

  private async callVectorSearchCandidate(
    target: HostFunctionContainer | undefined,
    method: "search" | "query",
    query: string,
  ): Promise<{ text: string; source?: string; score?: number } | null> {
    if (!target) {
      return null;
    }
    const fn = target?.[method];
    if (typeof fn !== "function") {
      return null;
    }
    const invoke = fn as (...args: unknown[]) => unknown;

    const byObject = await this.tryVectorSearchCall(
      invoke,
      target,
      { query, topK: 3, k: 3 },
      method,
    );
    if (byObject) {
      return byObject;
    }

    return await this.tryVectorSearchCall(invoke, target, query, method);
  }

  private async tryVectorSearchCall(
    fn: (...args: unknown[]) => unknown,
    target: HostFunctionContainer,
    input: unknown,
    method: "search" | "query",
  ): Promise<{ text: string; source?: string; score?: number } | null> {
    try {
      const value = await Promise.resolve(fn.call(target, input));
      return this.parseVectorSearchResult(value, method);
    } catch {
      // Host-provided vector APIs vary by shape; failures intentionally fall through
      // to the next candidate form before using the local fallback store.
      return null;
    }
  }

  private parseVectorSearchResult(
    value: unknown,
    method: "search" | "query",
  ): { text: string; source?: string; score?: number } | null {
    if (!value) {
      return null;
    }

    const container = this.isRecord(value) ? value : {};
    const list = Array.isArray(value)
      ? value
      : Array.isArray(container.hits)
        ? container.hits
        : Array.isArray(container.items)
          ? container.items
          : Array.isArray(container.results)
            ? container.results
            : [];
    const first = list[0] ?? container.hit ?? container.result;
    if (!first) {
      return null;
    }
    if (typeof first === "string") {
      return { text: first, source: method };
    }
    if (!this.isRecord(first)) {
      return null;
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
    const source = first.source ?? first.filePath ?? first.path ?? method;
    return {
      text: text.trim(),
      source: typeof source === "string" && source.trim() ? source : method,
      score: typeof first.score === "number" ? first.score : undefined,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
        return "unified knowledge";
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
        layerScores: decision.layerScores ?? [],
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
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        matchedProjectId: decision.matchedProjectId ?? null,
        matchedProjectTitle: decision.matchedProjectTitle ?? null,
        fallbackTrace: hit ? [] : [{
          from: decision.route,
          to: "none",
          reason: "route_hit_not_found",
        }],
      },
    };
  }
}


