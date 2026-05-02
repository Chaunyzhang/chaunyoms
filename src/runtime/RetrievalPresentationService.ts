import { scoreIntentRoleMatch } from "../resolvers/RecallIntentRoles";
import type { LifecycleContext } from "../host/OpenClawPayloadAdapter";
import type {
  AnswerCandidate,
  ContextItem,
  DagTraversalStep,
  MemoryItemEntry,
  RecallResult,
  RetrievalDecision,
  RetrievalStrength,
  SourceTrace,
} from "../types";
import type { RetrievalVerificationResult } from "../retrieval/RetrievalVerifier";
import type {
  EvidenceGateResult,
  RecallPresentationOptions,
  RecallTextArgs,
  RecallTextDiagnostics,
  RetrievalVerifierBlockedResponseArgs,
  SemanticExpansionResult,
  ToolResponse,
} from "./RetrievalServiceContracts";

export interface RetrievalPresentationServiceDeps {
  buildRetrievalEnhancementDiagnostics: (config: LifecycleContext["config"]) => Record<string, unknown>;
  compactDagTrace: (dagTrace: DagTraversalStep[]) => Array<Record<string, unknown>>;
  compactSourceTrace: (sourceTrace: SourceTrace[]) => Array<Record<string, unknown>>;
  describeConfigGuidanceWarnings: (config: LifecycleContext["config"]) => string[];
  describeRetrievalRoute: (decision: RetrievalDecision) => string;
  explainAutoRecall: (decision: RetrievalDecision, context: LifecycleContext) => string | null;
  getRetrievalHitType: (decision: RetrievalDecision) => string;
  isSourceTraceRequired: (decision: RetrievalDecision, context: LifecycleContext) => boolean;
  queryTerms: (query: string) => string[];
  shouldAutoRecall: (decision: RetrievalDecision, context: LifecycleContext) => boolean;
}

export class RetrievalPresentationService {
  constructor(private readonly deps: RetrievalPresentationServiceDeps) {}

  attachDiagnostics(
    response: ToolResponse,
    query: string,
    context: LifecycleContext,
    decision: RetrievalDecision,
    semanticExpansion: SemanticExpansionResult,
    promptForApi = false,
  ): ToolResponse {
    const configWarnings = this.deps.describeConfigGuidanceWarnings(context.config);
    return {
      ...response,
      details: {
        ...this.buildDiagnosticsEnvelope(
          query,
          context,
          decision,
          promptForApi,
          semanticExpansion,
          configWarnings,
        ),
        ...response.details,
      },
    };
  }

  buildDiagnosticsEnvelope(
    query: string,
    context: LifecycleContext,
    decision: RetrievalDecision,
    promptForApi: boolean,
    semanticExpansion: SemanticExpansionResult,
    configWarnings: string[],
  ): Record<string, unknown> {
    return {
      ok: true,
      query,
      route: decision.route,
      retrievalLabel: this.deps.describeRetrievalRoute(decision),
      reason: decision.reason,
      requiresEmbeddings: decision.requiresEmbeddings,
      requiresSourceRecall: decision.requiresSourceRecall,
      canAnswerDirectly: decision.canAnswerDirectly,
      routePlan: decision.routePlan,
      layerScores: decision.layerScores ?? [],
      explanation: decision.explanation,
      retrievalHitType: this.deps.getRetrievalHitType(decision),
      matchedProjectId: decision.matchedProjectId ?? null,
      matchedProjectTitle: decision.matchedProjectTitle ?? null,
      shouldAutoRecall: this.deps.shouldAutoRecall(decision, context),
      autoRecallReason: this.deps.explainAutoRecall(decision, context),
      promptForApi,
      apiPrompt: null,
      autoRecallEnabled: context.config.autoRecallEnabled,
      retrievalStrength: context.config.retrievalStrength,
      usageFeedbackEnabled: context.config.usageFeedbackEnabled,
      retrievalEnhancements: this.deps.buildRetrievalEnhancementDiagnostics(context.config),
      openClawNativeMode: context.config.openClawNativeMode,
      sourceTraceRequired: this.deps.isSourceTraceRequired(decision, context),
      evidencePresentation: context.config.retrievalStrength === "xhigh"
        ? "show_source_trace"
        : context.config.retrievalStrength === "high"
          ? "show_when_needed"
          : "hidden_by_default",
      emergencyBrake: context.config.emergencyBrake,
      configPreset: context.config.configPreset,
      configWarnings,
      semanticCandidateExpansionEnabled: context.config.semanticCandidateExpansionEnabled,
      semanticCandidateLimit: context.config.semanticCandidateLimit,
      llmPlannerMode: context.config.llmPlannerMode,
      plannerDebugEnabled: context.config.plannerDebugEnabled,
      planner: decision.planner ?? null,
      plannerIntent: decision.planner?.intent.primary ?? null,
      plannerActivationMode: decision.planner?.activationMode ?? null,
      plannerSelectedPlan: decision.planner?.selectedPlan ?? "deterministic",
      plannerValidation: decision.planner?.validation ?? null,
      candidateExpansionMode:
        context.config.semanticCandidateExpansionEnabled
          ? semanticExpansion.ragSearch || semanticExpansion.graphSearch
            ? "planner_guided_rag_graph_plus_heuristic"
            : "heuristic_only"
          : "disabled",
      embeddingsReady: Boolean(semanticExpansion.ragSearch?.providerAvailable || semanticExpansion.ragSearch?.candidates.length),
      ragSearch: semanticExpansion.ragSearch ?? null,
      graphSearch: semanticExpansion.graphSearch ?? null,
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
      semanticHintAvailable: false,
    };
  }

