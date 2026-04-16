import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SummaryEntry } from "../types";

interface SummaryIndexFileV1 {
  schemaVersion: 1;
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

  async addSummary(entry: SummaryEntry): Promise<void> {
    this.summaries.push(entry);
    this.summaries.sort((left, right) => left.startTurn - right.startTurn);
    await this.flush();
  }

  getAllSummaries(): SummaryEntry[] {
    return [...this.summaries];
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
      const haystack = `${entry.summary} ${entry.keywords.join(" ")}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
  }

  getTotalTokens(): number {
    return this.summaries.reduce((total, entry) => total + entry.tokenCount, 0);
  }

  private async flush(): Promise<void> {
    const payload: SummaryIndexFileV1 = {
      schemaVersion: 1,
      summaries: this.summaries,
    };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  private parsePersistedContent(content: string): SummaryEntry[] {
    const parsed = JSON.parse(content) as SummaryEntry[] | SummaryIndexFileV1;
    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schemaVersion === 1 &&
      Array.isArray(parsed.summaries)
    ) {
      return parsed.summaries;
    }

    throw new Error("Unsupported summary index schema");
  }
}
