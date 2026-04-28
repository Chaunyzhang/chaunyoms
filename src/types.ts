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

export interface RawMessageQuery {
  sessionId?: string;
}

export interface EvidenceBinding {
  scope: "session" | "agent";
  sessionId: string;
  agentId?: string;
  messageIds: string[];
  sequenceMin?: number;
  sequenceMax?: number;
  turnStart?: number;
  turnEnd?: number;
  sourceHash?: string;
  sourceMessageCount?: number;
}

export interface SourceSpanRef {
  messageId: string;
  role?: MessageRole;
  charStart?: number;
  charEnd?: number;
  quoteHash?: string;
}

export interface RawMessageRepository {
  init(): Promise<void>;
  append(message: RawMessage): Promise<void>;
  appendMany?(messages: RawMessage[]): Promise<void>;
  removeSession?(sessionId: string): Promise<number>;
  getAll(options?: RawMessageQuery): RawMessage[];
  getByRange(startTurn: number, endTurn: number, options?: RawMessageQuery): RawMessage[];
  getByIds(ids: string[], options?: RawMessageQuery): RawMessage[];
  getBySequenceRange(startSequence: number, endSequence: number, options?: RawMessageQuery): RawMessage[];
  getRecentTail(turnCount: number, options?: RawMessageQuery): RawMessage[];
  getRecentTailByTokens(tokenBudget: number, maxTurns: number, options?: RawMessageQuery): RawMessage[];
  totalUncompactedTokens(options?: RawMessageQuery): number;
  getUncompactedMessages(options?: RawMessageQuery): RawMessage[];
  markCompacted(startTurn: number, endTurn: number, options?: RawMessageQuery): Promise<void>;
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
  removeSession?(sessionId: string): Promise<number>;
  getAll(): ObservationEntry[];
  count(): number;
}