  resolveRecallPresentationOptions(
    args: unknown,
    retrievalStrength: RetrievalStrength,
    getOptionalNumberArg: (args: unknown, key: string) => number | undefined,
    getBooleanArg: (args: unknown, key: string, fallback: boolean) => boolean,
    isRecord: (value: unknown) => value is Record<string, unknown>,
  ): RecallPresentationOptions {
    const deepRecall = isRecord(args) && (args.deepRecall === true || args.qualityMode === true);
    const maxItems = getOptionalNumberArg(args, "maxItems");
    const maxCharsPerItem = getOptionalNumberArg(args, "maxCharsPerItem");
    const forcedTrace = retrievalStrength === "high" || retrievalStrength === "xhigh";
    return {
      maxItems: Math.max(1, Math.min(12, Math.floor(maxItems ?? (deepRecall ? 8 : 4)))),
      maxCharsPerItem: Math.max(240, Math.min(2000, Math.floor(maxCharsPerItem ?? (deepRecall ? 1200 : 700)))),
      includeFullTrace: forcedTrace || getBooleanArg(args, "debugTrace", false) || getBooleanArg(args, "verbose", false),
    };
  }

  compactAnswerCandidates(
    candidates: AnswerCandidate[],
    presentation: RecallPresentationOptions,
  ): AnswerCandidate[] {
    if (presentation.includeFullTrace) {
      return candidates;
    }
    return candidates.slice(0, 5).map((candidate) => ({
      ...candidate,
      evidenceMessageIds: candidate.evidenceMessageIds.slice(0, 3),
    }));
  }

