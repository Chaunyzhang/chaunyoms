import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SummaryEntry, SummaryRepository } from "../types";
import { buildStableEventId } from "../utils/projectIdentity";

const SUMMARY_PHASES = new Set([
  "planning",
  "implementation",
  "validation",
  "fixing",
  "review",
  "active",
]);

interface SummaryIndexFileV3 {
  schemaVersion: 3;
  summaries: SummaryEntry[];
}

export class SummaryIndexStore implements SummaryRepository {
  private readonly filePath: string;
  private summaries: SummaryEntry[] = [];

  constructor(private readonly baseDir: string, private readonly sessionId: string) {
    this.filePath = path.join(baseDir, `${sessionId}.summaries.json`);
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    try {
      const content = await readFile(this.filePath, "utf8");
      this.summaries = this.parsePersistedContent(content);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async addSummary(entry: SummaryEntry): Promise<boolean> {
    if (this.findEquivalentSummary(entry)) {
      return false;
    }

    this.summaries.push(this.normalizeSummary(entry));
    this.summaries = this.normalizeSummaries(this.summaries);
    await this.flush();
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
    await this.flush();
  }

  async attachParent(parentSummaryId: string, childSummaryIds: string[]): Promise<void> {
    let changed = false;
    this.summaries = this.summaries.map((summary) => {
      if (!childSummaryIds.includes(summary.id)) {
        return summary;
      }
      changed = true;
      return this.normalizeSummary({
        ...summary,
        parentSummaryId,
      });
    });

    const parent = this.summaries.find((summary) => summary.id === parentSummaryId);
    if (parent) {
      const mergedChildren = [...new Set([...(parent.childSummaryIds ?? []), ...childSummaryIds])];
      this.summaries = this.summaries.map((summary) =>
        summary.id === parentSummaryId
          ? this.normalizeSummary({ ...summary, childSummaryIds: mergedChildren })
          : summary,
      );
      changed = true;
    }

    if (changed) {
      this.summaries = this.normalizeSummaries(this.summaries);
      await this.flush();
    }
  }

  getAllSummaries(options: { sessionId?: string } = {}): SummaryEntry[] {
    return this.filterBySession(this.summaries, options);
  }

  getActiveSummaries(options: { sessionId?: string } = {}): SummaryEntry[] {
    return this.filterBySession(this.summaries, options).filter((entry) => entry.recordStatus === "active");
  }

  getRootSummaries(options: { sessionId?: string } = {}): SummaryEntry[] {
    return this.getActiveSummaries(options).filter((entry) => !entry.parentSummaryId);
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
    return (
      this.summaries.find((summary) => {
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

        if (
          Array.isArray(summary.sourceSummaryIds) &&
          Array.isArray((summary as SummaryEntry).sourceSummaryIds) &&
          summary.sourceSummaryIds.length > 0
        ) {
          return false;
        }

        return !sourceHash || !summary.sourceHash;
      }) ?? null
    );
  }

  search(query: string, options: { sessionId?: string } = {}): SummaryEntry[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);

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
      ]
        .join(" ")
        .toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
  }

  getTotalTokens(options: { sessionId?: string } = {}): number {
    return this.getActiveSummaries(options).reduce((total, entry) => total + entry.tokenCount, 0);
  }

