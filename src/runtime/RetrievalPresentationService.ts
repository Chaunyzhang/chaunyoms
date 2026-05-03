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
  RawEvidencePacketMessage,
  RecallPresentationOptions,
  RecallTextArgs,
  RecallTextDiagnostics,
  SummaryEvidencePacketItem,
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
      summaryEvidence = [],
      rawEvidenceMessages = [],
    } = args;

    if (items.length === 0 && answerCandidates.length === 0) {
      return `No matching historical details found for query: ${query}`;
    }
    const packet = this.buildEvidencePacket({
      query,
      items,
      summaryEvidence,
      rawEvidenceMessages,
      sourceTrace,
      evidenceGate,
    });
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
      packet,
      "",
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

  private buildEvidencePacket(args: {
    query: string;
    items: ContextItem[];
    summaryEvidence: SummaryEvidencePacketItem[];
    rawEvidenceMessages: RawEvidencePacketMessage[];
    sourceTrace: Array<{ summaryId?: string; strategy: string; verified: boolean; resolvedMessageCount: number }>;
    evidenceGate?: EvidenceGateResult;
  }): string {
    const slots = this.extractRequestedSlots(args.query);
    const effectiveSlots = slots.length > 0 ? slots : [{
      id: "question_focus",
      label: "question focus",
      aliases: this.deps.queryTerms(args.query).slice(0, 6),
      keyAliases: [],
      valueExtractors: [],
    }];
    const lines: string[] = [];
    lines.push("## Evidence Packet");
    lines.push(`Query: ${args.query}`);
    lines.push("");
    lines.push("### Requested Slots");
    for (const slot of effectiveSlots) {
      lines.push(`- ${slot.label}`);
    }
    lines.push("");
    lines.push("### Slot-Matched Evidence");
    const allConflicts: string[] = [];
    for (const slot of effectiveSlots) {
      const rawMatches = this.matchRawEvidence(slot, args.rawEvidenceMessages);
      const summaryMatches = this.matchSummaryEvidence(slot, args.summaryEvidence);
      const conflicts = this.collectSlotConflicts(slot, rawMatches, summaryMatches);
      allConflicts.push(...conflicts.map((conflict) => `${slot.label}: ${conflict}`));
      lines.push(`#### ${slot.label}`);
      if (rawMatches.length === 0 && summaryMatches.length === 0) {
        lines.push("- no strong matched evidence");
        lines.push("");
        continue;
      }
      const bestRaw = rawMatches.slice(0, 2);
      const bestSummaries = summaryMatches.slice(0, 2);
      if (bestRaw.length > 0) {
        lines.push(`- matched raw evidence count: ${rawMatches.length}`);
        for (const match of bestRaw) {
          lines.push(`- raw score=${match.score}${match.value ? ` value=${match.value}` : ""} source=${match.sourceLabel}`);
          lines.push(`  [turn ${match.message.turnNumber}] ${match.message.role}: ${this.truncateText(match.message.content, 260)}`);
        }
      }
      if (bestSummaries.length > 0) {
        lines.push("- child summaries:");
        for (const match of bestSummaries) {
          const turnRange = typeof match.summary.startTurn === "number" && typeof match.summary.endTurn === "number"
            ? ` turns=${match.summary.startTurn}-${match.summary.endTurn}`
            : "";
          lines.push(`  [summary ${match.summary.summaryId}] score=${match.score}${turnRange}: ${this.truncateText(match.summary.summary, 220)}`);
        }
      }
      if (conflicts.length > 0) {
        lines.push(`- conflicts: ${conflicts.join(" | ")}`);
      }
      lines.push("");
    }
    lines.push("### Summary Trail");
    if (args.summaryEvidence.length > 0) {
      for (const summary of args.summaryEvidence.slice(0, 6)) {
        const turnRange = typeof summary.startTurn === "number" && typeof summary.endTurn === "number"
          ? ` turns=${summary.startTurn}-${summary.endTurn}`
          : "";
        const level = summary.summaryLevel ? ` level=${summary.summaryLevel}` : "";
        const kind = summary.nodeKind ? ` kind=${summary.nodeKind}` : "";
        lines.push(`- [summary ${summary.summaryId}]${level}${kind}${turnRange}: ${this.truncateText(summary.summary, 220)}`);
      }
    } else {
      lines.push("- none");
    }
    lines.push("");
    lines.push("### Raw Source Messages");
    if (args.rawEvidenceMessages.length > 0) {
      for (const message of args.rawEvidenceMessages.slice(0, 10)) {
        const marker = message.isCenter ? " center" : "";
        lines.push(`- [turn ${message.turnNumber}] ${message.role}${marker}: ${this.truncateText(message.content, 320)}`);
      }
    } else {
      lines.push("- none");
    }
    lines.push("");
    lines.push("### Answering Guidance");
    lines.push("- Use the slot-matched raw source messages first when they contain direct remembered facts.");
    lines.push("- Use child summaries as navigation/supporting context, not as a replacement for raw quoted facts.");
    lines.push("- If lower-priority environmental/config evidence conflicts with remembered session facts, surface the conflict explicitly instead of silently replacing the remembered value.");
    if (args.evidenceGate) {
      lines.push(`- Evidence gate status: ${args.evidenceGate.status}; recommended action: ${args.evidenceGate.recommendedAction}.`);
    }
    return lines.join("\n");
  }

  private extractRequestedSlots(query: string): Array<{
    id: string;
    label: string;
    aliases: string[];
    keyAliases: string[];
    valueExtractors: Array<(text: string) => string | null>;
  }> {
    const normalized = query.toLowerCase();
    const slots: Array<{
      id: string;
      label: string;
      aliases: string[];
      keyAliases: string[];
      valueExtractors: Array<(text: string) => string | null>;
    }> = [];
    if (/(current blocker|project blocker|blocker|当前阻碍|项目阻碍)/i.test(query)) {
      slots.push({
        id: "current_blocker",
        label: "current blocker",
        aliases: ["current blocker", "project blocker", "blocker", "当前阻碍", "项目阻碍"],
        keyAliases: [],
        valueExtractors: [
          (text) => text.match(/(?:current\s+project\s+blocker|project blocker|blocker)\s*[:：-]\s*([^\n]+)/i)?.[1]?.trim() ?? null,
        ],
      });
    }
    if (/(gateway port|gateway_port|端口|网关端口)/i.test(query)) {
      slots.push({
        id: "gateway_port",
        label: "gateway port",
        aliases: ["gateway port", "gateway_port", "网关端口", "端口"],
        keyAliases: ["GATEWAY_PORT"],
        valueExtractors: [
          (text) => text.match(/\bGATEWAY_PORT\s*(?:=|:|is)\s*([A-Za-z0-9_.:-]+)/i)?.[1]?.trim() ?? null,
          (text) => text.match(/gateway port[^0-9A-Za-z]{0,8}([0-9]{2,6})/i)?.[1]?.trim() ?? null,
        ],
      });
    }
    if (/(token alias|token_alias|别名令牌|令牌别名)/i.test(query)) {
      slots.push({
        id: "token_alias",
        label: "token alias",
        aliases: ["token alias", "token_alias", "令牌别名"],
        keyAliases: ["TOKEN_ALIAS"],
        valueExtractors: [
          (text) => text.match(/\bTOKEN_ALIAS\s*(?:=|:|is)\s*([A-Za-z0-9_.:-]+)/i)?.[1]?.trim() ?? null,
          (text) => text.match(/token alias[^A-Za-z0-9]{0,8}([A-Za-z0-9_.:-]+)/i)?.[1]?.trim() ?? null,
        ],
      });
    }
    if (/(api base|api_base)/i.test(query)) {
      slots.push({
        id: "api_base",
        label: "api base",
        aliases: ["api base", "api_base"],
        keyAliases: ["API_BASE"],
        valueExtractors: [
          (text) => text.match(/\bAPI_BASE\s*(?:=|:|is)\s*([A-Za-z0-9_.:/-]+)/i)?.[1]?.trim() ?? null,
        ],
      });
    }
    return slots;
  }

  private matchRawEvidence(
    slot: {
      aliases: string[];
      keyAliases: string[];
      valueExtractors: Array<(text: string) => string | null>;
    },
    messages: RawEvidencePacketMessage[],
  ): Array<{
    message: RawEvidencePacketMessage;
    score: number;
    value: string | null;
    sourceLabel: string;
  }> {
    return messages
      .map((message) => {
        const text = message.content;
        const lower = text.toLowerCase();
        let score = 0;
        for (const alias of slot.aliases) {
          if (alias && lower.includes(alias.toLowerCase())) {
            score += alias.length >= 8 ? 8 : 4;
          }
        }
        for (const key of slot.keyAliases) {
          if (text.includes(key)) {
            score += 18;
          }
        }
        let value: string | null = null;
        for (const extractor of slot.valueExtractors) {
          const hit = extractor(text);
          if (hit) {
            value = hit;
            score += 22;
            break;
          }
        }
        if (message.sourceVerified) {
          score += 5;
        }
        if (message.role === "user") {
          score += 3;
        }
        if (message.isCenter) {
          score += 2;
        }
        if (score <= 0) {
          return null;
        }
        return {
          message,
          score,
          value,
          sourceLabel: message.sourceVerified ? "verified_raw" : "raw",
        };
      })
      .filter((item): item is {
        message: RawEvidencePacketMessage;
        score: number;
        value: string | null;
        sourceLabel: string;
      } => Boolean(item))
      .sort((left, right) =>
        right.score - left.score ||
        Number(right.message.isCenter === true) - Number(left.message.isCenter === true) ||
        right.message.turnNumber - left.message.turnNumber,
      );
  }

  private matchSummaryEvidence(
    slot: {
      aliases: string[];
      keyAliases: string[];
      valueExtractors: Array<(text: string) => string | null>;
    },
    summaries: SummaryEvidencePacketItem[],
  ): Array<{
    summary: SummaryEvidencePacketItem;
    score: number;
    value: string | null;
  }> {
    return summaries
      .map((summary) => {
        const text = summary.summary;
        const lower = text.toLowerCase();
        let score = 0;
        for (const alias of slot.aliases) {
          if (alias && lower.includes(alias.toLowerCase())) {
            score += alias.length >= 8 ? 5 : 3;
          }
        }
        for (const key of slot.keyAliases) {
          if (text.includes(key)) {
            score += 10;
          }
        }
        let value: string | null = null;
        for (const extractor of slot.valueExtractors) {
          const hit = extractor(text);
          if (hit) {
            value = hit;
            score += 12;
            break;
          }
        }
        if (score <= 0) {
          return null;
        }
        return { summary, score, value };
      })
      .filter((item): item is {
        summary: SummaryEvidencePacketItem;
        score: number;
        value: string | null;
      } => Boolean(item))
      .sort((left, right) => right.score - left.score || (right.summary.startTurn ?? 0) - (left.summary.startTurn ?? 0));
  }

  private collectSlotConflicts(
    slot: { label: string },
    rawMatches: Array<{ value: string | null }>,
    summaryMatches: Array<{ value: string | null }>,
  ): string[] {
    const values = [
      ...rawMatches.map((match) => match.value).filter((value): value is string => Boolean(value)),
      ...summaryMatches.map((match) => match.value).filter((value): value is string => Boolean(value)),
    ];
    const distinct = [...new Set(values.map((value) => value.trim()))];
    if (distinct.length <= 1) {
      return [];
    }
    return distinct.map((value) => `${slot.label}=${value}`);
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