  formatRecallText(args: RecallTextArgs): string {
    const {
      query,
      items,
      sourceTrace = [],
      answerCandidates = [],
      presentation = {
        maxItems: 4,
        maxCharsPerItem: 700,
        includeFullTrace: false,
      },
      evidenceGate,
      diagnostics = {},
    } = args;

    if (items.length === 0 && answerCandidates.length === 0) {
      return `No matching historical details found for query: ${query}`;
    }
    const answers = answerCandidates.length > 0
      ? [
          "Answer candidates:",
          ...answerCandidates.slice(0, 5).map((candidate, index) =>
            `${index + 1}. ${candidate.text} (${candidate.type}, confidence=${candidate.confidence}, sourceVerified=${candidate.sourceVerified})`,
          ),
          "",
        ].join("\n")
      : "";
    const gate = evidenceGate
      ? [
          `Evidence gate: ${evidenceGate.status}`,
          `Reason: ${evidenceGate.reason}`,
          `Usable atoms: ${evidenceGate.usableAtomCount}/${evidenceGate.atomHitCount}`,
          `Recommended action: ${evidenceGate.recommendedAction}`,
          evidenceGate.nextActionHint ? `Next action hint: ${evidenceGate.nextActionHint}` : "",
          evidenceGate.targetIds.length > 0 ? `Trace targets: ${evidenceGate.targetIds.join(", ")}` : "",
          "",
        ].filter((line) => line.length > 0).join("\n")
      : "";
    const budget = diagnostics.retrievalBudget
      ? [
          "Retrieval budget:",
          `- total=${diagnostics.retrievalBudget.total}, atom=${diagnostics.retrievalBudget.atom}, summary=${diagnostics.retrievalBudget.summary}, raw=${diagnostics.retrievalBudget.raw}`,
          `- per item: atom=${diagnostics.retrievalBudget.perItem.atom}, summary=${diagnostics.retrievalBudget.perItem.summary}, raw=${diagnostics.retrievalBudget.perItem.raw}`,
          `- persistent atoms=${diagnostics.persistentEvidenceAtomHitCount ?? 0}, transient atoms=${diagnostics.transientEvidenceAtomHitCount ?? 0}`,
          "",
        ].join("\n")
      : "";
    const verifier = diagnostics.retrievalVerification
      ? [
          "Retrieval verifier:",
          `- status=${diagnostics.retrievalVerification.status}, action=${diagnostics.retrievalVerification.recommendedAction}`,
          `- sourceTraceStatus=${diagnostics.retrievalVerification.sourceTraceStatus}, verifiedTrace=${diagnostics.retrievalVerification.verifiedTraceCount}, completeRawTrace=${diagnostics.retrievalVerification.completeRawTraceCount}`,
          `- reason=${diagnostics.retrievalVerification.reason}`,
          "",
        ].join("\n")
      : "";
    const evidenceAnswer = diagnostics.evidenceAnswer
      ? [
          "Evidence answer resolver:",
          diagnostics.evidenceAnswer.status === "answered"
            ? `- answer=${diagnostics.evidenceAnswer.answer} (${diagnostics.evidenceAnswer.type}, confidence=${diagnostics.evidenceAnswer.confidence}, sourceVerified=${diagnostics.evidenceAnswer.sourceVerified})`
            : `- status=${diagnostics.evidenceAnswer.status}`,
          `- reason=${diagnostics.evidenceAnswer.reason}`,
          diagnostics.evidenceAnswer.alternatives.length > 0
            ? `- alternatives=${diagnostics.evidenceAnswer.alternatives.map((item) => `${item.answer}:${item.confidence}`).join(", ")}`
            : "",
          "",
        ].filter((line) => line.length > 0).join("\n")
      : "";
    const summaryItems = items.filter((item) => item.kind === "summary");
    const messageItems = items
      .filter((item) => item.kind !== "summary")
      .sort((left, right) => this.scoreRecallDisplayItem(right, query) - this.scoreRecallDisplayItem(left, query));
    const localMatches = this.buildLocalSourceMatches(messageItems, query).slice(0, 3);
    const summaryBudget = Math.min(2, Math.max(1, Math.floor(presentation.maxItems / 2)));
    const messageBudget = Math.max(1, presentation.maxItems - summaryBudget);
    const visibleItems = messageItems.length > 0
      ? [
          ...messageItems.slice(0, messageBudget),
          ...summaryItems.slice(0, summaryBudget),
        ].slice(0, presentation.maxItems)
      : summaryItems.slice(0, presentation.maxItems);
    const localMatchText = localMatches.length > 0
      ? [
          "Top local source matches (prefer these over broad multi-dossier summaries):",
          ...localMatches.map((match, index) =>
            `${index + 1}. ${match.slug ? `slug ${match.slug}` : "no slug anchor"} at turn ${match.turnNumber ?? "?"} score=${match.score}${match.roles.length > 0 ? ` roles=${match.roles.slice(0, 3).join(",")}` : ""}: ${this.truncateText(match.excerpt, 260)}`,
          ),
          "",
        ].join("\n")
      : "";
    const messages = visibleItems
      .map((item) => {
        const label = item.kind === "summary"
          ? item.metadata?.persistentEvidenceAtom === true
            ? `[evidence atom ${item.metadata.atomId ?? "?"}]`
            : `[summary ${item.summaryId ?? "?"}]`
          : `[turn ${(item.turnNumber as number | undefined) ?? "?"}] ${(item.role as string | undefined) ?? "user"}`;
        return `${label}: ${this.truncateText(String(item.content ?? ""), presentation.maxCharsPerItem)}`;
      })
      .join("\n\n");
    const omitted = items.length > visibleItems.length
      ? `\n\n... ${items.length - visibleItems.length} more hit(s) omitted. Use oms_expand with a listed summaryId/messageId, or call memory_retrieve with deepRecall=true for a wider pull.`
      : "";
    const traces = sourceTrace.length > 0
      ? [
          "",
          "Source trace:",
          ...sourceTrace.slice(0, presentation.includeFullTrace ? sourceTrace.length : 6).map((trace) =>
            `- summary ${trace.summaryId ?? "?"} -> ${trace.strategy} -> ${trace.verified ? "verified" : "unverified"} (${trace.resolvedMessageCount} messages)`,
          ),
          ...(!presentation.includeFullTrace && sourceTrace.length > 6 ? [`- ... ${sourceTrace.length - 6} more source trace node(s) omitted`] : []),
        ].join("\n")
      : "";
    return [
      `Historical source hits for: ${query}`,
      "",
      answers,
      gate,
      budget,
      verifier,
      evidenceAnswer,
      localMatchText,
      messages,
      omitted,
      traces,
    ].filter(Boolean).join("\n");
  }