export interface MemoryItemDraftEntry {
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

export interface MemoryItemDraftRepository {
  init(): Promise<void>;
  addEntries(entries: MemoryItemDraftEntry[]): Promise<number>;
  replaceAll(entries: MemoryItemDraftEntry[]): Promise<void>;
  removeSession?(sessionId: string): Promise<number>;
  search(query: string, limit?: number): MemoryItemDraftEntry[];
  getAll(): MemoryItemDraftEntry[];
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
  sourceBinding?: EvidenceBinding;
  sourceRefs?: SourceSpanRef[];
  sourceSummaryIds?: string[];
  parentSummaryId?: string;
  parentSummaryIds?: string[];
  childSummaryIds?: string[];
  summaryLevel?: number;
  nodeKind?: SummaryNodeKind;
  tokenCount: number;
  createdAt: string;
  sourceHash?: string;
  sourceMessageCount?: number;
  coverage?: {
    sourceTokenEstimate: number;
    summaryTokenEstimate: number;
    compressionRatio: number;
  };
  quality?: {
    confidence: number;
    sourceTraceComplete: boolean;
    unresolvedConflicts: number;
    needsHumanReview: boolean;
    generatedBy?: string;
  };
  openQuestions?: string[];
  conflicts?: string[];
  candidateAtomPreviews?: string[];
  sectionChunks?: Array<{
    id: string;
    section: string;
    text: string;
    tokenCount: number;
  }>;
}

export interface SummaryRepository {
  init(): Promise<void>;
  addSummary(entry: SummaryEntry): Promise<boolean>;
  upsertSummary(entry: SummaryEntry): Promise<void>;
  removeSession?(sessionId: string): Promise<number>;
  getAllSummaries(options?: { sessionId?: string }): SummaryEntry[];
  getActiveSummaries(options?: { sessionId?: string }): SummaryEntry[];
  getRootSummaries(options?: { sessionId?: string }): SummaryEntry[];
  getCoveredTurns(options?: { sessionId?: string }): Set<number>;
  findBySourceCoverage(
    startTurn: number,
    endTurn: number,
    sourceHash?: string,
    sourceMessageCount?: number,
    options?: { sessionId?: string },
  ): SummaryEntry | null;
  search(query: string, options?: { sessionId?: string }): SummaryEntry[];
  getTotalTokens(options?: { sessionId?: string }): number;
  attachParent(parentSummaryId: string, childSummaryIds: string[]): Promise<void>;
}

export type EvidenceAtomType =
  | "constraint"
  | "decision"
  | "exact_fact"
  | "blocker"
  | "next_step"
  | "entity";
export type EvidenceAtomStatus =
  | "candidate"
  | "accepted"
  | "conflicted"
  | "superseded"
  | "expired";

export interface EvidenceAtomEntry {
  id: string;
  eventId?: string;
  sessionId: string;
  agentId?: string;
  projectId?: string;
  topicId?: string;
  recordStatus?: RecordStatus;
  atomStatus?: EvidenceAtomStatus;
  type: EvidenceAtomType;
  text: string;
  retrievalText: string;
  tags: string[];
  confidence: number;
  importance: number;
  stability: number;
  sourceTraceComplete: boolean;
  sourceSummaryId: string;
  sourceBinding?: EvidenceBinding;
  sourceMessageIds?: string[];
  startTurn: number;
  endTurn: number;
  sourceHash?: string;
  sourceMessageCount?: number;
  validFrom?: string;
  validUntil?: string;
  conflictGroupId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface EvidenceAtomRepository {
  init(): Promise<void>;
  upsertMany(entries: EvidenceAtomEntry[]): Promise<void>;
  getAll(options?: { sessionId?: string }): EvidenceAtomEntry[];
  search(query: string, options?: { sessionId?: string; limit?: number }): EvidenceAtomEntry[];
  removeSession(sessionId: string): Promise<number>;
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

export type KnowledgeDocBucket = "raw" | "decisions" | "patterns" | "facts" | "incidents";
export type KnowledgeOrigin = "manual" | "native" | "imported" | "synthesized";
export type KnowledgeIntakeMode = "conservative" | "balanced" | "aggressive";
export type ConfigPreset = "safe" | "balanced" | "enhanced_recall";
export type RetrievalStrength = "off" | "light" | "auto" | "strict" | "forensic";
export type KbPromotionMode =
  | "manual"
  | "assisted"
  | "conservative_auto"
  | "balanced_auto"
  | "aggressive_auto";
export type KbPromotionStrictness = "low" | "medium" | "high";

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
  origin: KnowledgeOrigin;
  status: "active" | "draft" | "superseded";
  supersededById?: string;
  linkedSummaryIds: string[];
  sourceRefs: string[];
  updatedAt: string;
  versions: KnowledgeDocVersionRecord[];
}

export interface KnowledgeDocumentRecord {
  entry: KnowledgeDocumentIndexEntry;
  version: KnowledgeDocVersionRecord;
  filePath: string;
  content: string;
}

export interface KnowledgeAssetSyncReport {
  ok: boolean;
  mode: "sync" | "reindex";
  beforeCount: number;
  afterCount: number;
  added: string[];
  removed: string[];
  updated: string[];
  warnings: string[];
}

export interface KnowledgeAssetVerifyReport {
  ok: boolean;
  indexedCount: number;
  filesystemCount: number;
  missingFiles: Array<{ docId: string; filePath: string }>;
  missingProvenance: Array<{ docId: string; title: string; status: string }>;
  duplicateCanonicalKeys: Array<{ canonicalKey: string; docIds: string[] }>;
  staleIndex: boolean;
  warnings: string[];
}

export interface KnowledgeTrustModel {
  owner: "chaunyoms";
  layer: "unified_knowledge";
  writable: boolean;
  versioned: boolean;
  requiresProvenance: boolean;
  notes: string[];
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

export type KnowledgeRawStatus =
  | "review_pending"
  | "pending"
  | "processing"
  | "promoted"
  | "duplicate"
  | "skipped"
  | "rejected"
  | "failed";

export interface KnowledgeRawCandidateScore {
  total: number;
  recommendation: "promote" | "review" | "skip";
  dimensions: {
    value: number;
    researchDifficulty: number;
    sourceEffort: number;
    contentDensity: number;
    evidenceStrength: number;
    novelty: number;
  };
  weights: {
    value: number;
    researchDifficulty: number;
    sourceEffort: number;
    contentDensity: number;
    evidenceStrength: number;
    novelty: number;
  };
  reasons: string[];
}

export interface KnowledgeRawReviewState {
  mode: "auto" | "manual";
  state: "auto_accepted" | "awaiting_review" | "approved" | "rejected";
  reviewedAt?: string;
  reviewer?: string;
  note?: string;
}

export interface KnowledgeRawEntry {
  id: string;
  sessionId: string;
  agentId?: string;
  sourceSummaryId: string;
  sourceSummary: SummaryEntry;
  sourceBinding?: EvidenceBinding;
  oneLineSummary?: string;
  score?: KnowledgeRawCandidateScore;
  review?: KnowledgeRawReviewState;
  intakeReason: string;
  status: KnowledgeRawStatus;
  processReason?: string;
  linkedDocId?: string;
  linkedSlug?: string;
  linkedVersion?: number;
  linkedFilePath?: string;
  createdAt: string;
  updatedAt: string;
  lastProcessedAt?: string;
}

export type MemoryItemKind =
  | "preference"
  | "principle"
  | "decision"
  | "constraint"
  | "lesson"
  | "project_state"
  | "correction"
  | "procedure"
  | "claim"
  | "diagnosis"
  | "kb_candidate"
  | "general";

export type MemoryItemScope =
  | "agent"
  | "session"
  | "project"
  | "user_private_to_agent"
  | "global_principle"
  | "global";
export type MemoryItemStatus = "candidate" | "active" | "superseded" | "rejected" | "archived" | "expired";
export type MemoryItemEvidenceLevel =
  | "inferred"
  | "stated"
  | "source_verified";
export type MemoryItemContextPolicy =
  | "never"
  | "on_demand"
  | "default"
  | "always_core"
  | "project_active"
  | "strict_only";
export type MemoryItemStability = "low" | "medium" | "high";
export type MemoryItemPromotionState =
  | "none"
  | "candidate"
  | "kb_candidate"
  | "drafted"
  | "approved"
  | "exported"
  | "rejected";

export interface MemoryItemEntry {
  id: string;
  sourceTable: "memory_item_drafts" | "summary_evidence_drafts" | "knowledge_raw" | "inferred";
  sourceId: string;
  sessionId: string;
  agentId?: string;
  projectId?: string;
  topicId?: string;
  kind: MemoryItemKind;
  status: MemoryItemStatus;
  scope: MemoryItemScope;
  scopeType?: MemoryItemScope;
  scopeId: string;
  evidenceLevel: MemoryItemEvidenceLevel;
  contextPolicy: MemoryItemContextPolicy;
  text: string;
  content?: string;
  confidence: number;
  stability: MemoryItemStability;
  priority: number;
  tags: string[];
  sourceIds: string[];
  sourceRefs?: SourceSpanRef[];
  inferred: boolean;
  supersedes: string[];
  conflictsWith: string[];
  supports: string[];
  promotionState: MemoryItemPromotionState;
  validFrom?: string;
  validUntil?: string;
  createdByAgentId?: string;
  updatedByAgentId?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeRawRepository {
  init(): Promise<void>;
  enqueue(entry: KnowledgeRawEntry): Promise<boolean>;
  getAll(): KnowledgeRawEntry[];
  findBySourceSummaryId(sourceSummaryId: string): KnowledgeRawEntry | null;
  claimPending(limit?: number): Promise<KnowledgeRawEntry[]>;
  markReview(args: {
    id: string;
    action: "approve" | "reject";
    reviewer?: string;
    note?: string;
  }): Promise<KnowledgeRawEntry | null>;
  markSettled(args: {
    id: string;
    status: Exclude<KnowledgeRawStatus, "review_pending" | "pending" | "processing">;
    reason: string;
    docId?: string;
    slug?: string;
    version?: number;
    filePath?: string;
  }): Promise<void>;
}

export interface KnowledgeRepository {
  init(): Promise<void>;
  getBaseDir(): string;
  getIndexedDocuments(): KnowledgeDocumentIndexEntry[];
  syncAssetIndex(mode?: "sync" | "reindex"): Promise<KnowledgeAssetSyncReport>;
  verifyAssetIndex(): Promise<KnowledgeAssetVerifyReport>;
  findPromotion(summary: SummaryEntry): PromotionLedgerEntry | null;
  searchRelatedDocuments(query: string, limit?: number): KnowledgeDocumentIndexEntry[];
  getById(id: string): Promise<KnowledgeDocumentRecord | null>;
  listVersions(canonicalKey: string): KnowledgeDocVersionRecord[];
  markSuperseded(id: string, byId: string): Promise<boolean>;
  reconcile(canonicalKey: string): Promise<KnowledgeDocumentIndexEntry | null>;
  linkToSummary(id: string, summaryId: string): Promise<boolean>;
  linkToSource(id: string, sourceRef: string): Promise<boolean>;
  describeTrustModel(): KnowledgeTrustModel;
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

export interface SourceTrace {
  route: RetrievalRoute | "compaction" | "knowledge_promotion" | "raw_exact_search";
  summaryId?: string;
  sessionId: string;
  agentId?: string;
  strategy: "message_ids" | "sequence_range" | "turn_range" | "none";
  verified: boolean;
  reason: string;
  sourceHash?: string;
  actualHash?: string;
  sourceMessageCount?: number;
  resolvedMessageCount: number;
  turnStart?: number;
  turnEnd?: number;
  sequenceMin?: number;
  sequenceMax?: number;
  messageIds?: string[];
}

export interface AnswerCandidate {
  text: string;
  type:
    | "person"
    | "place"
    | "date"
    | "duration"
    | "relationship"
    | "title"
    | "organization"
    | "object"
    | "choice"
    | "unknown";
  confidence: number;
  evidenceMessageIds: string[];
  sourceVerified: boolean;
  reason: string;
}

export interface FallbackTrace {
  from: RetrievalRoute | "assemble" | "compaction" | "knowledge_promotion";
  to: RetrievalRoute | "recent_tail" | "memory_item" | "none";
  reason: string;
}

export interface ContextViewRepository {
  setItems(items: ContextItem[]): void;
  getItems(): ContextItem[];
  clear(): void;
}

export interface PrefixRouteHit {
  kind: "navigation" | "knowledge_base";
  filePath?: string;
  title: string;
  content: string;
}

export interface PrefixLoadOptions {
  activeQuery?: string;
}

export interface FixedPrefixProvider {
  load(
    sharedDataDir: string,
    workspaceDir: string,
    budget: number,
    options?: PrefixLoadOptions,
  ): Promise<ContextItem[]>;
  getKnowledgeBaseHit(sharedDataDir: string, query: string): Promise<PrefixRouteHit | null>;
  hasKnowledgeBaseTopicHit(sharedDataDir: string, query: string): Promise<boolean>;
}

export interface NavigationRepository {
  getNavigationHit(workspaceDir: string, query: string): Promise<PrefixRouteHit | null>;
  getNavigationStateHit(workspaceDir: string, query: string): Promise<PrefixRouteHit | null>;
  hasNavigationHint(workspaceDir: string, query: string): Promise<boolean>;
  hasStructuredNavigationState(workspaceDir: string): Promise<boolean>;
  writeNavigationSnapshot(workspaceDir: string, content: string): Promise<{ written: boolean; filePath?: string }>;
}

export interface HostFixedContextProvider {
  estimateWorkspaceBootstrapTokens(workspaceDir: string): Promise<number>;
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
  openQuestions?: string[];
  conflicts?: string[];
  candidateAtomPreviews?: string[];
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
  configPreset: ConfigPreset;
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
  memoryItemEnabled: boolean;
  autoRecallEnabled: boolean;
  agentVaultMirrorEnabled: boolean;
  summaryMarkdownMirrorEnabled: boolean;
  memoryItemMarkdownMirrorEnabled: boolean;
  transcriptMirrorEnabled: boolean;
  knowledgeMarkdownEnabled: boolean;
  retrievalStrength: RetrievalStrength;
  knowledgePromotionEnabled: boolean;
  knowledgePromotionManualReviewEnabled: boolean;
  knowledgeIntakeMode: KnowledgeIntakeMode;
  kbCandidateEnabled: boolean;
  kbWriteEnabled: boolean;
  kbPromotionMode: KbPromotionMode;
  kbPromotionStrictness: KbPromotionStrictness;
  kbExportEnabled: boolean;
  knowledgeIntakeAllowProjectState: boolean;
  knowledgeIntakeAllowBranchSummaries: boolean;
  knowledgeIntakeUserOverrideEnabled: boolean;
  knowledgeIntakeUserOverridePatterns: string[];
  semanticCandidateExpansionEnabled: boolean;
  semanticCandidateLimit: number;
  emergencyBrake: boolean;
  sqliteJournalMode: "delete" | "wal";
}

export interface RecallResult {
  items: ContextItem[];
  consumedTokens: number;
  sourceTrace: SourceTrace[];
  dagTrace: DagTraversalStep[];
  answerCandidates?: AnswerCandidate[];
  strategy?: "raw_first" | "summary_navigation";
  rawCandidateCount?: number;
}

export interface DagTraversalStep {
  summaryId: string;
  sessionId: string;
  summaryLevel: number;
  nodeKind: SummaryNodeKind;
  score: number;
  reasons: string[];
  action: "root_candidate" | "descend" | "leaf_selected" | "branch_fallback" | "direct_leaf_hit";
  parentSummaryIds?: string[];
  childSummaryIds?: string[];
}

export interface DagIntegrityIssue {
  severity: "error" | "warning";
  code:
    | "missing_child_summary"
    | "missing_parent_summary"
    | "parent_child_backlink_missing"
    | "child_parent_backlink_missing"
    | "branch_without_children"
    | "leaf_with_children"
    | "source_messages_missing"
    | "source_integrity_mismatch";
  summaryId: string;
  relatedSummaryId?: string;
  message: string;
}

export interface DagIntegrityReport {
  ok: boolean;
  totalSummaries: number;
  rootCount: number;
  branchCount: number;
  leafCount: number;
  issueCount: number;
  issues: DagIntegrityIssue[];
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
  | "memory_item"
  | "summary_tree"
  | "knowledge";

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
  layerScores?: RetrievalLayerScore[];
}

export interface RetrievalLayerScore {
  route: RetrievalRoute;
  score: number;
  reasons: string[];
}

export type SemanticCandidateKind =
  | "project_registry"
  | "memory_item"
  | "summary"
  | "knowledge";

export interface SemanticCandidate {
  kind: SemanticCandidateKind;
  id: string;
  title: string;
  score: number;
  reasons: string[];
  authority: "authoritative" | "hint";
  sourceRoute: RetrievalRoute | "semantic_candidate_expansion";
  requiresSourceRecall?: boolean;
  matchedProjectId?: string;
  matchedProjectTitle?: string;
}

export type CompactionRunResult =
  | {
      status: "compacted";
      summary: SummaryEntry;
      sourceBinding: EvidenceBinding;
      sourceTrace: SourceTrace;
    }
  | {
      status: "deduped";
      summary: SummaryEntry;
      sourceBinding: EvidenceBinding;
      sourceTrace: SourceTrace;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "failed";
      reason: string;
      error?: string;
    };
