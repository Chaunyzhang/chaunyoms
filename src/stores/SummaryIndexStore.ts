import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SummaryEntry } from "../types";

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
      this.summaries = JSON.parse(content) as SummaryEntry[];
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
    await writeFile(this.filePath, JSON.stringify(this.summaries, null, 2), "utf8");
  }
}
