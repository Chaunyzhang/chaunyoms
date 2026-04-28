import {
  MemoryItemKind,
  RetrievalRoute,
  RetrievalStrength,
} from "../types";

export type PlannerIntent =
  | "casual"
  | "current_turn_instruction"
  | "precision_fact"
  | "history_trace"
  | "project_state"
  | "next_step"
  | "blocker"
  | "preference"
  | "decision"
  | "constraint"
  | "correction"
  | "debug_runtime"
  | "code_task"
  | "architecture_reasoning"
  | "creative"
  | "knowledge_export"
  | "memory_write_candidate"
  | "destructive_operation"
  | "meta_question";

export type PlannerActivationMode =
  | "bypass"
  | "deterministic_fast_path"
  | "llm_planner";

export type PlannerCandidateLayer =
  | "recent_tail"
  | "memory_items"
  | "project_registry"
  | "base_summaries"
  | "raw_sources"
  | "knowledge_export_index";

export type PlannerRouteAction =
  | "probe"
  | "retrieve"
  | "expand"
  | "verify"
  | "stop";

export type PlannerFallbackRoute =
  | "deterministic_router"
  | "recent_tail"
  | "safe_no_answer";

export interface IntentHypothesis {
  intent: PlannerIntent;
  confidence: number;
  evidence: string[];
  ambiguity: string[];
  userVisibleReason: string;
}

export interface PlannerActivationDecision {
  mode: PlannerActivationMode;
  reason: string;
  llmInvoked: boolean;
  triggers: string[];
}

export interface PlannerRuntimeSignals {
  retrievalStrength: RetrievalStrength;
  llmPlannerMode: "off" | "shadow" | "auto";
  hasLlmCaller: boolean;
  hasCompactedHistory: boolean;
  hasProjectRegistry: boolean;
  hasMemoryItemHits: boolean;
  hasKnowledgeHits: boolean;
  hasKnowledgeRawHint: boolean;
  recentAssistantUncertainty: boolean;
  queryComplexity: "low" | "medium" | "high";
  referencesCurrentWork: boolean;
  matchedProjectId?: string;
  matchedProjectTitle?: string;
  autoRecallEnabled: boolean;
  emergencyBrake: boolean;
  memoryItemEnabled: boolean;
  totalBudget: number;
  llmPlannerModel?: string;
}

export interface ContextBudgetIntent {
  totalRequestedTokens: number;
  protectRecentTail: boolean;
  minimumRecentTailTokens: number;
  preferredSplits: {
    stablePrefix?: number;
    recentTail?: number;
    memoryItems?: number;
    summaries?: number;
    rawEvidence?: number;
    reserve?: number;
  };
  reason: string;
}

export interface MemoryWriteDecision {
  allowed: boolean;
  candidateKinds: MemoryItemKind[];
  reason: string;
  requiredSourceRefs: boolean;
  reviewRequired: boolean;
}

export interface PlannerRouteStep {
  layer: PlannerCandidateLayer;
  action: PlannerRouteAction;
  budgetTokens?: number;
  reason: string;
  stopIf?: string;
}

export interface LlmPlannerPlan {
  schemaVersion: "oms.llm_planner.plan.v1";
  runId: string;
  createdAt: string;
  activation: PlannerActivationDecision;
  intent: {
    primary: PlannerIntent;
    alternatives: IntentHypothesis[];
    confidence: number;
    ambiguity: string[];
    userLanguage: "zh" | "en" | "mixed" | "unknown";
  };
  retrieval: {
    strength: RetrievalStrength;
    sourceTraceRequired: boolean;
    candidateLayers: PlannerCandidateLayer[];
    routePlan: PlannerRouteStep[];
    progressive: boolean;
    stopCondition: string;
  };
  context: ContextBudgetIntent;
  memoryWrite: MemoryWriteDecision;
  safety: {
    destructive: boolean;
    requiresDryRun: boolean;
    crossAgentAccess: "none" | "same_agent" | "shared_principles_only" | "blocked";
    markdownRuntimeFactSource: false;
    toolOutputAsSource: false;
    currentInstructionProtected: boolean;
    summaryOnlyFinalFactAllowed: boolean;
  };
  explain: {
    shortReason: string;
    whyTheseLayers: string[];
    expectedUserVisibleBehavior: string;
  };
  deterministic: {
    route: RetrievalRoute;
    routePlan: RetrievalRoute[];
    reason: string;
  };
  fallback?: {
    reason: string;
    from: "llm_error" | "invalid_json" | "validator_repair" | "no_llm_caller" | "not_required";
  };
}

export interface PlanValidationViolation {
  code: string;
  severity: "error" | "warning";
  message: string;
  repair?: string;
}

export interface PlanValidationResult {
  accepted: boolean;
  repaired: boolean;
  violations: PlanValidationViolation[];
  executablePlan?: LlmPlannerPlan;
  fallbackRoute?: PlannerFallbackRoute;
}
