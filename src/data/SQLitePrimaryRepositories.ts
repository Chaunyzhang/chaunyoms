import {
  DurableMemoryEntry,
  DurableMemoryRepository,
  EvidenceAtomEntry,
  EvidenceAtomRepository,
  KnowledgeRawEntry,
  KnowledgeRawRepository,
  ObservationEntry,
  ObservationRepository,
  ProjectRecord,
  ProjectRegistryRepository,
  RawMessage,
  RawMessageQuery,
  RawMessageRepository,
  SummaryEntry,
  SummaryRepository,
} from "../types";
import { SourceMessageResolver } from "../resolvers/SourceMessageResolver";
import { buildStableEventId } from "../utils/projectIdentity";
import { SQLiteRuntimeStore } from "./SQLiteRuntimeStore";

const SUMMARY_PHASES = new Set([
  "planning",
  "implementation",
  "validation",
  "fixing",
  "review",
  "active",
]);

export class SQLiteRawMessageRepository implements RawMessageRepository {
  private messages: RawMessage[] = [];

  constructor(private readonly runtimeStore: SQLiteRuntimeStore) {}

  async init(): Promise<void> {
    await this.runtimeStore.init();
    this.messages = this.runtimeStore.listRawMessages();
  }

  async append(message: RawMessage): Promise<void> {
    if (!Number.isFinite(message.sequence)) {
      message.sequence = this.nextSequence();
    }
    this.messages.push(message);
    await this.runtimeStore.recordRawMessage(message);
  }

  async appendMany(messages: RawMessage[]): Promise<void> {
    for (const message of messages) {
      if (!Number.isFinite(message.sequence)) {
        message.sequence = this.nextSequence();
      }
      this.messages.push(message);
    }
    await this.runtimeStore.recordRawMessages(messages);
  }

  async removeSession(sessionId: string): Promise<number> {
    const before = this.messages.length;
    this.messages = this.messages.filter((message) => message.sessionId !== sessionId);
    return before - this.messages.length;
  }

  getAll(options: RawMessageQuery = {}): RawMessage[] {
    return this.filterBySession(this.messages, options);
  }

  getByRange(startTurn: number, endTurn: number, options: RawMessageQuery = {}): RawMessage[] {
    return this.filterBySession(
      this.messages.filter((message) => message.turnNumber >= startTurn && message.turnNumber <= endTurn),
      options,
    );
  }

  getByIds(ids: string[], options: RawMessageQuery = {}): RawMessage[] {
    const wanted = new Set(ids);
    return this.filterBySession(this.messages.filter((message) => wanted.has(message.id)), options);
  }

  getBySequenceRange(startSequence: number, endSequence: number, options: RawMessageQuery = {}): RawMessage[] {
    return this.filterBySession(
      this.messages.filter((message) =>
        Number.isFinite(message.sequence) &&
        (message.sequence as number) >= startSequence &&
        (message.sequence as number) <= endSequence,
      ),
      options,
    );
  }

  getRecentTail(turnCount: number, options: RawMessageQuery = {}): RawMessage[] {
    if (turnCount <= 0) {
      return [];
    }
    const scopedMessages = this.filterBySession(this.messages, options);
    const turnNumbers = [...new Set(scopedMessages.map((message) => message.turnNumber))];
    const protectedTurns = new Set(turnNumbers.slice(-turnCount));
    return scopedMessages.filter((message) => protectedTurns.has(message.turnNumber));
  }

  getRecentTailByTokens(tokenBudget: number, maxTurns: number, options: RawMessageQuery = {}): RawMessage[] {
    if (tokenBudget <= 0 || maxTurns <= 0) {
      return [];
    }
    const scopedMessages = this.filterBySession(this.messages, options);
    const turnOrder = [...new Set(scopedMessages.map((message) => message.turnNumber))];
    const selectedTurns: number[] = [];
    let consumed = 0;
    for (let index = turnOrder.length - 1; index >= 0; index -= 1) {
      const turnNumber = turnOrder[index];
      const turnTokens = scopedMessages
        .filter((message) => message.turnNumber === turnNumber)
        .reduce((sum, message) => sum + message.tokenCount, 0);
      if (selectedTurns.length > 0 && consumed + turnTokens > tokenBudget) {
        break;
      }
      selectedTurns.unshift(turnNumber);
      consumed += turnTokens;
      if (selectedTurns.length >= maxTurns) {
        break;
      }
    }
    const selectedTurnSet = new Set(selectedTurns);
    return scopedMessages.filter((message) => selectedTurnSet.has(message.turnNumber));
  }

  totalUncompactedTokens(options: RawMessageQuery = {}): number {
    return this.filterBySession(this.messages, options)
      .reduce((total, message) => total + (message.compacted ? 0 : message.tokenCount), 0);
  }

