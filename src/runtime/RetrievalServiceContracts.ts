import type { ContextPlannerResult } from "../engines/ContextPlanner";
import type { EvidenceAnswerResolution } from "../resolvers/EvidenceAnswerResolver";
import type { RerankAudit } from "../retrieval/RetrievalEnhancementProviders";
import type { RetrievalVerificationResult } from "../retrieval/RetrievalVerifier";
import type {
  AnswerCandidate,
  ContextItem,
  EvidenceAtomEntry,
  MemoryItemEntry,
  ProgressiveRetrievalStepRecord,
  ProjectRecord,
  RecallResult,
  RetrievalDecision,
  SummaryEntry,
  DagTraversalStep,
  SourceTrace,
} from "../types";
import type { RuntimeEnhancementSearchResult } from "../data/SQLiteRuntimeStore";

export interface ToolResponse {
  content: Array<Record<string, unknown>>;
  details: Record<string, unknown>;
}

export interface SemanticExpansionResult {
  candidates: import("../types").SemanticCandidate[];
  memoryItemHits: MemoryItemEntry[];
  summaryHits: SummaryEntry[];
  projectHit: ProjectRecord | null;
  ragSearch?: RuntimeEnhancementSearchResult;
  graphSearch?: RuntimeEnhancementSearchResult;
}

export interface RecallPresentationOptions {
  maxItems: number;
  maxCharsPerItem: number;
  includeFullTrace: boolean;
}

export interface EvidenceGateResult {
  status: "sufficient" | "needs_expansion" | "insufficient";
  reason: string;
  atomHitCount: number;
  usableAtomCount: number;
  verifiedTraceCount: number;
  recommendedAction: "answer" | "expand_l1" | "trace_raw" | "no_answer";
  nextActionHint?: string;
  targetIds: string[];
}

export interface AtomEvidenceHealth {
  atomHitCount: number;
  usableAtomCount: number;
  blockedReasons: string[];
}

export type RecallLayer = "atom" | "summary" | "raw";

export interface RetrievalBudgetPlan {
  total: number;
  atom: number;
  summary: number;
  raw: number;
  perItem: {
    atom: number;
    summary: number;
    raw: number;
  };
}

export interface RecallTextDiagnostics {
  retrievalBudget?: RetrievalBudgetPlan;
  persistentEvidenceAtomHitCount?: number;
  transientEvidenceAtomHitCount?: number;
  retrievalVerification?: RetrievalVerificationResult;
  evidenceAnswer?: EvidenceAnswerResolution;
}

export interface PlannerAuditContext {
  query: string;
  decision: RetrievalDecision;
  planned?: {
    plan: ContextPlannerResult;
    items: ContextItem[];
  };
  recallResult?: RecallResult;
  retrievalVerification?: RetrievalVerificationResult;
  evidenceGate?: EvidenceGateResult;
  rerankAudit?: RerankAudit;
  timings?: Record<string, number>;
}

export interface RetrievalBlockedDiagnostics {
  retrievalBudget: RetrievalBudgetPlan;
  persistentEvidenceAtomHitCount: number;
  transientEvidenceAtomHitCount: number;
}

export interface RetrievalVerifierBlockedResponseArgs {
  query: string;
  decision: RetrievalDecision;
  recallResult: RecallResult;
  retrievalVerification: RetrievalVerificationResult;
  evidenceGate: EvidenceGateResult;
  diagnostics: RetrievalBlockedDiagnostics;
  progressiveRetrievalSteps: ProgressiveRetrievalStepRecord[];
}

export interface RecallTextArgs {
  query: string;
  items: ContextItem[];
  sourceTrace?: Array<{
    summaryId?: string;
    strategy: string;
    verified: boolean;
    resolvedMessageCount: number;
  }>;
  answerCandidates?: AnswerCandidate[];
  presentation?: RecallPresentationOptions;
  evidenceGate?: EvidenceGateResult;
  diagnostics?: RecallTextDiagnostics;
}

export interface PersistentEvidenceMergeResultArgs {
  result: RecallResult;
  atoms: EvidenceAtomEntry[];
  recallBudget: number;
}

export interface CompactTraceArgs {
  sourceTrace: SourceTrace[];
}

export interface CompactDagTraceArgs {
  dagTrace: DagTraversalStep[];
}