  private async flush(): Promise<void> {
    const payload: SummaryIndexFileV3 = {
      schemaVersion: 3,
      summaries: this.summaries,
    };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  private parsePersistedContent(content: string): SummaryEntry[] {
    const parsed = JSON.parse(content) as SummaryEntry[] | { schemaVersion?: number; summaries?: SummaryEntry[] };
    if (Array.isArray(parsed)) {
      return this.normalizeSummaries(parsed);
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.schemaVersion === 1 || parsed.schemaVersion === 2 || parsed.schemaVersion === 3) &&
      Array.isArray(parsed.summaries)
    ) {
      return this.normalizeSummaries(parsed.summaries);
    }

    throw new Error("Unsupported summary index schema");
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

    for (const entry of [...entries].sort((left, right) => {
      if ((left.summaryLevel ?? 1) !== (right.summaryLevel ?? 1)) {
        return (left.summaryLevel ?? 1) - (right.summaryLevel ?? 1);
      }
      if (left.startTurn !== right.startTurn) {
        return left.startTurn - right.startTurn;
      }
      if (left.endTurn !== right.endTurn) {
        return left.endTurn - right.endTurn;
      }
      return left.createdAt.localeCompare(right.createdAt);
    })) {
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
    const normalized: SummaryEntry = {
      ...entry,
      eventId: entry.eventId ?? buildStableEventId("summary", `${entry.id}|${entry.createdAt}`),
      projectId: entry.projectId?.trim() || undefined,
      topicId: entry.topicId?.trim() || undefined,
      recordStatus: entry.recordStatus ?? "active",
      childSummaryIds: [...new Set(entry.childSummaryIds ?? [])],
      sourceSummaryIds: [...new Set(entry.sourceSummaryIds ?? [])],
      sourceMessageIds: [...new Set(entry.sourceMessageIds ?? [])],
      sourceBinding: entry.sourceBinding,
      summaryLevel: entry.summaryLevel ?? 1,
      nodeKind: entry.nodeKind ?? (entry.sourceSummaryIds && entry.sourceSummaryIds.length > 0 ? "branch" : "leaf"),
      memoryType: entry.memoryType ?? "general",
      phase: this.normalizePhase(entry.phase),
      constraints: Array.isArray(entry.constraints) ? entry.constraints : [],
      decisions: Array.isArray(entry.decisions) ? entry.decisions : [],
      blockers: Array.isArray(entry.blockers) ? entry.blockers : [],
      nextSteps: Array.isArray(entry.nextSteps) ? [...new Set(entry.nextSteps)] : [],
      keyEntities: Array.isArray(entry.keyEntities) ? [...new Set(entry.keyEntities)] : [],
      exactFacts: Array.isArray(entry.exactFacts) ? entry.exactFacts : [],
      promotionIntent: entry.promotionIntent ?? "candidate",
      keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
    };

    const childSummaryIds = normalized.childSummaryIds ?? [];
    const sourceSummaryIds = normalized.sourceSummaryIds ?? [];
    if (normalized.nodeKind === "branch" && childSummaryIds.length === 0 && sourceSummaryIds.length > 0) {
      normalized.childSummaryIds = [...sourceSummaryIds];
    }
    return normalized;
  }

  private normalizePhase(value: SummaryEntry["phase"]): SummaryEntry["phase"] {
    const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
    return SUMMARY_PHASES.has(candidate) ? candidate as SummaryEntry["phase"] : undefined;
  }

  private buildDedupKey(entry: SummaryEntry): string {
    if (Array.isArray(entry.sourceSummaryIds) && entry.sourceSummaryIds.length > 0) {
      return `${entry.sessionId}:${entry.summaryLevel}:${entry.sourceSummaryIds.join("|")}`;
    }
    if (
      typeof entry.sourceHash === "string" &&
      entry.sourceHash.length > 0 &&
      typeof entry.sourceMessageCount === "number"
    ) {
      return `${entry.sessionId}:${entry.startTurn}:${entry.endTurn}:${entry.sourceHash}:${entry.sourceMessageCount}`;
    }
    return `${entry.sessionId}:${entry.startTurn}:${entry.endTurn}:${entry.summaryLevel}`;
  }

  private filterBySession(entries: SummaryEntry[], options: { sessionId?: string }): SummaryEntry[] {
    return entries.filter((entry) => this.matchesSession(entry, options));
  }

  private matchesSession(entry: SummaryEntry, options: { sessionId?: string }): boolean {
    return !options.sessionId || entry.sessionId === options.sessionId;
  }
}
