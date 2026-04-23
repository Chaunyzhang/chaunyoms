export type MessageRole = "system" | "user" | "assistant" | "tool";
export type RecordStatus = "active" | "superseded" | "archived";
export type SummaryNodeKind = "leaf" | "branch";
export type SummaryMemoryType =
  | "project_state"
  | "decision"
  | "constraint"
  | "diagnostic"
  | "preference"
  | "feedback"
  | "temporary_note"
  | "general";
export type SummaryPhase =
  | "planning"
  | "implementation"
  | "validation"
  | "fixing"
  | "review"
  | "active";
export type PromotionIntent =
  | "navigation_only"
  | "candidate"
  | "promote"
  | "priority_promote";

export interface RawMessage {
  id: string;
  sessionId: string;
  agentId?: string;
  role: MessageRole;
  content: string;
  turnNumber: number;
  sequence?: number;
  createdAt: string;
  tokenCount: number;
  compacted: boolean;
  metadata?: Record<string, unknown>;
}

export interface RawMessageRepository {
  init(): Promise<void>;
  append(message: RawMessage): Promise<void>;
  getAll(): RawMessage[];
  getByRange(startTurn: number, endTurn: number): RawMessage[];
  getByIds(ids: string[]): RawMessage[];
  getBySequenceRange(startSequence: number, endSequence: number): RawMessage[];
  getRecentTail(turnCount: number): RawMessage[];
  getRecentTailByTokens(tokenBudget: number, maxTurns: number): RawMessage[];
  totalUncompactedTokens(): number;
  getUncompactedMessages(): RawMessage[];
  markCompacted(startTurn: number, endTurn: number): Promise<void>;
}

export interface ObservationEntry {
  id: string;
  sessionId: string;
  agentId?: string;
  role: MessageRole;
  classification: string;
  content: string;
  sourceKey: string;
  createdAt: string;
  tokenCount: number;
  metadata?: Record<string, unknown>;
}

export interface ObservationRepository {
  init(): Promise<void>;
  append(entry: ObservationEntry): Promise<void>;
  getAll(): ObservationEntry[];
  count(): number;
}

