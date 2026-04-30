import {
  AnswerCandidate,
  BridgeConfig,
  ContextItem,
  LlmCaller,
  RetrievalStrength,
  SourceTrace,
} from "../types";

export type EvidenceAnswerStatus = "answered" | "conflict" | "insufficient" | "unavailable";

export interface EvidenceAnswerResolution {
  status: EvidenceAnswerStatus;
  answer: string | null;
  type: AnswerCandidate["type"] | "none";
  confidence: number;
  sourceVerified: boolean;
  evidenceMessageIds: string[];
  reason: string;
  candidateCount: number;
  provider: BridgeConfig["evidenceAnswerResolverProvider"];
  providerAvailable: boolean;
  selectedCandidate?: AnswerCandidate;
  alternatives: Array<{
    answer: string;
    type: AnswerCandidate["type"];
    confidence: number;
    sourceVerified: boolean;
    evidenceMessageIds: string[];
  }>;
}

interface CandidateGroup {
  key: string;
  answer: string;
  type: AnswerCandidate["type"];
  confidence: number;
  sourceVerified: boolean;
  evidenceMessageIds: Set<string>;
  candidates: AnswerCandidate[];
}

interface ResolverConfig {
  enabled: boolean;
  provider: BridgeConfig["evidenceAnswerResolverProvider"];
  model?: string;
  timeoutMs: number;
  fallbackToDeterministic: boolean;
}

interface LlmResolverResponse {
  status?: "answered" | "conflict" | "insufficient";
  selectedCandidateIndex?: number;
  answer?: string;
  type?: AnswerCandidate["type"];
  confidence?: number;
  reason?: string;
}

export class EvidenceAnswerResolver {
  async resolve(args: {
    query: string;
    items: ContextItem[];
    answerCandidates?: AnswerCandidate[];
    sourceTrace?: SourceTrace[];
    retrievalStrength: RetrievalStrength;
    config: ResolverConfig;
    llmCaller?: LlmCaller | null;
  }): Promise<EvidenceAnswerResolution> {
    const candidates = this.sortedCandidates(args.answerCandidates ?? []);
    if (!args.config.enabled || args.config.provider === "none") {
      return this.unavailable("evidence_answer_resolver_not_configured", candidates.length, args.config.provider);
    }
    if (args.config.provider === "deterministic") {
      return this.resolveDeterministic({ ...args, answerCandidates: candidates }, "deterministic", true);
    }
    if ((args.config.provider === "llm" || args.config.provider === "external") && !args.config.model?.trim()) {
      if (args.config.fallbackToDeterministic) {
        return this.resolveDeterministic({ ...args, answerCandidates: candidates }, "deterministic", true, "explicit_deterministic_fallback_used_model_missing");
      }
      return this.unavailable("evidence_answer_resolver_model_required", candidates.length, args.config.provider);
    }
    if (!args.llmCaller) {
      if (args.config.fallbackToDeterministic) {
        return this.resolveDeterministic({ ...args, answerCandidates: candidates }, "deterministic", true, "explicit_deterministic_fallback_used_llm_missing");
      }
      return this.unavailable("evidence_answer_resolver_llm_caller_unavailable", candidates.length, args.config.provider);
    }

    try {
      const response = await this.callLlmResolver(args, candidates);
      return this.validateLlmResolution(response, args, candidates);
    } catch (error) {
      if (args.config.fallbackToDeterministic) {
        return this.resolveDeterministic({ ...args, answerCandidates: candidates }, "deterministic", true, `explicit_deterministic_fallback_used:${error instanceof Error ? error.message : String(error)}`);
      }
      return this.unavailable(
        `evidence_answer_resolver_call_failed:${error instanceof Error ? error.message : String(error)}`,
        candidates.length,
        args.config.provider,
      );
    }
  }

