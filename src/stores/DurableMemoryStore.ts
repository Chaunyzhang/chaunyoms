import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DurableMemoryEntry } from "../types";

interface DurableMemoryFileV2 {
  schemaVersion: 2;
  memories: DurableMemoryEntry[];
}

export class DurableMemoryStore {
  private readonly filePath: string;
  private memories: DurableMemoryEntry[] = [];

  constructor(private readonly baseDir: string, private readonly sessionId: string) {
    this.filePath = path.join(baseDir, `${sessionId}.durable-memory.json`);
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as DurableMemoryFileV2 | DurableMemoryEntry[];
      const entries = Array.isArray(parsed) ? parsed : parsed.memories;
      this.memories = Array.isArray(entries) ? [...entries] : [];
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async addEntries(entries: DurableMemoryEntry[]): Promise<number> {
    let added = 0;
    for (const entry of entries) {
      if (this.memories.some((item) => item.fingerprint === entry.fingerprint)) {
        continue;
      }
      this.memories.push(entry);
      added += 1;
    }

    if (added > 0) {
      await this.flush();
    }
    return added;
  }

  search(query: string, limit = 5): DurableMemoryEntry[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return [];
    }

    return [...this.memories]
      .map((entry) => ({
        entry,
        score: this.scoreEntry(entry, terms),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.entry.createdAt.localeCompare(left.entry.createdAt);
      })
      .slice(0, Math.max(limit, 1))
      .map((item) => item.entry);
  }

  getAll(): DurableMemoryEntry[] {
    return [...this.memories];
  }

  count(): number {
    return this.memories.length;
  }

  private scoreEntry(entry: DurableMemoryEntry, terms: string[]): number {
    const haystack = `${entry.kind} ${entry.tags.join(" ")} ${entry.text}`.toLowerCase();
    let score = 0;

    for (const term of terms) {
      if (haystack.includes(term)) {
        score += term.length >= 6 ? 3 : 2;
      }
    }

    if (terms.every((term) => haystack.includes(term))) {
      score += 4;
    }

    return score;
  }

  private async flush(): Promise<void> {
    const payload: DurableMemoryFileV2 = {
      schemaVersion: 2,
      memories: this.memories,
    };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }
}