  formatMemoryItemText(query: string, items: MemoryItemEntry[]): string {
    return [
      `MemoryItem hits for: ${query}`,
      ...items.map((item, index) =>
        `${index + 1}. [${item.kind}/${item.sourceTable}] ${item.content ?? item.text}`),
    ].join("\n");
  }

  formatRecentTailText(
    query: string,
    items: Array<{ turnNumber: number; role: string; content: string }>,
  ): string {
    if (items.length === 0) {
      return `No standard retrieval hit found for query: ${query}`;
    }
    return [
      `Recent context for: ${query}`,
      ...items.map((item) => `[turn ${item.turnNumber}] ${item.role}: ${item.content}`),
    ].join("\n\n");
  }

  buildPlannerValidationBlockedResponse(
    query: string,
    decision: RetrievalDecision,
  ): ToolResponse {
    const violations = decision.planner?.validation.violations ?? [];
    return {
      content: [{
        type: "text",
        text: [
          `PlanValidator blocked retrieval for: ${query}`,
          "The planner produced a hard-boundary violation, so OMS refused to execute the unsafe plan or fall back to an unsupported answer.",
          violations.length > 0
            ? `Violations: ${violations.map((violation) => `${violation.severity}:${violation.code}`).join(", ")}`
            : "Violations: unknown",
        ].join("\n"),
      }],
      details: {
        ok: false,
        route: decision.route,
        query,
        retrievalHitType: "planner_validation_blocked",
        evidencePresentation: "no_answer",
        hitCount: 0,
        blockedBy: "PlanValidator",
        planner: decision.planner ?? null,
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        fallbackTrace: [{
          from: decision.route,
          to: "none",
          reason: "plan_validator_safe_no_answer",
        }],
      },
    };
  }