  resolveDeterministic(args: {
    query: string;
    items: ContextItem[];
    answerCandidates?: AnswerCandidate[];
    sourceTrace?: SourceTrace[];
    retrievalStrength: RetrievalStrength;
  }, provider: BridgeConfig["evidenceAnswerResolverProvider"] = "deterministic", providerAvailable = true, reasonOverride?: string): EvidenceAnswerResolution {
    const candidates = this.sortedCandidates(args.answerCandidates ?? []);
    if (candidates.length === 0) {
      return this.insufficient(reasonOverride ?? "no_answer_candidates", 0, provider, providerAvailable);
    }

    const requiresSource = args.retrievalStrength === "high" || args.retrievalStrength === "xhigh";
    const sourceTraceVerified = (args.sourceTrace ?? []).some((trace) => trace.verified && trace.resolvedMessageCount > 0);
    const completeRawTrace = this.hasCompleteRawTrace(args.items, args.sourceTrace ?? []);
    if (requiresSource && !completeRawTrace) {
      return this.insufficient(
        reasonOverride ?? (sourceTraceVerified ? "no_complete_raw_trace_for_answer" : "no_verified_source_trace_for_answer"),
        candidates.length,
        provider,
        providerAvailable,
      );
    }
    const eligible = requiresSource
      ? candidates.filter((candidate) => candidate.sourceVerified)
      : candidates;
    if (eligible.length === 0) {
      return this.insufficient(
        reasonOverride ?? (sourceTraceVerified ? "no_source_verified_answer_candidate" : "no_verified_source_trace_for_answer"),
        candidates.length,
        provider,
        providerAvailable,
      );
    }

    const groups = this.groupCandidates(eligible);
    const [top, second] = groups;
    if (!top) {
      return this.insufficient(reasonOverride ?? "no_grouped_answer_candidates", candidates.length, provider, providerAvailable);
    }
    if (second && this.isConflict(top, second, requiresSource)) {
      return {
        status: "conflict",
        answer: null,
        type: "none",
        confidence: Math.max(top.confidence, second.confidence),
        sourceVerified: top.sourceVerified || second.sourceVerified,
        evidenceMessageIds: [...new Set([...top.evidenceMessageIds, ...second.evidenceMessageIds])],
        reason: reasonOverride ?? "competing_answer_candidates_require_more_evidence",
        candidateCount: candidates.length,
        provider,
        providerAvailable,
        alternatives: this.alternatives(groups),
      };
    }

    const selected = top.candidates
      .sort((left, right) => this.scoreCandidate(right) - this.scoreCandidate(left))[0];
    return {
      status: "answered",
      answer: top.answer,
      type: top.type,
      confidence: top.confidence,
      sourceVerified: top.sourceVerified,
      evidenceMessageIds: [...top.evidenceMessageIds],
      reason: reasonOverride ?? (requiresSource ? "source_verified_answer_candidate_selected" : "best_answer_candidate_selected"),
      candidateCount: candidates.length,
      provider,
      providerAvailable,
      selectedCandidate: selected,
      alternatives: this.alternatives(groups.slice(1)),
    };
  }

  private async callLlmResolver(args: {
    query: string;
    items: ContextItem[];
    sourceTrace?: SourceTrace[];
    retrievalStrength: RetrievalStrength;
    config: ResolverConfig;
    llmCaller?: LlmCaller | null;
  }, candidates: AnswerCandidate[]): Promise<LlmResolverResponse> {
    const llmCaller = args.llmCaller;
    if (!llmCaller) {
      throw new Error("llm_caller_missing");
    }
    const prompt = [
      "You are ChaunyOMS EvidenceAnswerResolver. Resolve the final answer strictly from provided candidates and evidence.",
      "Rules:",
      "- Return JSON only.",
      "- Do not invent an answer outside the candidates.",
      "- If evidence conflicts, return status=conflict.",
      "- If the answer is not source-backed enough, return status=insufficient.",
      "- selectedCandidateIndex is zero-based and required when status=answered.",
      `retrievalStrength=${args.retrievalStrength}`,
      `query=${JSON.stringify(args.query)}`,
      `candidates=${JSON.stringify(candidates.slice(0, 12).map((candidate, index) => ({
        index,
        text: candidate.text,
        type: candidate.type,
        confidence: candidate.confidence,
        sourceVerified: candidate.sourceVerified,
        evidenceMessageIds: candidate.evidenceMessageIds,
        reason: candidate.reason,
      })))}`,
      `sourceTrace=${JSON.stringify((args.sourceTrace ?? []).slice(0, 8).map((trace) => ({
        verified: trace.verified,
        resolvedMessageCount: trace.resolvedMessageCount,
        messageIds: trace.messageIds,
        reason: trace.reason,
      })))}`,
      `evidenceSnippets=${JSON.stringify(args.items.slice(0, 8).map((item, index) => ({
        index,
        kind: item.kind,
        role: item.role,
        content: item.content.slice(0, 700),
      })))}`,
      'Schema: {"status":"answered|conflict|insufficient","selectedCandidateIndex":number,"answer":string,"type":string,"confidence":number,"reason":string}',
    ].join("\n");
    const raw = await this.withTimeout(
      llmCaller.call({
        model: args.config.model,
        prompt,
        temperature: 0,
        maxOutputTokens: 500,
        responseFormat: "json",
      }),
      args.config.timeoutMs,
    );
    return this.parseJsonResponse(raw);
  }

