import { BridgeConfig, MessageRole } from "../types";

export interface EvalSeedKnowledgeDraft {
  id: string;
  bucket: "decisions" | "patterns" | "facts" | "incidents";
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  canonicalKey: string;
  body: string;
  status: "active" | "draft";
}

export interface EvalExplicitMessage {
  role: Extract<MessageRole, "user" | "assistant">;
  content: string;
}

export interface EvalGeneratedScenario {
  kind: "marker_replay";
  turns: number;
  markers: Array<{
    turn: number;
    text: string;
  }>;
  fillerPrefix?: string;
}

export interface EvalExpected {
  mustInclude?: string[];
  mustNotInclude?: string[];
  detailEquals?: Record<string, string | boolean | number | undefined>;
  requireSourceVerified?: boolean;
  minSummaryCount?: number;
  requireBranchSummary?: boolean;
}

export interface EvalCaseDefinition {
  id: string;
  title: string;
  description: string;
  tags: string[];
  mode: "retrieve" | "route";
  query: string;
  messages?: EvalExplicitMessage[];
  generatedScenario?: EvalGeneratedScenario;
  afterTurnEvery?: number;
  configOverrides?: Partial<BridgeConfig>;
  seedKnowledge?: EvalSeedKnowledgeDraft[];
  expected: EvalExpected;
}

export interface EvalSuiteDefinition {
  suiteId: string;
  title: string;
  description: string;
  cases: EvalCaseDefinition[];
}

export interface EvalCaseResult {
  id: string;
  title: string;
  tags: string[];
  passed: boolean;
  latencyMs: number;
  outputText: string;
  matchedIncludes: string[];
  violatedExcludes: string[];
  sourceVerified: boolean;
  summaryCount: number;
  branchCount: number;
  details: Record<string, unknown>;
  failures: string[];
}

export interface EvalAggregateMetrics {
  totalCases: number;
  passedCases: number;
  passRate: number;
  routeAccuracyRate: number;
  exactFactRecoveryRate: number;
  sourceVerificationRate: number;
  knowledgeUpdateSuccessRate: number;
  projectStateSuccessRate: number;
  abstentionSuccessRate: number;
  falseRecallRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface EvalSuiteReport {
  suiteId: string;
  title: string;
  description: string;
  generatedAt: string;
  metrics: EvalAggregateMetrics;
  results: EvalCaseResult[];
}