  buildRetrievalVerifierBlockedResponse(
    args: RetrievalVerifierBlockedResponseArgs,
  ): ToolResponse {
    const {
      query,
      decision,
      recallResult,
      retrievalVerification,
      evidenceGate,
      diagnostics,
      progressiveRetrievalSteps,
    } = args;
    return {
      content: [{
        type: "text",
        text: [
          `Retrieval verifier blocked final answer for: ${query}`,
          `Status: ${retrievalVerification.status}; action: ${retrievalVerification.recommendedAction}`,
          `Reason: ${retrievalVerification.reason}`,
          "No unsupported MemoryItem, summary, or trace-only content is returned as a final fact.",
        ].join("\n"),
      }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.deps.describeRetrievalRoute(decision),
        query,
        hitCount: 0,
        blockedHitCount: recallResult.items.length,
        retrievalHitType: "insufficient_source_evidence",
        evidencePresentation: "no_answer",
        autoRecall: true,
        autoRecallReason: "retrieval_verifier_requires_source_evidence",
        routePlan: decision.routePlan,
        layerScores: decision.layerScores ?? [],
        explanation: decision.explanation,
        evidenceGate,
        retrievalVerification,
        sourceTrace: this.deps.compactSourceTrace(recallResult.sourceTrace),
        answerCandidates: this.compactAnswerCandidates(recallResult.answerCandidates ?? [], {
          maxItems: 3,
          maxCharsPerItem: 200,
          includeFullTrace: false,
        }),
        retrievalBudget: diagnostics.retrievalBudget,
        persistentEvidenceAtomHitCount: diagnostics.persistentEvidenceAtomHitCount,
        transientEvidenceAtomHitCount: diagnostics.transientEvidenceAtomHitCount,
        progressiveRetrievalSteps,
        fallbackTrace: [{
          from: decision.route,
          to: "none",
          reason: "retrieval_verifier_insufficient_source_evidence",
        }],
      },
    };
  }

  private truncateText(value: string, maxChars: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd()} ... [truncated]`;
  }

  private scoreRecallDisplayItem(item: ContextItem, query: string): number {
    const content = String(item.content ?? "").toLowerCase();
    const terms = this.deps.queryTerms(query);
    let score = 0;
    for (const term of terms) {
      if (content.includes(term.toLowerCase())) {
        score += term.length >= 6 ? 4 : 2;
      }
    }
    const anchors = query.match(/\b[A-Z][A-Z0-9_]{2,}\b|\b\d{2,}\b/g) ?? [];
    for (const anchor of anchors) {
      if (String(item.content ?? "").includes(anchor)) {
        score += 8;
      }
    }
    score += scoreIntentRoleMatch(query, String(item.content ?? "")).score;
    return score;
  }

  private buildLocalSourceMatches(
    messageItems: ContextItem[],
    query: string,
  ): Array<{ slug: string | null; turnNumber: number | undefined; score: number; roles: string[]; excerpt: string }> {
    return messageItems
      .map((item) => {
        const content = String(item.content ?? "");
        const roleMatch = scoreIntentRoleMatch(query, content);
        return {
          slug: this.extractBestSlugAnchor(content, query),
          turnNumber: typeof item.turnNumber === "number" ? item.turnNumber : undefined,
          score: this.scoreRecallDisplayItem(item, query),
          roles: roleMatch.roles,
          excerpt: content,
        };
      })
      .filter((match) => match.score > 0 || match.slug !== null)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.slug && !right.slug) {
          return -1;
        }
        if (!left.slug && right.slug) {
          return 1;
        }
        return (left.turnNumber ?? Number.MAX_SAFE_INTEGER) - (right.turnNumber ?? Number.MAX_SAFE_INTEGER);
      });
  }

  private extractBestSlugAnchor(content: string, query: string): string | null {
    const explicitSlug = content.match(/(?:^|\||\b)slug\s*(?:\||:|=)\s*`?(\d{2}_[a-z0-9_]+)`?/i)?.[1];
    if (explicitSlug) {
      return explicitSlug;
    }
    const slugs = [...new Set(content.match(/\b\d{2}_[a-z0-9_]+\b/gi) ?? [])];
    if (slugs.length === 0) {
      return null;
    }
    if (slugs.length === 1) {
      return slugs[0];
    }
    const terms = this.deps.queryTerms(query);
    const windows = slugs.map((slug) => {
      const index = content.toLowerCase().indexOf(slug.toLowerCase());
      const start = Math.max(0, index - 500);
      const end = Math.min(content.length, index + 500);
      const window = content.slice(start, end).toLowerCase();
      const score = terms.reduce((sum, term) => sum + (window.includes(term.toLowerCase()) ? (term.length >= 6 ? 4 : 2) : 0), 0);
      return { slug, score };
    });
    return windows.sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))[0]?.slug ?? slugs[0];
  }
}