  private validateLlmResolution(args: LlmResolverResponse, source: {
    retrievalStrength: RetrievalStrength;
    config: ResolverConfig;
    items: ContextItem[];
    sourceTrace?: SourceTrace[];
  }, candidates: AnswerCandidate[]): EvidenceAnswerResolution {
    const provider = source.config.provider;
    const normalizedStatus = args.status ?? (typeof args.answer === "string" && args.answer.trim() ? "answered" : undefined);
    if (normalizedStatus === "conflict") {
      const deterministic = this.resolveDeterministic({
        query: "",
        items: source.items,
        answerCandidates: candidates,
        sourceTrace: source.sourceTrace ?? [],
        retrievalStrength: source.retrievalStrength,
      }, provider, true, args.reason ?? "llm_reported_conflict");
      return deterministic.status === "answered"
        ? { ...deterministic, status: "conflict", answer: null, type: "none", reason: args.reason ?? "llm_reported_conflict" }
        : { ...deterministic, status: "conflict", answer: null, type: "none", reason: args.reason ?? deterministic.reason };
    }
    if (normalizedStatus === "insufficient") {
      return this.insufficient(args.reason ?? "llm_reported_insufficient_evidence", candidates.length, provider, true);
    }
    const selectedCandidateIndex = this.resolveSelectedCandidateIndex(args, candidates);
    if (normalizedStatus !== "answered" || !Number.isInteger(selectedCandidateIndex)) {
      return this.insufficient("llm_response_missing_selected_candidate", candidates.length, provider, true);
    }
    const selectedIndex = selectedCandidateIndex as number;
    const selected = candidates[selectedIndex];
    if (!selected) {
      return this.insufficient("llm_selected_candidate_out_of_range", candidates.length, provider, true);
    }
    const requiresSource = source.retrievalStrength === "high" || source.retrievalStrength === "xhigh";
    if (requiresSource && !this.hasCompleteRawTrace(source.items, source.sourceTrace ?? [], selected.evidenceMessageIds)) {
      return this.insufficient("llm_selected_candidate_missing_complete_raw_trace", candidates.length, provider, true);
    }
    if (requiresSource && !selected.sourceVerified) {
      return this.insufficient("llm_selected_unverified_candidate_rejected", candidates.length, provider, true);
    }
    return {
      status: "answered",
      answer: selected.text,
      type: selected.type,
      confidence: Math.max(0, Math.min(1, Number.isFinite(args.confidence) ? Number(args.confidence) : selected.confidence)),
      sourceVerified: selected.sourceVerified,
      evidenceMessageIds: selected.evidenceMessageIds,
      reason: args.reason ?? "llm_selected_source_verified_candidate",
      candidateCount: candidates.length,
      provider,
      providerAvailable: true,
      selectedCandidate: selected,
      alternatives: this.alternatives(this.groupCandidates(candidates.filter((candidate) => candidate !== selected))),
    };
  }

  private parseJsonResponse(raw: string): LlmResolverResponse {
    const trimmed = raw.trim();
    const jsonText = trimmed.startsWith("{")
      ? trimmed
      : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
    if (!jsonText || !jsonText.startsWith("{")) {
      throw new Error("invalid_json_response");
    }
    return JSON.parse(jsonText) as LlmResolverResponse;
  }

