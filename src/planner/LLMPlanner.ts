import { createHash } from "node:crypto";

import {
  LlmCaller,
  RetrievalDecision,
  RetrievalRoute,
} from "../types";
import { buildLLMPlannerPrompt } from "./LLMPlannerPrompt";
import { LLMPlannerActivationPolicy } from "./LLMPlannerActivationPolicy";
import {
  ContextBudgetIntent,
  LlmPlannerPlan,
  MemoryWriteDecision,
  PlannerCandidateLayer,
  PlannerIntent,
  PlannerRouteStep,
  PlannerRuntimeSignals,
} from "./LLMPlannerTypes";

const HISTORY_RE = /(刚才|之前|前面|上面|那个|这个|不是说过|记不记得|还记得|原话|原文|earlier|before|previous|history|verbatim|quote)/i;
const PRECISION_RE = /(精确|准确|端口|路径|命令|日期|时间|数字|参数|配置|承诺|exact|precise|path|port|command|date|number|parameter|config)/i;
const PROJECT_RE = /(项目|当前|下一步|卡在哪|阻塞|进度|状态|待办|project|current|next step|blocker|progress|status|todo)/i;
const MEMORY_WRITE_RE = /(记住|以后|别再|以后不要|偏好|原则|规则|remember|from now on|never again|always|preference|rule)/i;
const CORRECTION_RE = /(修正|更正|纠正|不是|改成|correction|correct|instead)/i;
const CONFLICT_RE = /(冲突|不一样|覆盖|替代|为什么.*之前|conflict|supersede|different)/i;
const DEBUG_RE = /(status|doctor|debug|trace|inspect|why|诊断|状态|为什么|排查|问题)/i;
const CREATIVE_RE = /(想想|发散|灵感|创意|方案 brainstorm|creative|inspiration|idea)/i;
const KNOWLEDGE_RE = /(knowledge|文档|知识库|Obsidian|Markdown|资料)/i;
const DESTRUCTIVE_RE = /(wipe|restore|import|delete|reset|清空|恢复|导入|删除|重置)/i;
const HIGH_CONSTRAINT_RE = /(严格按文档|按文档严格|绝对干净|不要妥协|不妥协|打磨到最终形态|最终形态|strictly follow|no compromise|final shape|production-ready)/i;
const SEMANTIC_FUZZY_RE = /(\u7c7b\u4f3c|\u76f8\u4f3c|\u90a3\u4e2a\u60f3\u6cd5|\u90a3\u4e2a\u539f\u5219|\u610f\u601d\u63a5\u8fd1|\u8bed\u4e49|\u6a21\u7cca|similar|like that|that idea|that principle|semantic|fuzzy|concept)/i;
const GRAPH_RELATION_RE = /(\u4f9d\u8d56|\u5f71\u54cd|\u5173\u7cfb|\u6765\u6e90|\u6eaf\u6e90|\u94fe\u8def|\u591a\u8df3|\u4e3a\u4ec0\u4e48|\u56e0\u679c|\u51b2\u7a81|\u652f\u6301|\u66ff\u4ee3|depends|dependency|impact|relation|provenance|trace|multi-hop|why|conflict|support|supersede)/i;

export interface LLMPlannerInput {
  query: string;
  deterministicDecision: RetrievalDecision;
  signals: PlannerRuntimeSignals;
  now?: string;
}

export interface LLMPlannerResult {
  plan: LlmPlannerPlan;
}

export class LLMPlanner {
  private readonly activationPolicy = new LLMPlannerActivationPolicy();

  constructor(private readonly llmCaller: () => LlmCaller | null) {}