  getUncompactedMessages(options: RawMessageQuery = {}): RawMessage[] {
    return this.filterBySession(this.messages, options).filter((message) => !message.compacted);
  }

  async markCompacted(startTurn: number, endTurn: number, options: RawMessageQuery = {}): Promise<void> {
    const changed: RawMessage[] = [];
    this.messages = this.messages.map((message) => {
      if (
        this.matchesSession(message, options) &&
        message.turnNumber >= startTurn &&
        message.turnNumber <= endTurn &&
        !message.compacted
      ) {
        const updated = { ...message, compacted: true };
        changed.push(updated);
        return updated;
      }
      return message;
    });
    if (changed.length > 0) {
      await this.runtimeStore.recordRawMessages(changed);
    }
  }

  private nextSequence(): number {
    const lastSequence = this.messages[this.messages.length - 1]?.sequence;
    return Number.isFinite(lastSequence) ? (lastSequence as number) + 1 : 1;
  }

  private filterBySession(messages: RawMessage[], options: RawMessageQuery): RawMessage[] {
    return messages.filter((message) => this.matchesSession(message, options));
  }

  private matchesSession(message: RawMessage, options: RawMessageQuery): boolean {
    return !options.sessionId || message.sessionId === options.sessionId;
  }
}

export class SQLiteSummaryRepository implements SummaryRepository {
  private summaries: SummaryEntry[] = [];

  constructor(private readonly runtimeStore: SQLiteRuntimeStore) {}

  async init(): Promise<void> {
    await this.runtimeStore.init();
    this.summaries = this.normalizeSummaries(this.runtimeStore.listSummaries());
  }

  async addSummary(entry: SummaryEntry): Promise<boolean> {
    if (this.findEquivalentSummary(entry)) {
      return false;
    }
    this.summaries.push(this.normalizeSummary(entry));
    this.summaries = this.normalizeSummaries(this.summaries);
    await this.runtimeStore.recordSummaries([entry]);
    return true;
  }

  async upsertSummary(entry: SummaryEntry): Promise<void> {
    const normalized = this.normalizeSummary(entry);
    const index = this.summaries.findIndex((item) => item.id === normalized.id);
    if (index >= 0) {
      this.summaries[index] = normalized;
    } else {
      this.summaries.push(normalized);
    }
    this.summaries = this.normalizeSummaries(this.summaries);
    await this.runtimeStore.recordSummaries([normalized]);
  }

  async removeSession(sessionId: string): Promise<number> {
    const before = this.summaries.length;
    this.summaries = this.summaries.filter((entry) => entry.sessionId !== sessionId);
    return before - this.summaries.length;
  }

  async attachParent(parentSummaryId: string, childSummaryIds: string[]): Promise<void> {
    const changed: SummaryEntry[] = [];
    this.summaries = this.summaries.map((summary) => {
      if (!childSummaryIds.includes(summary.id)) {
        return summary;
      }
      const parentSummaryIds = [...new Set([...(summary.parentSummaryIds ?? []), parentSummaryId])];
      const updated = this.normalizeSummary({
        ...summary,
        parentSummaryId: summary.parentSummaryId ?? parentSummaryId,
        parentSummaryIds,
      });
      changed.push(updated);
      return updated;
    });
    const parent = this.summaries.find((summary) => summary.id === parentSummaryId);
    if (parent) {
      const updated = this.normalizeSummary({
        ...parent,
        childSummaryIds: [...new Set([...(parent.childSummaryIds ?? []), ...childSummaryIds])],
      });
      this.summaries = this.summaries.map((summary) => summary.id === parentSummaryId ? updated : summary);
      changed.push(updated);
    }
    this.summaries = this.normalizeSummaries(this.summaries);
    if (changed.length > 0) {
      await this.runtimeStore.recordSummaries(changed);
    }
  }

  getAllSummaries(options: { sessionId?: string } = {}): SummaryEntry[] {
    return this.filterBySession(this.summaries, options);
  }

  getActiveSummaries(options: { sessionId?: string } = {}): SummaryEntry[] {
    return this.filterBySession(this.summaries, options).filter((entry) => entry.recordStatus === "active");
  }

  getRootSummaries(options: { sessionId?: string } = {}): SummaryEntry[] {
    return this.getActiveSummaries(options).filter((entry) => (
      !entry.parentSummaryId &&
      (!Array.isArray(entry.parentSummaryIds) || entry.parentSummaryIds.length === 0)
    ));
  }

