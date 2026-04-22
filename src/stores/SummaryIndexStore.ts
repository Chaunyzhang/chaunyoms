import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SummaryEntry } from "../types";

interface SummaryIndexFileV2 {
  schemaVersion: 2;
  summaries: SummaryEntry[];
}

export class SummaryIndexStore {
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

    this.summaries.push(entry);
    this.summaries = this.normalizeSummaries(this.summaries);
    await this.flush();
    return true;
  }

  getAllSummaries(): SummaryEntry[] {
    return [...this.summaries];
  }

  getCoveredTurns(): Set<number> {
    const coveredTurns = new Set<number>();
    for (const summary of this.summaries) {
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
  ): SummaryEntry | null {
    return (
      this.summaries.find((summary) => {
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

        return !sourceHash || !summary.sourceHash;
      }) ?? null
    );
  }

  search(query: string): SummaryEntry[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);

    if (terms.length === 0) {
      return [];
    }

    return this.summaries.filter((entry) => {
      const haystack = [
        entry.summary,
        entry.keywords.join(" "),
        entry.constraints.join(" "),
        entry.decisions.join(" "),
        entry.blockers.join(" "),
        entry.exactFacts.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
  }

  getTotalTokens(): number {
    return this.summaries.reduce((total, entry) => total + entry.tokenCount, 0);
  }

  private async flush(): Promise<void> {
    const payload: SummaryIndexFileV2 = {
      schemaVersion: 2,
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
      (parsed.schemaVersion === 1 || parsed.schemaVersion === 2) &&
      Array.isArray(parsed.summaries)
    ) {
      return this.normalizeSummaries(parsed.summaries);
    }

    throw new Error("Unsupported summary index schema");
  }

  private findEquivalentSummary(entry: SummaryEntry): SummaryEntry | null {
    return this.findBySourceCoverage(
      entry.startTurn,
      entry.endTurn,
      entry.sourceHash,
      entry.sourceMessageCount,
    );
  }

  private normalizeSummaries(entries: SummaryEntry[]): SummaryEntry[] {
    const normalized: SummaryEntry[] = [];
    const seen = new Set<string>();

    for (const entry of [...entries].sort((left, right) => {
      if (left.startTurn !== right.startTurn) {
        return left.startTurn - right.startTurn;
      }
      if (left.endTurn !== right.endTurn) {
        return left.endTurn - right.endTurn;
      }
      return left.createdAt.localeCompare(right.createdAt);
    })) {
      const key = this.buildDedupKey(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push({
        ...entry,
        constraints: Array.isArray(entry.constraints) ? entry.constraints : [],
        decisions: Array.isArray(entry.decisions) ? entry.decisions : [],
        blockers: Array.isArray(entry.blockers) ? entry.blockers : [],
        exactFacts: Array.isArray(entry.exactFacts) ? entry.exactFacts : [],
      });
    }

    return normalized;
  }

  private buildDedupKey(entry: SummaryEntry): string {
    if (
      typeof entry.sourceHash === "string" &&
      entry.sourceHash.length > 0 &&
      typeof entry.sourceMessageCount === "number"
    ) {
      return `${entry.startTurn}:${entry.endTurn}:${entry.sourceHash}:${entry.sourceMessageCount}`;
    }
    return `${entry.startTurn}:${entry.endTurn}`;
  }
}
