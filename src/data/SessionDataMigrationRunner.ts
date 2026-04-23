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

  async inspectPending(): Promise<Array<{ storeKey: string; from: number; to: number }>> {
    const pending: Array<{ storeKey: string; from: number; to: number }> = [];

    const raw = await this.inspectRawMessages();
    if (raw) pending.push(raw);

    const summaries = await this.inspectSummaries();
    if (summaries) pending.push(summaries);

    const durable = await this.inspectDurableMemory();
    if (durable) pending.push(durable);

    return pending;
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

  private async inspectRawMessages(): Promise<{ storeKey: string; from: number; to: number } | null> {
    const filePath = path.join(this.baseDir, `${this.sessionId}.raw.jsonl`);
    let content = "";
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return null;
    }

    const lines = content.split(/\r?\n/).filter(Boolean);
    const missingSequence = lines.some((line) => {
      const parsed = JSON.parse(line) as RawMessage;
      return !Number.isFinite(parsed.sequence);
    });
    return missingSequence ? { storeKey: "raw_messages", from: 1, to: 2 } : null;
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
      memoryType: typeof entry.memoryType === "string" ? entry.memoryType : "general",
      phase: typeof entry.phase === "string" ? entry.phase : undefined,
      constraints: Array.isArray(entry.constraints) ? entry.constraints : [],
      decisions: Array.isArray(entry.decisions) ? entry.decisions : [],
      blockers: Array.isArray(entry.blockers) ? entry.blockers : [],
      nextSteps: Array.isArray(entry.nextSteps) ? entry.nextSteps : [],
      keyEntities: Array.isArray(entry.keyEntities) ? entry.keyEntities : [],
      exactFacts: Array.isArray(entry.exactFacts) ? entry.exactFacts : [],
      promotionIntent: typeof entry.promotionIntent === "string" ? entry.promotionIntent : "candidate",
    }));

    const needsRewrite =
      incomingVersion < 2 ||
      normalized.some(
        (entry, index) =>
          entry.constraints !== entries[index]?.constraints ||
          entry.decisions !== entries[index]?.decisions ||
          entry.blockers !== entries[index]?.blockers ||
          entry.nextSteps !== entries[index]?.nextSteps ||
          entry.keyEntities !== entries[index]?.keyEntities ||
          entry.exactFacts !== entries[index]?.exactFacts ||
          entry.memoryType !== entries[index]?.memoryType ||
          entry.phase !== entries[index]?.phase ||
          entry.promotionIntent !== entries[index]?.promotionIntent,
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

  private async inspectSummaries(): Promise<{ storeKey: string; from: number; to: number } | null> {
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
    const needsRewrite =
      incomingVersion < 2 ||
      entries.some(
        (entry) =>
          !Array.isArray(entry.constraints) ||
          !Array.isArray(entry.decisions) ||
          !Array.isArray(entry.blockers) ||
          !Array.isArray(entry.nextSteps) ||
          !Array.isArray(entry.keyEntities) ||
          !Array.isArray(entry.exactFacts) ||
          typeof entry.memoryType !== "string" ||
          typeof entry.promotionIntent !== "string",
      );

    return needsRewrite
      ? { storeKey: "summaries", from: Math.max(incomingVersion, 0), to: 2 }
      : null;
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

  private async inspectDurableMemory(): Promise<{ storeKey: string; from: number; to: number } | null> {
    const filePath = path.join(this.baseDir, `${this.sessionId}.durable-memory.json`);
    let raw = "";
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return null;
    }

    const parsed = JSON.parse(raw) as DurableMemoryEntry[] | { schemaVersion?: number; memories?: DurableMemoryEntry[] };
    const incomingVersion = Array.isArray(parsed) ? 0 : Number(parsed.schemaVersion ?? 0);

    return incomingVersion < 2
      ? { storeKey: "durable_memory", from: Math.max(incomingVersion, 0), to: 2 }
      : null;
  }
}