  async plan(input: LLMPlannerInput): Promise<LLMPlannerResult> {
    const activation = this.activationPolicy.decide(input.query, input.signals);
    const createdAt = input.now ?? new Date().toISOString();
    const basePlan = this.buildHeuristicPlan(input, createdAt, activation.llmInvoked ? undefined : this.resolveFallback(input, activation.mode));

    if (activation.mode !== "llm_planner" || input.signals.llmPlannerMode === "shadow") {
      return { plan: basePlan };
    }

    const caller = this.llmCaller();
    if (!caller) {
      return { plan: basePlan };
    }

    try {
      const raw = await caller.call({
        model: input.signals.llmPlannerModel,
        prompt: buildLLMPlannerPrompt(input),
        temperature: 0,
        maxOutputTokens: 900,
        responseFormat: "json",
      });
      const parsed = this.parsePlannerJson(raw);
      if (!parsed) {
        return {
          plan: {
            ...basePlan,
            fallback: {
              from: "invalid_json",
              reason: "LLMPlanner returned invalid JSON; heuristic deterministic plan is used.",
            },
          },
        };
      }
      return {
        plan: this.mergeLlmHints(basePlan, parsed),
      };
    } catch (error) {
      return {
        plan: {
          ...basePlan,
          fallback: {
            from: "llm_error",
            reason: error instanceof Error ? error.message : String(error),
          },
          activation: {
            ...basePlan.activation,
            llmInvoked: false,
          },
        },
      };
    }
  }

  private buildHeuristicPlan(
    input: LLMPlannerInput,
    createdAt: string,
    fallback?: LlmPlannerPlan["fallback"],
  ): LlmPlannerPlan {
    const intent = this.classifyIntent(input.query, input.signals, input.deterministicDecision.route);
    const sourceTraceRequired =
      input.signals.retrievalStrength === "strict" ||
      input.signals.retrievalStrength === "forensic" ||
      intent.primary === "precision_fact" ||
      intent.primary === "history_trace" ||
      (intent.primary === "architecture_reasoning" && HIGH_CONSTRAINT_RE.test(input.query));
    const candidateLayers = this.resolveCandidateLayers(input.query, input.deterministicDecision, intent.primary, input.signals, sourceTraceRequired);
    const routePlan = this.buildRouteSteps(candidateLayers, input.signals, sourceTraceRequired, intent.primary);
    const activation = this.activationPolicy.decide(input.query, input.signals);
    const context = this.buildContextBudget(input.signals, sourceTraceRequired);
    const memoryWrite = this.buildMemoryWriteDecision(input.query, intent.primary, input.signals);
    const destructive = DESTRUCTIVE_RE.test(input.query);
    return {
      schemaVersion: "oms.llm_planner.plan.v1",
      runId: `planner-${this.hash(`${createdAt}:${input.query}:${input.deterministicDecision.route}`).slice(0, 16)}`,
      createdAt,
      activation,
      intent,
      retrieval: {
        strength: input.signals.retrievalStrength,
        sourceTraceRequired,
        candidateLayers,
        routePlan,
        progressive: candidateLayers.length > 1 || sourceTraceRequired,
        stopCondition: sourceTraceRequired
          ? "sufficient_source_backed_answer"
          : "enough_relevant_context_or_recent_tail",
      },
      context,
      memoryWrite,
      safety: {
        destructive,
        requiresDryRun: destructive,
        crossAgentAccess: "same_agent",
        markdownRuntimeFactSource: false,
        toolOutputAsSource: false,
        currentInstructionProtected: true,
        summaryOnlyFinalFactAllowed: input.signals.retrievalStrength !== "forensic",
      },
      explain: {
        shortReason: this.explainIntent(intent.primary, input.deterministicDecision.route, sourceTraceRequired),
        whyTheseLayers: routePlan.map((step) => `${step.layer}:${step.reason}`),
        expectedUserVisibleBehavior: sourceTraceRequired
          ? "Retrieve progressively and refuse to present an unsupported exact fact when source trace is insufficient."
          : "Use the cheapest relevant layer and keep current context protected.",
      },
      deterministic: {
        route: input.deterministicDecision.route,
        routePlan: input.deterministicDecision.routePlan,
        reason: input.deterministicDecision.reason,
      },
      fallback,
    };
  }

  private resolveFallback(
    input: LLMPlannerInput,
    activationMode: LlmPlannerPlan["activation"]["mode"],
  ): LlmPlannerPlan["fallback"] {
    if (activationMode !== "llm_planner") {
      return {
        from: "not_required",
        reason: "Planner was not required for this request; deterministic heuristic plan records the bypass decision.",
      };
    }
    if (input.signals.llmPlannerMode === "shadow") {
      return {
        from: "not_required",
        reason: "LLMPlanner shadow mode records planner diagnostics while keeping deterministic selection and without invoking the LLM caller.",
      };
    }
    return {
      from: "no_llm_caller",
      reason: "Planner path was selected, but no usable LLM caller was available; deterministic heuristic planner produced the executable plan.",
    };
  }

