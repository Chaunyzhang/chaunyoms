export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface RawMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  turnNumber: number;
  createdAt: string;
  tokenCount: number;
  compacted: boolean;
  metadata?: Record<string, unknown>;
}

export interface SummaryEntry {
  id: string;
  sessionId: string;
  summary: string;
  keywords: string[];
  toneTag: string;
  startTurn: number;
  endTurn: number;
  tokenCount: number;
  createdAt: string;
  sourceHash?: string;
  sourceMessageCount?: number;
}

export interface ContextBudget {
  totalBudget: number;
  availableBudget: number;
  stablePrefixBudget: number;
  recentTailBudget: number;
  summaryBudget: number;
  recallBudget: number;
  reserveBudget: number;
}

export interface ContextItem {
  kind: "message" | "summary";
  tokenCount: number;
  turnNumber?: number;
  summaryId?: string;
  role?: MessageRole;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SummaryResult {
  summary: string;
  keywords: string[];
  toneTag: string;
}

export interface CompactionCandidate {
  startTurn: number;
  endTurn: number;
  messages: RawMessage[];
}

export interface LoggerLike {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

export interface LlmCallParams {
  model?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: "json" | "text";
}

export interface LlmCaller {
  call(params: LlmCallParams): Promise<string>;
}

export interface BridgeConfig {
  dataDir: string;
  sessionId: string;
  workspaceDir: string;
  sharedDataDir: string;
  contextWindow: number;
  contextThreshold: number;
  freshTailTokens: number;
  maxFreshTailTurns: number;
  compactionBatchTurns: number;
  summaryModel?: string;
  summaryMaxOutputTokens: number;
}

export interface RecallResult {
  items: ContextItem[];
  consumedTokens: number;
}

export type RetrievalRoute =
  | "recent_tail"
  | "navigation"
  | "dag"
  | "shared_insights"
  | "knowledge_base"
  | "vector_search";

export interface RetrievalDecision {
  route: RetrievalRoute;
  reason: string;
  requiresEmbeddings: boolean;
  requiresSourceRecall: boolean;
  canAnswerDirectly: boolean;
}