  private resolveSelectedCandidateIndex(args: LlmResolverResponse, candidates: AnswerCandidate[]): number | null {
    if (Number.isInteger(args.selectedCandidateIndex)) {
      return args.selectedCandidateIndex as number;
    }
    const answer = typeof args.answer === "string" ? this.normalizeAnswer(args.answer) : "";
    if (answer) {
      const exactIndex = candidates.findIndex((candidate) => this.normalizeAnswer(candidate.text) === answer);
      if (exactIndex >= 0) {
        return exactIndex;
      }
      const containsIndex = candidates.findIndex((candidate) => {
        const candidateText = this.normalizeAnswer(candidate.text);
        return candidateText.includes(answer) || answer.includes(candidateText);
      });
      if (containsIndex >= 0) {
        return containsIndex;
      }
    }
    return candidates.length === 1 ? 0 : null;
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

  private sortedCandidates(candidates: AnswerCandidate[]): AnswerCandidate[] {
    return [...candidates]
      .filter((candidate) => candidate.text.trim().length > 0)
      .sort((left, right) => this.scoreCandidate(right) - this.scoreCandidate(left));
  }

  private hasCompleteRawTrace(
    items: ContextItem[],
    sourceTrace: SourceTrace[],
    evidenceMessageIds: string[] = [],
  ): boolean {
    const rawMessageIds = new Set(items
      .filter((item) => item.kind === "message")
      .map((item) => item.metadata?.messageId)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0));
    if (rawMessageIds.size === 0) {
      return false;
    }
    const evidenceIds = new Set(evidenceMessageIds.filter((id) => id.trim().length > 0));
    if (evidenceIds.size > 0 && ![...evidenceIds].some((id) => rawMessageIds.has(id))) {
      return false;
    }
    return sourceTrace.some((trace) => {
      if (!trace.verified ||
        trace.resolvedMessageCount <= 0 ||
        trace.strategy === "none" ||
        (trace.strategy !== "message_ids" &&
          trace.strategy !== "sequence_range" &&
          trace.strategy !== "turn_range")) {
        return false;
      }
      if ((trace.messageIds?.length ?? 0) === 0) {
        return true;
      }
      return (trace.messageIds ?? []).some((id) => rawMessageIds.has(id));
    });
  }

  private groupCandidates(candidates: AnswerCandidate[]): CandidateGroup[] {
    const byKey = new Map<string, CandidateGroup>();
    for (const candidate of candidates) {
      const key = this.normalizeAnswer(candidate.text);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          key,
          answer: candidate.text.trim(),
          type: candidate.type,
          confidence: candidate.confidence,
          sourceVerified: candidate.sourceVerified,
          evidenceMessageIds: new Set(candidate.evidenceMessageIds),
          candidates: [candidate],
        });
        continue;
      }
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
      existing.sourceVerified = existing.sourceVerified || candidate.sourceVerified;
      for (const id of candidate.evidenceMessageIds) {
        existing.evidenceMessageIds.add(id);
      }
      existing.candidates.push(candidate);
    }
    return [...byKey.values()].sort((left, right) => this.scoreGroup(right) - this.scoreGroup(left));
  }

  private isConflict(left: CandidateGroup, right: CandidateGroup, requiresSource: boolean): boolean {
    if (left.key === right.key) {
      return false;
    }
    if (requiresSource && (!left.sourceVerified || !right.sourceVerified)) {
      return false;
    }
    return Math.abs(left.confidence - right.confidence) <= 0.08;
  }

  private scoreCandidate(candidate: AnswerCandidate): number {
    return candidate.confidence +
      (candidate.sourceVerified ? 0.2 : 0) +
      Math.min(candidate.evidenceMessageIds.length, 4) * 0.025;
  }

  private scoreGroup(group: CandidateGroup): number {
    return group.confidence +
      (group.sourceVerified ? 0.2 : 0) +
      Math.min(group.evidenceMessageIds.size, 4) * 0.025 +
      Math.min(group.candidates.length, 3) * 0.02;
  }

  private normalizeAnswer(answer: string): string {
    return answer
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[????']/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private alternatives(groups: CandidateGroup[]): EvidenceAnswerResolution["alternatives"] {
    return groups.slice(0, 4).map((group) => ({
      answer: group.answer,
      type: group.type,
      confidence: group.confidence,
      sourceVerified: group.sourceVerified,
      evidenceMessageIds: [...group.evidenceMessageIds],
    }));
  }

  private insufficient(
    reason: string,
    candidateCount: number,
    provider: BridgeConfig["evidenceAnswerResolverProvider"],
    providerAvailable: boolean,
  ): EvidenceAnswerResolution {
    return {
      status: "insufficient",
      answer: null,
      type: "none",
      confidence: 0,
      sourceVerified: false,
      evidenceMessageIds: [],
      reason,
      candidateCount,
      provider,
      providerAvailable,
      alternatives: [],
    };
  }

  private unavailable(
    reason: string,
    candidateCount: number,
    provider: BridgeConfig["evidenceAnswerResolverProvider"],
  ): EvidenceAnswerResolution {
    return {
      status: "unavailable",
      answer: null,
      type: "none",
      confidence: 0,
      sourceVerified: false,
      evidenceMessageIds: [],
      reason,
      candidateCount,
      provider,
      providerAvailable: false,
      alternatives: [],
    };
  }
}
