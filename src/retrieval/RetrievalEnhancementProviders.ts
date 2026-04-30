import { BridgeConfig } from "../types";

export interface RetrievalEnhancementLaneStatus {
  enabled: boolean;
  provider: string;
  authority: "candidate_only" | "ordering_only" | "answer_resolution";
  active: boolean;
  fallback?: string;
  notes?: string[];
}

export interface RetrievalEnhancementStatus {
  policy: {
    heavyRetrievalPolicy: BridgeConfig["heavyRetrievalPolicy"];
    ragPlannerPolicy: BridgeConfig["ragPlannerPolicy"];
    graphPlannerPolicy: BridgeConfig["graphPlannerPolicy"];
    rerankPlannerPolicy: BridgeConfig["rerankPlannerPolicy"];
    candidateRerankThreshold: number;
    laneCandidateRerankThreshold: number;
    candidateAmbiguityMargin: number;
    strictModeRequiresRerankOnConflict: boolean;
  };
  graph: RetrievalEnhancementLaneStatus;
  rag: RetrievalEnhancementLaneStatus & {
    embeddingEnabled: boolean;
    embeddingProvider: string;
    embeddingModel: string;
    embeddingDimensions: number;
    vectorExtensionConfigured: boolean;
    vectorSearchMaxCandidates: number;
    bruteForceVectorMaxRows: number;
  };
  rerank: RetrievalEnhancementLaneStatus & {
    maxCandidates: number;
    rerankModel?: string;
    timeoutMs: number;
  };
  graphBuilder: {
    enabled: boolean;
    provider: string;
    active: boolean;
    maxDepth: number;
    maxFanout: number;
    minConfidence: number;
    candidateLimit: number;
    allowedRelations: string[];
  };
  evidenceAnswerResolver: RetrievalEnhancementLaneStatus & {
    model?: string;
    timeoutMs: number;
  };
  featureIsolationMode: BridgeConfig["featureIsolationMode"];
  maxEnhancementLatencyMs: number;
  defaultLatencyImpact: "none_when_disabled";
}

export interface RetrievalEnhancementCandidate {
  id: string;
  kind: "memory_item" | "summary" | "evidence_atom" | "raw_message";
  score: number;
  reason: string;
  sourceVerified?: boolean;
  content?: string;
  title?: string;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}

export interface RagProvider {
  readonly providerId: string;
  retrieveCandidates(args: {
    query: string;
    limit: number;
    timeoutMs: number;
  }): Promise<RetrievalEnhancementCandidate[]>;
}

export interface GraphProvider {
  readonly providerId: string;
  expandNeighbors(args: {
    seedIds: string[];
    relationHints: string[];
    limit: number;
    timeoutMs: number;
  }): Promise<RetrievalEnhancementCandidate[]>;
}

export interface RerankProvider {
  readonly providerId: string;
  rerank<T>(args: {
    query: string;
    candidates: Array<RerankableCandidate<T>>;
    maxCandidates: number;
    timeoutMs: number;
  }): Promise<Array<RerankableCandidate<T>>>;
}

export interface RerankableCandidate<T = unknown> {
  id: string;
  lane: string;
  score: number;
  sourceVerified?: boolean;
  authority?: string;
  tokenCount?: number;
  payload: T;
}

export interface RerankAudit {
  required: boolean;
  used: boolean;
  provider: "none" | "deterministic_fallback" | "deterministic" | "llm" | "specialist" | "model" | "external";
  providerAvailable: boolean;
  providerUnavailableReason?: string;
  candidateCount: number;
  threshold: number;
  laneThreshold: number;
  laneCounts: Record<string, number>;
  ambiguityMargin: number;
  topScoreMargin: number | null;
  reasons: string[];
  orderedCandidateIds: string[];
}

export interface DeterministicRerankResult<T = unknown> {
  candidates: Array<RerankableCandidate<T>>;
  audit: RerankAudit;
}

export class RetrievalEnhancementRegistry {
  static status(config: BridgeConfig): RetrievalEnhancementStatus {
    return {
      policy: {
        heavyRetrievalPolicy: config.heavyRetrievalPolicy,
        ragPlannerPolicy: config.ragPlannerPolicy,
        graphPlannerPolicy: config.graphPlannerPolicy,
        rerankPlannerPolicy: config.rerankPlannerPolicy,
        candidateRerankThreshold: config.candidateRerankThreshold,
        laneCandidateRerankThreshold: config.laneCandidateRerankThreshold,
        candidateAmbiguityMargin: config.candidateAmbiguityMargin,
        strictModeRequiresRerankOnConflict: config.strictModeRequiresRerankOnConflict,
      },
      graph: {
        enabled: config.graphEnabled,
        provider: config.graphProvider,
        authority: "candidate_only",
        active: config.graphEnabled && (config.graphProvider === "sqlite_graph" || config.graphProvider === "sqlite_edges"),
        notes: config.graphProvider === "sqlite_edges"
          ? ["sqlite_edges is accepted as a compatibility alias; sqlite_graph is the final associative graph provider."]
          : [],
      },
      rag: {
        enabled: config.ragEnabled,
        provider: config.ragProvider,
        authority: "candidate_only",
        active: config.ragEnabled && config.ragProvider !== "none" && config.embeddingEnabled && config.embeddingProvider !== "none",
        fallback: config.ragFallbackToBruteForce ? "brute_force_explicit" : undefined,
        embeddingEnabled: config.embeddingEnabled,
        embeddingProvider: config.embeddingProvider,
        embeddingModel: config.embeddingModel,
        embeddingDimensions: config.embeddingDimensions,
        vectorExtensionConfigured: typeof config.vectorExtensionPath === "string" && config.vectorExtensionPath.trim().length > 0,
        vectorSearchMaxCandidates: config.vectorSearchMaxCandidates,
        bruteForceVectorMaxRows: config.bruteForceVectorMaxRows,
      },
      rerank: {
        enabled: config.rerankEnabled,
        provider: config.rerankProvider,
        authority: "ordering_only",
        active: config.rerankEnabled && config.rerankProvider === "deterministic",
        fallback: config.rerankFallbackToDeterministic ? "deterministic_explicit" : undefined,
        maxCandidates: config.maxRerankCandidates,
        rerankModel: config.rerankModel,
        timeoutMs: config.rerankTimeoutMs,
      },
      graphBuilder: {
        enabled: config.graphBuilderEnabled,
        provider: config.graphBuilderProvider,
        active: config.graphBuilderEnabled && config.graphBuilderProvider === "deterministic",
        maxDepth: config.graphMaxDepth,
        maxFanout: config.graphMaxFanout,
        minConfidence: config.graphMinConfidence,
        candidateLimit: config.graphCandidateLimit,
        allowedRelations: config.graphAllowedRelations,
      },
      evidenceAnswerResolver: {
        enabled: config.evidenceAnswerResolverEnabled,
        provider: config.evidenceAnswerResolverProvider,
        authority: "answer_resolution",
        active: config.evidenceAnswerResolverEnabled && (config.evidenceAnswerResolverProvider === "deterministic" || Boolean(config.evidenceAnswerResolverModel?.trim())),
        fallback: config.evidenceAnswerResolverFallbackToDeterministic ? "deterministic_explicit" : undefined,
        model: config.evidenceAnswerResolverModel,
        timeoutMs: config.evidenceAnswerResolverTimeoutMs,
      },
      featureIsolationMode: config.featureIsolationMode,
      maxEnhancementLatencyMs: config.maxEnhancementLatencyMs,
      defaultLatencyImpact: "none_when_disabled",
    };
  }
}

