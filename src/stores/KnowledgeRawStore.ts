import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { KnowledgeRawEntry } from "../types";
import { buildStableEventId } from "../utils/projectIdentity";

interface KnowledgeRawFileV1 {
  schemaVersion: 1;
  entries: KnowledgeRawEntry[];
}

export class KnowledgeRawStore {
  private readonly filePath: string;
  private entries: KnowledgeRawEntry[] = [];

  constructor(private readonly baseDir: string, private readonly sessionId: string) {
    this.filePath = path.join(baseDir, `${sessionId}.knowledge-raw.json`);
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as KnowledgeRawFileV1 | KnowledgeRawEntry[];
      const entries = Array.isArray(parsed) ? parsed : parsed.entries;
      this.entries = Array.isArray(entries) ? entries.map((entry) => this.normalizeEntry(entry)) : [];
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async addEntries(entries: KnowledgeRawEntry[]): Promise<number> {
    let added = 0;
    for (const rawEntry of entries) {
      const entry = this.normalizeEntry(rawEntry);
      if (this.entries.some((item) => item.fingerprint === entry.fingerprint && item.recordStatus !== "archived")) {
        continue;
      }
      this.entries.push(entry);
      added += 1;
    }

    if (added > 0) {
      this.entries = this.entries
        .map((entry) => this.normalizeEntry(entry))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      await this.flush();
    }
    return added;
  }

  async replaceAll(entries: KnowledgeRawEntry[]): Promise<void> {
    this.entries = entries
      .map((entry) => this.normalizeEntry(entry))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    await this.flush();
  }

  getAll(): KnowledgeRawEntry[] {
    return [...this.entries];
  }

  count(): number {
    return this.entries.filter((entry) => entry.recordStatus === "active").length;
  }

  private async flush(): Promise<void> {
    const payload: KnowledgeRawFileV1 = {
      schemaVersion: 1,
      entries: this.entries,
    };
    await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }

  private normalizeEntry(entry: KnowledgeRawEntry): KnowledgeRawEntry {
    return {
      ...entry,
      eventId: entry.eventId ?? buildStableEventId("knowledge-raw", `${entry.id}|${entry.createdAt}`),
      recordStatus: entry.recordStatus ?? "active",
      tags: Array.isArray(entry.tags) ? [...new Set(entry.tags)] : [],
      sourceIds: Array.isArray(entry.sourceIds) ? [...new Set(entry.sourceIds)] : [],
      memoryIntent: entry.memoryIntent ?? "none",
      memoryIntentConfidence:
        typeof entry.memoryIntentConfidence === "number" ? entry.memoryIntentConfidence : 0,
      memoryIntentTrigger:
        typeof entry.memoryIntentTrigger === "string" ? entry.memoryIntentTrigger : undefined,
      stabilityScore:
        typeof entry.stabilityScore === "number" ? entry.stabilityScore : 0,
      reusabilityScore:
        typeof entry.reusabilityScore === "number" ? entry.reusabilityScore : 0,
    };
  }
}