  private classifyIntent(
    query: string,
    signals: PlannerRuntimeSignals,
    deterministicRoute: RetrievalRoute,
  ): LlmPlannerPlan["intent"] {
    const primary = this.primaryIntent(query, signals, deterministicRoute);
    const alternatives = [
      {
        intent: primary,
        confidence: this.intentConfidence(query, signals, primary),
        evidence: this.intentEvidence(query, signals, deterministicRoute),
        ambiguity: this.intentAmbiguity(query, signals),
        userVisibleReason: this.explainPrimaryIntent(primary),
      },
    ];
    return {
      primary,
      alternatives,
      confidence: alternatives[0].confidence,
      ambiguity: alternatives[0].ambiguity,
      userLanguage: this.detectLanguage(query),
    };
  }

  private primaryIntent(
    query: string,
    signals: PlannerRuntimeSignals,
    deterministicRoute: RetrievalRoute,
  ): PlannerIntent {
    if (DESTRUCTIVE_RE.test(query)) return "destructive_operation";
    if (MEMORY_WRITE_RE.test(query)) return CORRECTION_RE.test(query) ? "correction" : "memory_write_candidate";
    if (CONFLICT_RE.test(query) && HISTORY_RE.test(query)) return "history_trace";
    if (DEBUG_RE.test(query)) return "debug_runtime";
    if (HIGH_CONSTRAINT_RE.test(query)) return "architecture_reasoning";
    if (signals.retrievalStrength === "strict" || signals.retrievalStrength === "forensic" || PRECISION_RE.test(query)) {
      return HISTORY_RE.test(query) ? "history_trace" : "precision_fact";
    }
    if (PROJECT_RE.test(query) || deterministicRoute === "project_registry") {
      if (/下一步|next step|next action|todo/i.test(query)) return "next_step";
      if (/阻塞|卡在哪|blocker|blocked/i.test(query)) return "blocker";
      return "project_state";
    }
    if (HISTORY_RE.test(query)) return "history_trace";
    if (/决策|decision/i.test(query)) return "decision";
    if (/约束|constraint|must|rule/i.test(query)) return "constraint";
    if (KNOWLEDGE_RE.test(query)) return "knowledge_export";
    if (CREATIVE_RE.test(query)) return "creative";
    if (/代码|实现|构建|架构|code|implement|architecture|build/i.test(query)) return "code_task";
    return "casual";
  }

  private resolveCandidateLayers(
    query: string,
    decision: RetrievalDecision,
    intent: PlannerIntent,
    signals: PlannerRuntimeSignals,
    sourceTraceRequired: boolean,
  ): PlannerCandidateLayer[] {
    const layers: PlannerCandidateLayer[] = [];
    const add = (layer: PlannerCandidateLayer) => {
      if (!layers.includes(layer)) layers.push(layer);
    };
    for (const route of decision.routePlan) {
      switch (route) {
        case "recent_tail":
          add("recent_tail");
          break;
        case "memory_item":
          add("memory_items");
          break;
        case "project_registry":
          add("project_registry");
          break;
        case "summary_tree":
          add("base_summaries");
          break;
        case "knowledge":
          add("knowledge_export_index");
          break;
        default:
          break;
      }
    }

    if (intent === "project_state" || intent === "next_step" || intent === "blocker") {
      if (signals.hasProjectRegistry) add("project_registry");
      if (signals.hasMemoryItemHits) add("memory_items");
      add("recent_tail");
    }
    if (intent === "history_trace" || intent === "precision_fact") {
      if (signals.hasMemoryItemHits) add("memory_items");
      if (signals.hasCompactedHistory) add("base_summaries");
      add("raw_sources");
    }
    if (sourceTraceRequired) {
      add("raw_sources");
    }
    if (this.shouldAddRagLayer(query, signals, intent)) {
      add("rag_candidates");
    }
    if (this.shouldAddGraphLayer(query, signals, intent)) {
      add("graph_neighbors");
    }
    if (this.shouldAddRerankLayer(signals, intent, sourceTraceRequired)) {
      add("rerank");
    }
    if (layers.length === 0) add("recent_tail");
    return layers;
  }

