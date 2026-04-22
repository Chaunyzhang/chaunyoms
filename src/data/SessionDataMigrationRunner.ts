import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DurableMemoryEntry, RawMessage, SummaryEntry } from "../types";

interface SummaryIndexFileV2 {
  schemaVersion: 2;
  summaries: SummaryEntry[];
}

interface DurableMemoryFileV2 {
  schemaVersion: 2;
  memories: DurableMemoryEntry[];
}

export class SessionDataMigrationRunner {
  constructor(private readonly baseDir: string, private readonly sessionId: string) {}

  async runAll(): Promise<Array<{ storeKey: string; from: number; to: number }>> {
    await mkdir(this.baseDir, { recursive: true });
    const upgraded: Array<{ storeKey: string; from: number; to: number }> = [];

    const raw = await this.migrateRawMessages();
    if (raw) upgraded.push(raw);

    const summaries = await this.migrateSummaries();
    if (summaries) upgraded.push(summaries);

    const durable = await this.migrateDurableMemory();
    if (durable) upgraded.push(durable);

    return upgraded;
  }

  private async migrateRawMessages(): Promise<{ storeKey: string; from: number; to: number } | null> {
    const filePath = path.join(this.baseDir, `${this.sessionId}.raw.jsonl`);
    let content = "";
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return null;
    }

    const lines = content.split(/\r?\n/).filter(Boolean);
    let changed = false;
    let nextSequence = 1;
    const migrated = lines.map((line) => {
      const parsed = JSON.parse(line) as RawMessage;
      if (!Number.isFinite(parsed.sequence)) {
        parsed.sequence = nextSequence;
        changed = true;
      }
      nextSequence = Math.max(nextSequence, (parsed.sequence ?? 0) + 1);
      return parsed;
    });

    if (!changed) {
      return null;
    }

    await writeFile(
      filePath,
      `${migrated.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    return { storeKey: "raw_messages", from: 1, to: 2 };
  }

  private async migrateSummaries(): Promise<{ storeKey: string; from: number; to: number } | null> {
    const filePath = path.join(this.baseDir, `${this.sessionId}.summaries.json`);
    let raw = "";
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return null;
    }

    const parsed = JSON.parse(raw) as SummaryEntry[] | { schemaVersion?: number; summaries?: SummaryEntry[] };
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.summaries) ? parsed.summaries : [];
    const incomingVersion = Array.isArray(parsed) ? 0 : Number(parsed.schemaVersion ?? 0);
    const normalized = entries.map((entry) => ({
      ...entry,
      constraints: Array.isArray(entry.constraints) ? entry.constraints : [],
      decisions: Array.isArray(entry.decisions) ? entry.decisions : [],
      blockers: Array.isArray(entry.blockers) ? entry.blockers : [],
      exactFacts: Array.isArray(entry.exactFacts) ? entry.exactFacts : [],
    }));

    const needsRewrite =
      incomingVersion < 2 ||
      normalized.some(
        (entry, index) =>
          entry.constraints !== entries[index]?.constraints ||
          entry.decisions !== entries[index]?.decisions ||
          entry.blockers !== entries[index]?.blockers ||
          entry.exactFacts !== entries[index]?.exactFacts,
      );

    if (!needsRewrite) {
      return null;
    }

    const payload: SummaryIndexFileV2 = {
      schemaVersion: 2,
      summaries: normalized,
    };
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    return { storeKey: "summaries", from: Math.max(incomingVersion, 0), to: 2 };
  }

  private async migrateDurableMemory(): Promise<{ storeKey: string; from: number; to: number } | null> {
    const filePath = path.join(this.baseDir, `${this.sessionId}.durable-memory.json`);
    let raw = "";
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return null;
    }

    const parsed = JSON.parse(raw) as DurableMemoryEntry[] | { schemaVersion?: number; memories?: DurableMemoryEntry[] };
    const memories = Array.isArray(parsed) ? parsed : Array.isArray(parsed.memories) ? parsed.memories : [];
    const incomingVersion = Array.isArray(parsed) ? 0 : Number(parsed.schemaVersion ?? 0);

    if (incomingVersion >= 2) {
      return null;
    }

    const payload: DurableMemoryFileV2 = {
      schemaVersion: 2,
      memories,
    };
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    return { storeKey: "durable_memory", from: Math.max(incomingVersion, 0), to: 2 };
  }
}