export class DeterministicReranker {
  rerank<T>(
    candidates: Array<RerankableCandidate<T>>,
    config: BridgeConfig,
    options: {
      strictConflict?: boolean;
      force?: boolean;
    } = {},
  ): DeterministicRerankResult<T> {
    const threshold = Math.max(1, config.candidateRerankThreshold);
    const laneThreshold = Math.max(1, config.laneCandidateRerankThreshold);
    const ambiguityMargin = Math.max(0, Math.min(config.candidateAmbiguityMargin, 0.999));
    const laneCounts = this.countLanes(candidates);
    const topScoreMargin = this.topScoreMargin(candidates);
    const reasons = [
      ...(options.force ? ["forced_by_planner_route"] : []),
      ...(candidates.length >= threshold ? ["total_candidate_threshold_exceeded"] : []),
      ...(Object.values(laneCounts).some((count) => count >= laneThreshold) ? ["lane_candidate_threshold_exceeded"] : []),
      ...(topScoreMargin !== null && topScoreMargin <= ambiguityMargin ? ["top_candidate_score_ambiguous"] : []),
      ...(options.strictConflict && config.strictModeRequiresRerankOnConflict ? ["high_or_xhigh_conflict"] : []),
    ];
    const required = config.rerankPlannerPolicy !== "disabled" &&
      (options.force === true || reasons.length > 0);
    const modelLikeProvider = ["llm", "specialist", "model", "external"].includes(config.rerankProvider);
    const deterministicConfigured = config.rerankEnabled && config.rerankProvider === "deterministic";
    const providerAvailable = deterministicConfigured;
    const providerUnavailableReason = required && !providerAvailable
      ? config.rerankProvider === "none" || !config.rerankEnabled
        ? "rerank_provider_not_configured"
        : modelLikeProvider
          ? "rerank_model_provider_not_runtime_configured"
          : "rerank_provider_unavailable"
      : undefined;
    const deterministicCanRun = required && deterministicConfigured;
    const sorted = deterministicCanRun ? [...candidates].sort((left, right) => this.compare(left, right)) : [...candidates];
    return {
      candidates: sorted,
      audit: {
        required,
        used: deterministicCanRun,
        provider: deterministicCanRun ? "deterministic" : "none",
        providerAvailable,
        providerUnavailableReason,
        candidateCount: candidates.length,
        threshold,
        laneThreshold,
        laneCounts,
        ambiguityMargin,
        topScoreMargin,
        reasons,
        orderedCandidateIds: sorted.map((candidate) => candidate.id),
      },
    };
  }

  private countLanes(candidates: Array<RerankableCandidate<unknown>>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const candidate of candidates) {
      counts[candidate.lane] = (counts[candidate.lane] ?? 0) + 1;
    }
    return counts;
  }

  private topScoreMargin(candidates: Array<RerankableCandidate<unknown>>): number | null {
    if (candidates.length < 2) {
      return null;
    }
    const [first, second] = [...candidates].sort((left, right) => right.score - left.score);
    const basis = Math.max(Math.abs(first.score), 1);
    return Math.max(0, (first.score - second.score) / basis);
  }

  private compare(left: RerankableCandidate<unknown>, right: RerankableCandidate<unknown>): number {
    return Number(Boolean(right.sourceVerified)) - Number(Boolean(left.sourceVerified)) ||
      this.authorityScore(right.authority) - this.authorityScore(left.authority) ||
      right.score - left.score ||
      Math.max(left.tokenCount ?? 0, 0) - Math.max(right.tokenCount ?? 0, 0) ||
      left.id.localeCompare(right.id);
  }

  private authorityScore(authority?: string): number {
    switch (authority) {
      case "active_memory":
        return 5;
      case "reviewed_asset":
        return 4;
      case "source_backed_summary":
        return 3;
      case "raw_evidence":
        return 2;
      case "current_context":
        return 1;
      default:
        return 0;
    }
  }
}