export interface DurableMemoryEntry {
  id: string;
  eventId?: string;
  sessionId: string;
  agentId?: string;
  projectId?: string;
  topicId?: string;
  kind: "user_fact" | "assistant_decision" | "project_state" | "solution" | "diagnostic" | "constraint";
  recordStatus?: RecordStatus;
  supersededById?: string;
  text: string;
  fingerprint: string;
  tags: string[];
  createdAt: string;
  sourceType: "raw_message" | "observation" | "snapshot";
  sourceIds: string[];
  sourceSequenceMin?: number;
  sourceSequenceMax?: number;
  sourceStartTimestamp?: string;
  sourceEndTimestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface DurableMemoryRepository {
  init(): Promise<void>;
  addEntries(entries: DurableMemoryEntry[]): Promise<number>;
  replaceAll(entries: DurableMemoryEntry[]): Promise<void>;
  search(query: string, limit?: number): DurableMemoryEntry[];
  getAll(): DurableMemoryEntry[];
  count(): number;
}

export interface SummaryEntry {
  id: string;
  eventId?: string;
  sessionId: string;
  agentId?: string;
  projectId?: string;
  topicId?: string;
  recordStatus?: RecordStatus;
  supersededById?: string;
  summary: string;
  keywords: string[];
  toneTag: string;
  memoryType?: SummaryMemoryType;
  phase?: SummaryPhase;
  constraints: string[];
  decisions: string[];
  blockers: string[];
  nextSteps?: string[];
  keyEntities?: string[];
  exactFacts: string[];
  promotionIntent?: PromotionIntent;
  startTurn: number;
  endTurn: number;
  sourceFirstMessageId?: string;
  sourceLastMessageId?: string;
  sourceMessageIds?: string[];
  sourceStartTimestamp?: string;
  sourceEndTimestamp?: string;
  sourceSequenceMin?: number;
  sourceSequenceMax?: number;
  sourceSummaryIds?: string[];
  parentSummaryId?: string;
  childSummaryIds?: string[];
  summaryLevel?: number;
  nodeKind?: SummaryNodeKind;
  tokenCount: number;
  createdAt: string;
  sourceHash?: string;
  sourceMessageCount?: number;
}

export interface SummaryRepository {
  init(): Promise<void>;
  addSummary(entry: SummaryEntry): Promise<boolean>;
  upsertSummary(entry: SummaryEntry): Promise<void>;
  getAllSummaries(): SummaryEntry[];
  getActiveSummaries(): SummaryEntry[];
  getRootSummaries(): SummaryEntry[];
  getCoveredTurns(): Set<number>;
  findBySourceCoverage(
    startTurn: number,
    endTurn: number,
    sourceHash?: string,
    sourceMessageCount?: number,
  ): SummaryEntry | null;
  search(query: string): SummaryEntry[];
  getTotalTokens(): number;
  attachParent(parentSummaryId: string, childSummaryIds: string[]): Promise<void>;
}

export interface ProjectRecord {
  id: string;
  agentId: string;
  canonicalKey: string;
  title: string;
  status: "active" | "blocked" | "planned" | "archived";
  summary: string;
  activeFocus: string;
  currentDecision: string;
  nextStep: string;
  todo: string;
  blocker: string;
  risk: string;
  tags: string[];
  sourceSessionIds: string[];
  summaryIds: string[];
  memoryIds: string[];
  topicIds: string[];
  latestSummaryId?: string;
  updatedAt: string;
  createdAt: string;
}

export interface ProjectRegistryRepository {
  init(): Promise<void>;
  upsert(project: ProjectRecord): Promise<ProjectRecord>;
  reconcileProjects(projects: ProjectRecord[]): Promise<void>;
  getAll(): ProjectRecord[];
  findById(id: string): ProjectRecord | null;
  findByCanonicalKey(canonicalKey: string): ProjectRecord | null;
}

export type KnowledgeDocBucket = "decisions" | "patterns" | "facts" | "incidents";

export interface KnowledgePromotionDraft {
  shouldWrite: boolean;
  reason: string;
  bucket: KnowledgeDocBucket;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  canonicalKey: string;
  body: string;
  status: "active" | "draft";
}

export interface KnowledgeDocVersionRecord {
  version: number;
  docId: string;
  fileName: string;
  createdAt: string;
  contentHash: string;
  summaryEntryId: string;
}

export interface KnowledgeDocumentIndexEntry {
  docId: string;
  slug: string;
  bucket: KnowledgeDocBucket;
  title: string;
  latestVersion: number;
  latestFile: string;
  summary: string;
  tags: string[];
  canonicalKey: string;
  status: "active" | "draft" | "superseded";
  updatedAt: string;
  versions: KnowledgeDocVersionRecord[];
}

export interface PromotionLedgerEntry {
  id: string;
  sessionId: string;
  summaryEntryId: string;
  sourceHash?: string;
  sourceMessageCount?: number;
  startTurn: number;
  endTurn: number;
  status: "promoted" | "duplicate" | "skipped";
  reason: string;
  promptVersion: string;
  createdAt: string;
  docId?: string;
  slug?: string;
  version?: number;
  filePath?: string;
}

export interface KnowledgePromotionResult {
  status: "promoted" | "duplicate" | "skipped";
  reason: string;
  draft?: KnowledgePromotionDraft;
  docId?: string;
  slug?: string;
  version?: number;
  filePath?: string;
}

export interface KnowledgeRepository {
  init(): Promise<void>;
  getBaseDir(): string;
  findPromotion(summary: SummaryEntry): PromotionLedgerEntry | null;
  searchRelatedDocuments(query: string, limit?: number): KnowledgeDocumentIndexEntry[];
  writePromotion(
    summary: SummaryEntry,
    draft: KnowledgePromotionDraft,
    metadata: {
      sessionId: string;
      sourceHash?: string;
      sourceMessageCount?: number;
      promptVersion: string;
      modelName?: string;
    },
  ): Promise<KnowledgePromotionResult>;
}

export interface ExternalKnowledgeCapabilities {
  read: boolean;
  write: boolean;
  supportsVersions: boolean;
  supportsBacklinks: boolean;
}

export interface ExternalKnowledgeHit {
  providerId: string;
  sourceKind: "external";
  title: string;
  summary: string;
  tags: string[];
  canonicalKey?: string;
  filePath?: string;
  score?: number;
}

export interface ExternalKnowledgeProvider {
  id: string;
  init(): Promise<void>;
  describeCapabilities(): ExternalKnowledgeCapabilities;
  search(query: string, limit?: number): Promise<ExternalKnowledgeHit[]> | ExternalKnowledgeHit[];
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

export interface PrefixRouteHit {
  kind: "navigation" | "shared_insights" | "knowledge_base";
  filePath?: string;
  title: string;
  content: string;
}

export interface FixedPrefixProvider {
  load(sharedDataDir: string, workspaceDir: string, budget: number): Promise<ContextItem[]>;
  getSharedInsightHit(sharedDataDir: string, query: string): Promise<PrefixRouteHit | null>;
  getKnowledgeBaseHit(sharedDataDir: string, query: string): Promise<PrefixRouteHit | null>;
  hasSharedInsightHint(sharedDataDir: string, query: string): Promise<boolean>;
  hasKnowledgeBaseTopicHit(sharedDataDir: string, query: string): Promise<boolean>;
}

export interface NavigationRepository {
  getNavigationHit(workspaceDir: string, query: string): Promise<PrefixRouteHit | null>;
  getNavigationStateHit(workspaceDir: string, query: string): Promise<PrefixRouteHit | null>;
  hasNavigationHint(workspaceDir: string, query: string): Promise<boolean>;
  hasStructuredNavigationState(workspaceDir: string): Promise<boolean>;
  writeNavigationSnapshot(workspaceDir: string, content: string): Promise<{ written: boolean; filePath?: string }>;
}

export interface SummaryResult {
  summary: string;
  keywords: string[];
  toneTag: string;
  memoryType?: SummaryMemoryType;
  phase?: SummaryPhase;
  constraints: string[];
  decisions: string[];
  blockers: string[];
  nextSteps?: string[];
  keyEntities?: string[];
  exactFacts: string[];
  promotionIntent?: PromotionIntent;
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
  agentId: string;
  workspaceDir: string;
  sharedDataDir: string;
  knowledgeBaseDir: string;
  memoryVaultDir: string;
  contextWindow: number;
  contextThreshold: number;
  freshTailTokens: number;
  maxFreshTailTurns: number;
  compactionBatchTurns: number;
  summaryModel?: string;
  knowledgePromotionModel?: string;
  summaryMaxOutputTokens: number;
  strictCompaction: boolean;
  compactionBarrierEnabled: boolean;
  runtimeCaptureEnabled: boolean;
  durableMemoryEnabled: boolean;
  autoRecallEnabled: boolean;
  knowledgePromotionEnabled: boolean;
  emergencyBrake: boolean;
}

export interface RecallResult {
  items: ContextItem[];
  consumedTokens: number;
}

export interface ProjectStateSnapshot {
  schemaVersion: 2;
  dateLabel: string;
  projectId: string;
  projectTitle: string;
  projectStatus: "active" | "blocked" | "planned" | "archived";
  active: string;
  decision: string;
  todo: string;
  next: string;
  pending: string;
  blocker: string;
  risk: string;
  recall: string;
}

export type RetrievalRoute =
  | "recent_tail"
  | "project_registry"
  | "durable_memory"
  | "summary_tree"
  | "navigation"
  | "shared_insights"
  | "knowledge_base"
  | "vector_search";

export interface RetrievalDecision {
  route: RetrievalRoute;
  reason: string;
  requiresEmbeddings: boolean;
  requiresSourceRecall: boolean;
  canAnswerDirectly: boolean;
  routePlan: RetrievalRoute[];
  explanation: string;
  matchedProjectId?: string;
  matchedProjectTitle?: string;
}