  private shouldAddRagLayer(queryHint: string, signals: PlannerRuntimeSignals, intent: PlannerIntent): boolean {
    if (signals.heavyRetrievalPolicy === "disabled" || signals.ragPlannerPolicy === "disabled") {
      return false;
    }
    const ragAvailable = signals.ragEnabled === true && signals.ragProvider !== "none";
    if (!ragAvailable) {
      return false;
    }
    return SEMANTIC_FUZZY_RE.test(queryHint) ||
      signals.queryComplexity === "high" ||
      intent === "history_trace" ||
      intent === "architecture_reasoning" ||
      Boolean(signals.candidateOverload);
  }

  private shouldAddGraphLayer(queryHint: string, signals: PlannerRuntimeSignals, intent: PlannerIntent): boolean {
    if (signals.heavyRetrievalPolicy === "disabled" || signals.graphPlannerPolicy === "disabled") {
      return false;
    }
    const graphAvailable = signals.graphEnabled === true && signals.graphProvider !== "none";
    if (!graphAvailable) {
      return false;
    }
    return GRAPH_RELATION_RE.test(queryHint) ||
      intent === "history_trace" ||
      intent === "architecture_reasoning" ||
      intent === "decision" ||
      intent === "constraint" ||
      Boolean(signals.candidateOverload);
  }

  private shouldAddRerankLayer(
    signals: PlannerRuntimeSignals,
    intent: PlannerIntent,
    sourceTraceRequired: boolean,
  ): boolean {
    if (signals.rerankPlannerPolicy === "disabled") {
      return false;
    }
    const threshold = signals.candidateRerankThreshold ?? 20;
    const overloaded = Boolean(signals.candidateOverload) ||
      (signals.estimatedCandidateCount ?? 0) >= threshold;
    return overloaded ||
      signals.rerankPlannerPolicy === "candidate_overload_required" && (
        signals.queryComplexity === "high" ||
        Boolean(signals.candidateOverload) ||
        intent === "architecture_reasoning" ||
        intent === "history_trace"
      );
  }

  private buildRouteSteps(
    layers: PlannerCandidateLayer[],
    signals: PlannerRuntimeSignals,
    sourceTraceRequired: boolean,
    intent: PlannerIntent,
  ): PlannerRouteStep[] {
    const budget = Math.max(256, Math.floor(signals.totalBudget * (sourceTraceRequired ? 0.035 : 0.015)));
    const steps: PlannerRouteStep[] = layers.map((layer, index) => ({
      layer,
      action: this.routeActionForLayer(layer),
      order: index + 1,
      budgetTokens: Math.max(128, Math.floor(budget / Math.max(layers.length, 1))),
      reason: this.layerReason(layer, intent, sourceTraceRequired),
      stopIf: index === layers.length - 1
        ? "route_exhausted"
        : sourceTraceRequired
          ? "verified_source_trace_sufficient"
          : "sufficient_relevant_context",
    }));
    if (sourceTraceRequired) {
      steps.push({
        layer: "raw_sources",
        action: "verify",
        order: steps.length + 1,
        reason: "Verifier must confirm source-backed evidence before final fact presentation.",
        stopIf: "source_verification_passed",
      });
    }
    return steps;
  }

  private routeActionForLayer(layer: PlannerCandidateLayer): PlannerRouteStep["action"] {
    switch (layer) {
      case "raw_sources":
      case "graph_neighbors":
        return "expand";
      case "rerank":
        return "order";
      default:
        return "retrieve";
    }
  }