  getCoveredTurns(options: { sessionId?: string } = {}): Set<number> {
    const coveredTurns = new Set<number>();
    for (const summary of this.getActiveSummaries(options)) {
      for (let turn = summary.startTurn; turn <= summary.endTurn; turn += 1) {
        coveredTurns.add(turn);
      }
    }
    return coveredTurns;
  }

  findBySourceCoverage(
    startTurn: number,
    endTurn: number,
    sourceHash?: string,
    sourceMessageCount?: number,
    options: { sessionId?: string } = {},
  ): SummaryEntry | null {
    return this.summaries.find((summary) => {
      if (!this.matchesSession(summary, options)) {
        return false;
      }
      if (summary.startTurn !== startTurn || summary.endTurn !== endTurn) {
        return false;
      }
      if (
        sourceHash &&
        summary.sourceHash &&
        summary.sourceHash === sourceHash &&
        typeof sourceMessageCount === "number" &&
        summary.sourceMessageCount === sourceMessageCount
      ) {
        return true;
      }
      if (Array.isArray(summary.sourceSummaryIds) && summary.sourceSummaryIds.length > 0) {
        return false;
      }
      return !sourceHash || !summary.sourceHash;
    }) ?? null;
  }

  search(query: string, options: { sessionId?: string } = {}): SummaryEntry[] {
    const terms = query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
    if (terms.length === 0) {
      return [];
    }
    return this.getActiveSummaries(options).filter((entry) => {
      const haystack = [
        entry.summary,
        entry.memoryType ?? "",
        entry.phase ?? "",
        entry.keywords.join(" "),
        entry.constraints.join(" "),
        entry.decisions.join(" "),
        entry.blockers.join(" "),
        (entry.nextSteps ?? []).join(" "),
        (entry.keyEntities ?? []).join(" "),
        entry.exactFacts.join(" "),
        entry.promotionIntent ?? "",
        entry.projectId ?? "",
        entry.topicId ?? "",
      ].join(" ").toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
  }

  getTotalTokens(options: { sessionId?: string } = {}): number {
    return this.getActiveSummaries(options).reduce((total, entry) => total + entry.tokenCount, 0);
  }

  private findEquivalentSummary(entry: SummaryEntry): SummaryEntry | null {
    if (Array.isArray(entry.sourceSummaryIds) && entry.sourceSummaryIds.length > 0) {
      const targetKey = entry.sourceSummaryIds.join("|");
      return this.summaries.find((summary) => {
        if (summary.sessionId !== entry.sessionId) {
          return false;
        }
        if (!Array.isArray(summary.sourceSummaryIds) || summary.sourceSummaryIds.length === 0) {
          return false;
        }
        return summary.summaryLevel === (entry.summaryLevel ?? 1) && summary.sourceSummaryIds.join("|") === targetKey;
      }) ?? null;
    }
    return this.findBySourceCoverage(
      entry.startTurn,
      entry.endTurn,
      entry.sourceHash,
      entry.sourceMessageCount,
      { sessionId: entry.sessionId },
    );
  }

  private normalizeSummaries(entries: SummaryEntry[]): SummaryEntry[] {
    const normalized: SummaryEntry[] = [];
    const seen = new Set<string>();
    for (const entry of [...entries].sort((left, right) =>
      (left.summaryLevel ?? 1) - (right.summaryLevel ?? 1) ||
      left.startTurn - right.startTurn ||
      left.endTurn - right.endTurn ||
      left.createdAt.localeCompare(right.createdAt),
    )) {
      const summary = this.normalizeSummary(entry);
      const key = this.buildDedupKey(summary);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push(summary);
    }
    return normalized;
  }

  private normalizeSummary(entry: SummaryEntry): SummaryEntry {
    return {
      ...entry,
      eventId: entry.eventId ?? buildStableEventId("summary", `${entry.id}|${entry.createdAt}`),
      projectId: entry.projectId?.trim() || undefined,
      topicId: entry.topicId?.trim() || undefined,
      recordStatus: entry.recordStatus ?? "active",
      childSummaryIds: [...new Set(entry.childSummaryIds ?? [])],
      sourceSummaryIds: [...new Set(entry.sourceSummaryIds ?? [])],
      parentSummaryIds: [...new Set([
        ...(entry.parentSummaryIds ?? []),
        ...(entry.parentSummaryId ? [entry.parentSummaryId] : []),
      ])],
      sourceMessageIds: [...new Set(entry.sourceMessageIds ?? [])],
      sourceRefs: Array.isArray(entry.sourceRefs) ? entry.sourceRefs : [],
      summaryLevel: entry.summaryLevel ?? 1,
      nodeKind: entry.nodeKind ?? (entry.sourceSummaryIds && entry.sourceSummaryIds.length > 0 ? "branch" : "leaf"),
      memoryType: entry.memoryType ?? "general",
      phase: SUMMARY_PHASES.has(entry.phase as string) ? entry.phase : "active",
      constraints: Array.isArray(entry.constraints) ? entry.constraints : [],
      decisions: Array.isArray(entry.decisions) ? entry.decisions : [],
      blockers: Array.isArray(entry.blockers) ? entry.blockers : [],
      nextSteps: Array.isArray(entry.nextSteps) ? [...new Set(entry.nextSteps)] : [],
      keyEntities: Array.isArray(entry.keyEntities) ? [...new Set(entry.keyEntities)] : [],
      exactFacts: Array.isArray(entry.exactFacts) ? entry.exactFacts : [],
      promotionIntent: entry.promotionIntent ?? "candidate",
      keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
      openQuestions: Array.isArray(entry.openQuestions) ? entry.openQuestions : [],
      conflicts: Array.isArray(entry.conflicts) ? entry.conflicts : [],
      candidateAtomPreviews: Array.isArray(entry.candidateAtomPreviews) ? entry.candidateAtomPreviews : [],
      sectionChunks: Array.isArray(entry.sectionChunks) ? entry.sectionChunks : [],
    };
  }

  private buildDedupKey(entry: SummaryEntry): string {
    if (Array.isArray(entry.sourceSummaryIds) && entry.sourceSummaryIds.length > 0) {
      return `branch:${entry.sessionId}:${entry.summaryLevel ?? 1}:${entry.sourceSummaryIds.join("|")}`;
    }
    return `leaf:${entry.sessionId}:${entry.startTurn}:${entry.endTurn}:${entry.sourceHash ?? "nohash"}`;
  }

  private filterBySession(entries: SummaryEntry[], options: { sessionId?: string }): SummaryEntry[] {
    return entries.filter((entry) => this.matchesSession(entry, options));
  }

  private matchesSession(entry: SummaryEntry, options: { sessionId?: string }): boolean {
    return !options.sessionId || entry.sessionId === options.sessionId;
  }
}

export class SQLiteDurableMemoryRepository implements DurableMemoryRepository {
  private memories: DurableMemoryEntry[] = [];

  constructor(private readonly runtimeStore: SQLiteRuntimeStore) {}

  async init(): Promise<void> {
    await this.runtimeStore.init();
    this.memories = this.runtimeStore.listMemories().map((entry) => this.normalizeEntry(entry));
  }

  async addEntries(entries: DurableMemoryEntry[]): Promise<number> {
    let added = 0;
    for (const rawEntry of entries) {
      const entry = this.normalizeEntry(rawEntry);
      if (this.memories.some((item) => item.fingerprint === entry.fingerprint && item.recordStatus !== "archived")) {
        continue;
      }
      if (entry.kind === "project_state" && entry.projectId) {
        this.supersedeActiveProjectState(entry.projectId, entry.id);
      }
      this.supersedeActiveFactEntry(entry);
      this.memories.push(entry);
      added += 1;
    }
    if (added > 0) {
      this.memories = this.memories
        .map((entry) => this.normalizeEntry(entry))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      await this.runtimeStore.replaceMemories(this.memories);
    }
    return added;
  }

  async replaceAll(entries: DurableMemoryEntry[]): Promise<void> {
    this.memories = entries
      .map((entry) => this.normalizeEntry(entry))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    await this.runtimeStore.replaceMemories(this.memories);
  }

  async removeSession(sessionId: string): Promise<number> {
    const before = this.memories.length;
    this.memories = this.memories.filter((entry) => entry.sessionId !== sessionId);
    return before - this.memories.length;
  }

  search(query: string, limit = 5): DurableMemoryEntry[] {
    const terms = query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i).map((term) => term.trim()).filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return [];
    }
    return [...this.memories]
      .filter((entry) => entry.recordStatus === "active")
      .map((entry) => ({ entry, score: this.scoreEntry(entry, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.entry.createdAt.localeCompare(left.entry.createdAt))
      .slice(0, Math.max(limit, 1))
      .map((item) => item.entry);
  }

  getAll(): DurableMemoryEntry[] {
    return [...this.memories];
  }

  count(): number {
    return this.memories.filter((entry) => entry.recordStatus === "active").length;
  }

  private supersedeActiveProjectState(projectId: string, supersededById: string): void {
    this.memories = this.memories.map((entry) =>
      entry.kind === "project_state" && entry.projectId === projectId && entry.recordStatus === "active"
        ? this.normalizeEntry({ ...entry, recordStatus: "superseded", supersededById })
        : entry,
    );
  }

  private supersedeActiveFactEntry(entry: DurableMemoryEntry): void {
    const factKey = this.factKey(entry);
    const factValue = this.factValue(entry);
    if (!factKey || !factValue) {
      return;
    }
    this.memories = this.memories.map((current) => {
      if (current.recordStatus !== "active" || current.id === entry.id || this.factKey(current) !== factKey) {
        return current;
      }
      if (this.factValue(current) === factValue) {
        return current;
      }
      return this.normalizeEntry({ ...current, recordStatus: "superseded", supersededById: entry.id });
    });
  }

  private scoreEntry(entry: DurableMemoryEntry, terms: string[]): number {
    const haystack = `${entry.kind} ${entry.projectId ?? ""} ${entry.topicId ?? ""} ${entry.tags.join(" ")} ${entry.text}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += term.length >= 6 ? 3 : 2;
      }
    }
    if (terms.every((term) => haystack.includes(term))) {
      score += 4;
    }
    if (entry.metadata?.factRecencyHint === true) {
      score += 3;
    }
    if (this.factKey(entry) && terms.some((term) => this.factKey(entry)?.toLowerCase().includes(term))) {
      score += 4;
    }
    return score;
  }

  private factKey(entry: DurableMemoryEntry): string | null {
    const value = entry.metadata?.factKey;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  private factValue(entry: DurableMemoryEntry): string | null {
    const value = entry.metadata?.factValue;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  private normalizeEntry(entry: DurableMemoryEntry): DurableMemoryEntry {
    return {
      ...entry,
      eventId: entry.eventId ?? buildStableEventId("memory", `${entry.id}|${entry.createdAt}`),
      recordStatus: entry.recordStatus ?? "active",
      tags: Array.isArray(entry.tags) ? [...new Set(entry.tags)] : [],
      sourceIds: Array.isArray(entry.sourceIds) ? [...new Set(entry.sourceIds)] : [],
    };
  }
}

export class SQLiteEvidenceAtomRepository implements EvidenceAtomRepository {
  private atoms: EvidenceAtomEntry[] = [];

  constructor(private readonly runtimeStore: SQLiteRuntimeStore) {}

  async init(): Promise<void> {
    await this.runtimeStore.init();
    this.atoms = this.normalize(this.runtimeStore.listEvidenceAtoms());
  }

  async upsertMany(entries: EvidenceAtomEntry[]): Promise<void> {
    const byId = new Map(this.atoms.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      byId.set(entry.id, this.normalizeOne(entry));
    }
    this.atoms = this.normalize([...byId.values()]);
    await this.runtimeStore.recordEvidenceAtoms(entries.map((entry) => this.normalizeOne(entry)));
  }

  getAll(options: { sessionId?: string } = {}): EvidenceAtomEntry[] {
    return this.atoms.filter((entry) => !options.sessionId || entry.sessionId === options.sessionId);
  }

  search(query: string, options: { sessionId?: string; limit?: number } = {}): EvidenceAtomEntry[] {
    const terms = this.queryTerms(query);
    if (terms.length === 0) {
      return [];
    }
    const limit = Math.max(1, Math.min(options.limit ?? 12, 50));
    return this.getAll({ sessionId: options.sessionId })
      .map((entry) => ({ entry, score: this.score(entry, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) =>
        right.score - left.score ||
        right.entry.importance - left.entry.importance ||
        left.entry.startTurn - right.entry.startTurn,
      )
      .slice(0, limit)
      .map((item) => item.entry);
  }

  async removeSession(sessionId: string): Promise<number> {
    const before = this.atoms.length;
    this.atoms = this.atoms.filter((entry) => entry.sessionId !== sessionId);
    return before - this.atoms.length;
  }

  private score(entry: EvidenceAtomEntry, terms: string[]): number {
    const haystack = [
      entry.text,
      entry.retrievalText,
      entry.type,
      entry.tags.join(" "),
      entry.projectId ?? "",
      entry.topicId ?? "",
    ].join(" ").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += term.length >= 6 ? 5 : 3;
      }
    }
    return score + Math.round(entry.importance * 3);
  }

  private queryTerms(query: string): string[] {
    return [...new Set(query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .flatMap((term) => this.expandCjkTerm(term)))]
      .slice(0, 80);
  }

  private expandCjkTerm(term: string): string[] {
    if (!/[\u4e00-\u9fff]/.test(term) || term.length <= 4) {
      return [term];
    }
    const terms = [term];
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index <= term.length - size; index += 1) {
        terms.push(term.slice(index, index + size));
      }
    }
    return terms;
  }

  private normalize(entries: EvidenceAtomEntry[]): EvidenceAtomEntry[] {
    return entries
      .map((entry) => this.normalizeOne(entry))
      .sort((left, right) =>
        left.sessionId.localeCompare(right.sessionId) ||
        left.startTurn - right.startTurn ||
        left.type.localeCompare(right.type) ||
        left.id.localeCompare(right.id),
      );
  }

  private normalizeOne(entry: EvidenceAtomEntry): EvidenceAtomEntry {
    return {
      ...entry,
      recordStatus: entry.recordStatus ?? "active",
      atomStatus: entry.atomStatus ?? "candidate",
      tags: [...new Set(entry.tags ?? [])],
      sourceMessageIds: [...new Set(entry.sourceMessageIds ?? [])],
      confidence: Number.isFinite(entry.confidence) ? entry.confidence : 0.7,
      importance: Number.isFinite(entry.importance) ? entry.importance : 0.5,
      stability: Number.isFinite(entry.stability) ? entry.stability : 0.5,
      sourceTraceComplete: entry.sourceTraceComplete ?? Boolean(entry.sourceBinding || entry.sourceHash),
    };
  }
}

export class SQLiteObservationRepository implements ObservationRepository {
  private observations: ObservationEntry[] = [];

  constructor(private readonly runtimeStore: SQLiteRuntimeStore, private readonly agentId: string) {}

  async init(): Promise<void> {
    await this.runtimeStore.init();
    this.observations = this.runtimeStore.listRuntimeRecords("observation", { agentId: this.agentId })
      .map((record) => record.payload as unknown as ObservationEntry);
  }

  async append(entry: ObservationEntry): Promise<void> {
    if (this.observations.some((item) => item.id === entry.id || item.sourceKey === entry.sourceKey)) {
      return;
    }
    this.observations.push(entry);
    await this.runtimeStore.upsertRuntimeRecord({
      kind: "observation",
      id: entry.id,
      sessionId: entry.sessionId,
      agentId: entry.agentId ?? this.agentId,
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      payload: entry as unknown as Record<string, unknown>,
    });
  }

  async removeSession(sessionId: string): Promise<number> {
    const before = this.observations.length;
    this.observations = this.observations.filter((entry) => entry.sessionId !== sessionId);
    return before - this.observations.length;
  }

  getAll(): ObservationEntry[] {
    return [...this.observations];
  }

  count(): number {
    return this.observations.length;
  }
}

export class SQLiteProjectRegistryRepository implements ProjectRegistryRepository {
  private projects: ProjectRecord[] = [];

  constructor(private readonly runtimeStore: SQLiteRuntimeStore, private readonly agentId: string) {}

  async init(): Promise<void> {
    await this.runtimeStore.init();
    this.projects = this.runtimeStore.listRuntimeRecords("project", { agentId: this.agentId })
      .map((record) => this.normalizeProject(record.payload as unknown as ProjectRecord));
  }

  async upsert(project: ProjectRecord): Promise<ProjectRecord> {
    const normalized = this.normalizeProject(project);
    const existingById = this.projects.findIndex((entry) => entry.id === normalized.id);
    const existingByKey = existingById >= 0
      ? existingById
      : this.projects.findIndex((entry) => entry.canonicalKey === normalized.canonicalKey);
    if (existingByKey >= 0) {
      const current = this.projects[existingByKey];
      this.projects[existingByKey] = this.normalizeProject({
        ...current,
        ...normalized,
        tags: this.mergeUnique(current.tags, normalized.tags),
        sourceSessionIds: this.mergeUnique(current.sourceSessionIds, normalized.sourceSessionIds),
        summaryIds: this.mergeUnique(current.summaryIds, normalized.summaryIds),
        memoryIds: this.mergeUnique(current.memoryIds, normalized.memoryIds),
        topicIds: this.mergeUnique(current.topicIds, normalized.topicIds),
        createdAt: current.createdAt,
        updatedAt: normalized.updatedAt,
      });
    } else {
      this.projects.push(normalized);
    }
    this.projects = this.projects.map((entry) => this.normalizeProject(entry)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const saved = this.findById(normalized.id) ?? normalized;
    await this.runtimeStore.upsertRuntimeRecord({
      kind: "project",
      id: saved.id,
      sessionId: saved.sourceSessionIds[0],
      agentId: saved.agentId,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
      payload: saved as unknown as Record<string, unknown>,
    });
    return saved;
  }

  async reconcileProjects(projects: ProjectRecord[]): Promise<void> {
    const nextProjects = new Map<string, ProjectRecord>();
    for (const project of projects) {
      const normalized = this.normalizeProject(project);
      const existing = nextProjects.get(normalized.canonicalKey) ??
        this.projects.find((entry) => entry.canonicalKey === normalized.canonicalKey) ??
        null;
      if (existing) {
        nextProjects.set(normalized.canonicalKey, this.normalizeProject({
          ...existing,
          ...normalized,
          tags: this.mergeUnique(existing.tags, normalized.tags),
          sourceSessionIds: this.mergeUnique(existing.sourceSessionIds, normalized.sourceSessionIds),
          summaryIds: this.mergeUnique(existing.summaryIds, normalized.summaryIds),
          memoryIds: this.mergeUnique(existing.memoryIds, normalized.memoryIds),
          topicIds: this.mergeUnique(existing.topicIds, normalized.topicIds),
          createdAt: existing.createdAt,
          updatedAt: normalized.updatedAt,
        }));
      } else {
        nextProjects.set(normalized.canonicalKey, normalized);
      }
    }
    const incomingKeys = new Set(nextProjects.keys());
    const archived = this.projects
      .filter((entry) => !incomingKeys.has(entry.canonicalKey))
      .map((entry) => this.normalizeProject({ ...entry, status: "archived" }));
    this.projects = [...nextProjects.values(), ...archived].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const project of this.projects) {
      await this.runtimeStore.upsertRuntimeRecord({
        kind: "project",
        id: project.id,
        sessionId: project.sourceSessionIds[0],
        agentId: project.agentId,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        payload: project as unknown as Record<string, unknown>,
      });
    }
  }

  getAll(): ProjectRecord[] {
    return [...this.projects];
  }

  findById(id: string): ProjectRecord | null {
    return this.projects.find((entry) => entry.id === id) ?? null;
  }

  findByCanonicalKey(canonicalKey: string): ProjectRecord | null {
    return this.projects.find((entry) => entry.canonicalKey === canonicalKey) ?? null;
  }

  private normalizeProject(project: ProjectRecord): ProjectRecord {
    const now = new Date().toISOString();
    return {
      ...project,
      agentId: project.agentId || this.agentId,
      canonicalKey: project.canonicalKey.trim(),
      title: project.title.trim() || project.canonicalKey,
      summary: project.summary?.trim() || "No summary recorded yet.",
      activeFocus: project.activeFocus?.trim() || "none recorded",
      currentDecision: project.currentDecision?.trim() || "none recorded",
      nextStep: project.nextStep?.trim() || "none recorded",
      todo: project.todo?.trim() || "none recorded",
      blocker: project.blocker?.trim() || "none recorded",
      risk: project.risk?.trim() || "none recorded",
      tags: this.mergeUnique(project.tags ?? []),
      sourceSessionIds: this.mergeUnique(project.sourceSessionIds ?? []),
      summaryIds: this.mergeUnique(project.summaryIds ?? []),
      memoryIds: this.mergeUnique(project.memoryIds ?? []),
      topicIds: this.mergeUnique(project.topicIds ?? []),
      createdAt: project.createdAt || now,
      updatedAt: project.updatedAt || now,
    };
  }

  private mergeUnique(...values: string[][]): string[] {
    return [...new Set(values.flat().filter((item) => typeof item === "string" && item.trim().length > 0))]
      .map((item) => item.trim());
  }
}

export class SQLiteKnowledgeRawRepository implements KnowledgeRawRepository {
  private entries: KnowledgeRawEntry[] = [];

  constructor(
    private readonly runtimeStore: SQLiteRuntimeStore,
    private readonly sessionId: string,
    private readonly agentId: string,
  ) {}

  async init(): Promise<void> {
    await this.runtimeStore.init();
    this.entries = this.runtimeStore.listRuntimeRecords("knowledge_raw", { agentId: this.agentId })
      .map((record) => this.normalizeEntry(record.payload as unknown as KnowledgeRawEntry));
  }

  async enqueue(entry: KnowledgeRawEntry): Promise<boolean> {
    const normalized = this.normalizeEntry(entry);
    if (this.findBySourceSummaryId(normalized.sourceSummaryId)) {
      return false;
    }
    this.entries.push(normalized);
    this.entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    await this.persist(normalized);
    return true;
  }

  getAll(): KnowledgeRawEntry[] {
    return [...this.entries];
  }

  findBySourceSummaryId(sourceSummaryId: string): KnowledgeRawEntry | null {
    return this.entries.find((entry) => entry.sourceSummaryId === sourceSummaryId) ?? null;
  }

  async claimPending(limit = 8): Promise<KnowledgeRawEntry[]> {
    const pending = this.entries
      .filter((entry) => entry.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, Math.max(limit, 1));
    if (pending.length === 0) {
      return [];
    }
    const now = new Date().toISOString();
    const claimedIds = new Set(pending.map((entry) => entry.id));
    const updated: KnowledgeRawEntry[] = [];
    this.entries = this.entries.map((entry) => {
      if (!claimedIds.has(entry.id)) {
        return entry;
      }
      const claimed = this.normalizeEntry({ ...entry, status: "processing", updatedAt: now });
      updated.push(claimed);
      return claimed;
    });
    for (const entry of updated) {
      await this.persist(entry);
    }
    return updated;
  }

  async markReview(args: {
    id: string;
    action: "approve" | "reject";
    reviewer?: string;
    note?: string;
  }): Promise<KnowledgeRawEntry | null> {
    const now = new Date().toISOString();
    let updated: KnowledgeRawEntry | null = null;
    this.entries = this.entries.map((entry) => {
      if (entry.id !== args.id) {
        return entry;
      }
      updated = this.normalizeEntry({
        ...entry,
        status: args.action === "approve" ? "pending" : "rejected",
        processReason: args.action === "approve" ? "manual_review_approved" : "manual_review_rejected",
        review: {
          mode: "manual",
          state: args.action === "approve" ? "approved" : "rejected",
          reviewedAt: now,
          reviewer: args.reviewer?.trim() || undefined,
          note: args.note?.trim() || undefined,
        },
        updatedAt: now,
        lastProcessedAt: args.action === "reject" ? now : entry.lastProcessedAt,
      });
      return updated;
    });
    if (updated) {
      await this.persist(updated);
    }
    return updated;
  }

  async markSettled(args: {
    id: string;
    status: "promoted" | "duplicate" | "skipped" | "failed";
    reason: string;
    docId?: string;
    slug?: string;
    version?: number;
    filePath?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const updated: KnowledgeRawEntry[] = [];
    this.entries = this.entries.map((entry) => {
      if (entry.id !== args.id) {
        return entry;
      }
      const settled = this.normalizeEntry({
        ...entry,
        status: args.status,
        processReason: args.reason,
        linkedDocId: args.docId,
        linkedSlug: args.slug,
        linkedVersion: args.version,
        linkedFilePath: args.filePath,
        lastProcessedAt: now,
        updatedAt: now,
      });
      updated.push(settled);
      return settled;
    });
    for (const entry of updated) {
      await this.persist(entry);
    }
  }

  private async persist(entry: KnowledgeRawEntry): Promise<void> {
    await this.runtimeStore.upsertRuntimeRecord({
      kind: "knowledge_raw",
      id: entry.id,
      sessionId: entry.sourceSummary.sessionId || this.sessionId,
      agentId: entry.sourceSummary.agentId ?? this.agentId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      payload: entry as unknown as Record<string, unknown>,
    });
  }

  private normalizeEntry(entry: KnowledgeRawEntry): KnowledgeRawEntry {
    const now = new Date().toISOString();
    return {
      ...entry,
      status: entry.status ?? "pending",
      oneLineSummary: entry.oneLineSummary?.trim() || this.truncateOneLine(entry.sourceSummary.summary),
      review: entry.review,
      intakeReason: entry.intakeReason.trim() || "accepted_for_knowledge_raw",
      processReason: entry.processReason?.trim() || undefined,
      linkedDocId: entry.linkedDocId?.trim() || undefined,
      linkedSlug: entry.linkedSlug?.trim() || undefined,
      linkedFilePath: entry.linkedFilePath?.trim() || undefined,
      createdAt: entry.createdAt || now,
      updatedAt: entry.updatedAt || entry.createdAt || now,
      sourceSummary: {
        ...entry.sourceSummary,
        recordStatus: entry.sourceSummary.recordStatus ?? "active",
        summaryLevel: entry.sourceSummary.summaryLevel ?? 1,
        nodeKind: entry.sourceSummary.nodeKind ?? "leaf",
        memoryType: entry.sourceSummary.memoryType ?? "general",
        promotionIntent: entry.sourceSummary.promotionIntent ?? "candidate",
        constraints: Array.isArray(entry.sourceSummary.constraints) ? entry.sourceSummary.constraints : [],
        decisions: Array.isArray(entry.sourceSummary.decisions) ? entry.sourceSummary.decisions : [],
        blockers: Array.isArray(entry.sourceSummary.blockers) ? entry.sourceSummary.blockers : [],
        nextSteps: Array.isArray(entry.sourceSummary.nextSteps) ? entry.sourceSummary.nextSteps : [],
        keyEntities: Array.isArray(entry.sourceSummary.keyEntities) ? entry.sourceSummary.keyEntities : [],
        exactFacts: Array.isArray(entry.sourceSummary.exactFacts) ? entry.sourceSummary.exactFacts : [],
        keywords: Array.isArray(entry.sourceSummary.keywords) ? entry.sourceSummary.keywords : [],
      },
      sourceBinding: entry.sourceBinding ?? SourceMessageResolver.bindingFromSummary(entry.sourceSummary),
    };
  }

  private truncateOneLine(value: string): string {
    return [...value.replace(/\s+/g, " ").trim()].slice(0, 20).join("");
  }
}
