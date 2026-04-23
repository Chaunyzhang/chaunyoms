import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DurableMemoryEntry } from "../types";
import { buildStableEventId } from "../utils/projectIdentity";

interface DurableMemoryFileV3 {
  schemaVersion: 3;
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
      const parsed = JSON.parse(content) as DurableMemoryFileV3 | DurableMemoryEntry[];
      const entries = Array.isArray(parsed) ? parsed : parsed.memories;
      this.memories = Array.isArray(entries) ? entries.map((entry) => this.normalizeEntry(entry)) : [];
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
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
      this.memories.push(entry);
      added += 1;
    }

    if (added > 0) {
      this.memories = this.memories
        .map((entry) => this.normalizeEntry(entry))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
      .filter((entry) => entry.recordStatus === "active")
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
    return this.memories.filter((entry) => entry.recordStatus === "active").length;
  }

  private supersedeActiveProjectState(projectId: string, supersededById: string): void {
    this.memories = this.memories.map((entry) => {
      if (entry.kind !== "project_state" || entry.projectId !== projectId || entry.recordStatus !== "active") {
        return entry;
      }
      return this.normalizeEntry({
        ...entry,
        recordStatus: "superseded",
        supersededById,
      });
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

    return score;
  }

  private async flush(): Promise<void> {
    const payload: DurableMemoryFileV3 = {
      schemaVersion: 3,
      memories: this.memories,
    };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
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