  private buildContextBudget(signals: PlannerRuntimeSignals, sourceTraceRequired: boolean): ContextBudgetIntent {
    const total = Math.max(512, Math.floor(signals.totalBudget * (sourceTraceRequired ? 0.06 : 0.035)));
    return {
      totalRequestedTokens: total,
      protectRecentTail: true,
      minimumRecentTailTokens: Math.max(256, Math.floor(signals.totalBudget * 0.05)),
      preferredSplits: {
        stablePrefix: Math.floor(total * 0.12),
        recentTail: Math.floor(total * 0.35),
        memoryItems: Math.floor(total * 0.18),
        summaries: Math.floor(total * 0.18),
        rawEvidence: sourceTraceRequired ? Math.floor(total * 0.12) : Math.floor(total * 0.05),
        reserve: Math.floor(total * 0.1),
      },
      reason: "Protect current conversation first, then allocate retrieval budget according to evidence sensitivity.",
    };
  }

  private buildMemoryWriteDecision(
    query: string,
    intent: PlannerIntent,
    signals: PlannerRuntimeSignals,
  ): MemoryWriteDecision {
    if (!signals.memoryItemEnabled || signals.emergencyBrake) {
      return {
        allowed: false,
        candidateKinds: [],
        reason: "MemoryItem writes are disabled by config or emergency brake.",
        requiredSourceRefs: true,
        reviewRequired: true,
      };
    }
    if (intent === "memory_write_candidate" || intent === "correction") {
      return {
        allowed: true,
        candidateKinds: intent === "correction" ? ["correction"] : ["preference", "constraint", "principle"],
        reason: "User wording indicates a durable preference, correction, or rule.",
        requiredSourceRefs: true,
        reviewRequired: true,
      };
    }
    if (/决策|decision/i.test(query)) {
      return {
        allowed: true,
        candidateKinds: ["decision"],
        reason: "User is discussing a durable decision.",
        requiredSourceRefs: true,
        reviewRequired: true,
      };
    }
    return {
      allowed: false,
      candidateKinds: [],
      reason: "No durable memory write signal detected.",
      requiredSourceRefs: true,
      reviewRequired: true,
    };
  }

  private mergeLlmHints(basePlan: LlmPlannerPlan, parsed: Record<string, unknown>): LlmPlannerPlan {
    const intentRecord = this.asRecord(parsed.intent);
    const retrievalRecord = this.asRecord(parsed.retrieval);
    const memoryWriteRecord = this.asRecord(parsed.memoryWrite);
    const explainRecord = this.asRecord(parsed.explain);
    const primary = this.asPlannerIntent(intentRecord.primary) ?? basePlan.intent.primary;
    const confidence = this.asNumber(intentRecord.confidence) ?? basePlan.intent.confidence;
    const candidateLayers = this.asCandidateLayerArray(retrievalRecord.candidateLayers) ?? basePlan.retrieval.candidateLayers;
    const sourceTraceRequired = typeof retrievalRecord.sourceTraceRequired === "boolean"
      ? retrievalRecord.sourceTraceRequired
      : basePlan.retrieval.sourceTraceRequired;
    return {
      ...basePlan,
      intent: {
        ...basePlan.intent,
        primary,
        confidence,
        alternatives: [{
          intent: primary,
          confidence,
          evidence: ["llm_planner_json"],
          ambiguity: this.asStringArray(intentRecord.ambiguity) ?? basePlan.intent.ambiguity,
          userVisibleReason: this.asString(explainRecord.shortReason) ?? basePlan.intent.alternatives[0]?.userVisibleReason ?? "",
        }],
        ambiguity: this.asStringArray(intentRecord.ambiguity) ?? basePlan.intent.ambiguity,
      },
      retrieval: {
        ...basePlan.retrieval,
        sourceTraceRequired,
        candidateLayers,
        routePlan: this.buildRouteSteps(candidateLayers, {
          ...basePlanToSignals(basePlan),
          retrievalStrength: basePlan.retrieval.strength,
        }, sourceTraceRequired, primary),
        progressive: typeof retrievalRecord.progressive === "boolean"
          ? retrievalRecord.progressive
          : basePlan.retrieval.progressive,
        stopCondition: this.asString(retrievalRecord.stopCondition) ?? basePlan.retrieval.stopCondition,
      },
      memoryWrite: {
        ...basePlan.memoryWrite,
        allowed: typeof memoryWriteRecord.allowed === "boolean" ? memoryWriteRecord.allowed : basePlan.memoryWrite.allowed,
        reason: this.asString(memoryWriteRecord.reason) ?? basePlan.memoryWrite.reason,
      },
      explain: {
        ...basePlan.explain,
        shortReason: this.asString(explainRecord.shortReason) ?? basePlan.explain.shortReason,
        whyTheseLayers: this.asStringArray(explainRecord.whyTheseLayers) ?? basePlan.explain.whyTheseLayers,
      },
      fallback: undefined,
    };
  }

  private parsePlannerJson(raw: string): Record<string, unknown> | null {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return this.asRecord(parsed);
    } catch {
      return null;
    }
  }

  private intentConfidence(query: string, signals: PlannerRuntimeSignals, intent: PlannerIntent): number {
    let score = 0.62;
    if (signals.retrievalStrength === "strict" || signals.retrievalStrength === "forensic") score += 0.12;
    if (signals.hasMemoryItemHits || signals.hasProjectRegistry || signals.hasCompactedHistory) score += 0.08;
    if (PRECISION_RE.test(query) || HISTORY_RE.test(query) || PROJECT_RE.test(query)) score += 0.1;
    if (intent === "casual") score = 0.72;
    return Math.min(0.98, score);
  }

  private intentEvidence(query: string, signals: PlannerRuntimeSignals, deterministicRoute: RetrievalRoute): string[] {
    return [
      `deterministic_route:${deterministicRoute}`,
      `retrieval_strength:${signals.retrievalStrength}`,
      ...(PRECISION_RE.test(query) ? ["precision_terms"] : []),
      ...(HISTORY_RE.test(query) ? ["history_reference"] : []),
      ...(PROJECT_RE.test(query) ? ["project_state_terms"] : []),
      ...(signals.hasCompactedHistory ? ["compacted_history_available"] : []),
      ...(signals.hasMemoryItemHits ? ["memory_item_hits_available"] : []),
      ...(signals.hasProjectRegistry ? ["project_registry_available"] : []),
    ];
  }

  private intentAmbiguity(query: string, signals: PlannerRuntimeSignals): string[] {
    return [
      ...(IMPLICIT_ONLY_RE.test(query) ? ["implicit_reference_requires_context"] : []),
      ...(signals.recentAssistantUncertainty ? ["recent_assistant_uncertainty"] : []),
      ...(signals.queryComplexity === "high" ? ["high_complexity"] : []),
    ];
  }

  private explainIntent(intent: PlannerIntent, route: RetrievalRoute, sourceTraceRequired: boolean): string {
    return `${intent} intent selected from deterministic route ${route}; sourceTraceRequired=${sourceTraceRequired}.`;
  }

  private explainPrimaryIntent(intent: PlannerIntent): string {
    switch (intent) {
      case "precision_fact":
        return "The request asks for an exact factual value.";
      case "history_trace":
        return "The request points back to earlier conversation and needs traceable recall.";
      case "project_state":
      case "next_step":
      case "blocker":
        return "The request asks about current project state.";
      case "memory_write_candidate":
      case "correction":
        return "The request may create or update durable memory.";
      default:
        return `The request is classified as ${intent}.`;
    }
  }

  private layerReason(layer: PlannerCandidateLayer, intent: PlannerIntent, sourceTraceRequired: boolean): string {
    switch (layer) {
      case "recent_tail":
        return "Protect and consult current conversation before older memory.";
      case "memory_items":
        return "Check canonical durable memory candidates and current project state.";
      case "project_registry":
        return "Structured project registry can answer status/next-step/blocker intent.";
      case "base_summaries":
        return "Use BaseSummary as a navigation map into older source.";
      case "raw_sources":
        return sourceTraceRequired
          ? "Raw source trace is required before final exact/strict/forensic answer."
          : "Raw source can expand a summary or memory hint if needed.";
      case "knowledge_export_index":
        return "Knowledge/Markdown index is export-only and advisory, never runtime fact authority.";
      case "rag_candidates":
        return "RAG lane may discover semantic candidates for fuzzy intent; candidates remain non-authoritative until source verified.";
      case "graph_neighbors":
        return "Graph lane may expand provenance, dependency, and multi-hop relation candidates; candidates remain non-authoritative.";
      case "rerank":
        return "Candidate pool is large, ambiguous, or strict enough that ordering must happen before final context selection.";
      default:
        return `Layer selected for ${intent}.`;
    }
  }

  private detectLanguage(query: string): "zh" | "en" | "mixed" | "unknown" {
    const hasZh = /[\u4e00-\u9fff]/.test(query);
    const hasEn = /[a-z]/i.test(query);
    if (hasZh && hasEn) return "mixed";
    if (hasZh) return "zh";
    if (hasEn) return "en";
    return "unknown";
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  }

  private asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  private asStringArray(value: unknown): string[] | undefined {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : undefined;
  }

  private asPlannerIntent(value: unknown): PlannerIntent | undefined {
    return typeof value === "string" && PLANNER_INTENTS.includes(value as PlannerIntent)
      ? value as PlannerIntent
      : undefined;
  }

  private asCandidateLayerArray(value: unknown): PlannerCandidateLayer[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const layers = value.filter((item): item is PlannerCandidateLayer =>
      typeof item === "string" && PLANNER_LAYERS.includes(item as PlannerCandidateLayer),
    );
    return layers.length > 0 ? [...new Set(layers)] : undefined;
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}

const IMPLICIT_ONLY_RE = /(刚才|之前|前面|那个|这个|earlier|previous|that)/i;

const PLANNER_INTENTS: PlannerIntent[] = [
  "casual",
  "current_turn_instruction",
  "precision_fact",
  "history_trace",
  "project_state",
  "next_step",
  "blocker",
  "preference",
  "decision",
  "constraint",
  "correction",
  "debug_runtime",
  "code_task",
  "architecture_reasoning",
  "creative",
  "knowledge_export",
  "memory_write_candidate",
  "destructive_operation",
  "meta_question",
];

const PLANNER_LAYERS: PlannerCandidateLayer[] = [
  "recent_tail",
  "memory_items",
  "project_registry",
  "base_summaries",
  "raw_sources",
  "knowledge_export_index",
  "rag_candidates",
  "graph_neighbors",
  "rerank",
];

function basePlanToSignals(plan: LlmPlannerPlan): PlannerRuntimeSignals {
  return {
    retrievalStrength: plan.retrieval.strength,
    llmPlannerMode: plan.activation.mode === "bypass" ? "auto" : "auto",
    hasLlmCaller: plan.activation.llmInvoked,
    hasCompactedHistory: plan.retrieval.candidateLayers.includes("base_summaries"),
    hasProjectRegistry: plan.retrieval.candidateLayers.includes("project_registry"),
    hasMemoryItemHits: plan.retrieval.candidateLayers.includes("memory_items"),
    hasKnowledgeHits: plan.retrieval.candidateLayers.includes("knowledge_export_index"),
    hasKnowledgeRawHint: false,
    recentAssistantUncertainty: false,
    queryComplexity: "medium",
    referencesCurrentWork: plan.intent.primary === "project_state",
    autoRecallEnabled: true,
    emergencyBrake: false,
    memoryItemEnabled: plan.memoryWrite.allowed,
    totalBudget: Math.max(plan.context.totalRequestedTokens, 4096),
    llmPlannerModel: undefined,
    heavyRetrievalPolicy: "planner_only",
    ragPlannerPolicy: "planner_only",
    graphPlannerPolicy: "planner_only",
    rerankPlannerPolicy: "candidate_overload_required",
    graphEnabled: plan.retrieval.candidateLayers.includes("graph_neighbors"),
    ragEnabled: plan.retrieval.candidateLayers.includes("rag_candidates"),
    rerankEnabled: plan.retrieval.candidateLayers.includes("rerank"),
    graphProvider: plan.retrieval.candidateLayers.includes("graph_neighbors") ? "sqlite_graph" : "none",
    ragProvider: plan.retrieval.candidateLayers.includes("rag_candidates") ? "sqlite_vec" : "none",
    rerankProvider: plan.retrieval.candidateLayers.includes("rerank") ? "deterministic" : "none",
    candidateRerankThreshold: 20,
    laneCandidateRerankThreshold: 10,
    candidateAmbiguityMargin: 0.08,
    strictModeRequiresRerankOnConflict: true,
  };
}
