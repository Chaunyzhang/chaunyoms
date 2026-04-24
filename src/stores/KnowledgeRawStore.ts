import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { KnowledgeRawEntry, KnowledgeRawRepository } from "../types";
import { atomicWriteFile } from "../utils/atomicFile";
import { SourceMessageResolver } from "../resolvers/SourceMessageResolver";

interface KnowledgeRawFileV1 {
  schemaVersion: 1;
  entries: KnowledgeRawEntry[];
}

export class KnowledgeRawStore implements KnowledgeRawRepository {
  private readonly filePath: string;
  private entries: KnowledgeRawEntry[] = [];

  constructor(private readonly baseDir: string, private readonly sessionId: string) {
    this.filePath = path.join(baseDir, `${sessionId}.knowledge-raw.json`);
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as KnowledgeRawFileV1 | KnowledgeRawEntry[];
      const entries = Array.isArray(parsed) ? parsed : parsed.entries;
      this.entries = Array.isArray(entries)
        ? entries.map((entry) => this.normalizeEntry(entry))
        : [];
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async enqueue(entry: KnowledgeRawEntry): Promise<boolean> {
    const normalized = this.normalizeEntry(entry);
    if (this.findBySourceSummaryId(normalized.sourceSummaryId)) {
      return false;
    }
    this.entries.push(normalized);
    this.entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    await this.flush();
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
    this.entries = this.entries.map((entry) => (
      claimedIds.has(entry.id)
        ? this.normalizeEntry({
            ...entry,
            status: "processing",
            updatedAt: now,
          })
        : entry
    ));
    await this.flush();
    return pending.map((entry) => this.normalizeEntry({
      ...entry,
      status: "processing",
      updatedAt: now,
    }));
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
    this.entries = this.entries.map((entry) => (
      entry.id === args.id
        ? this.normalizeEntry({
            ...entry,
            status: args.status,
            processReason: args.reason,
            linkedDocId: args.docId,
            linkedSlug: args.slug,
            linkedVersion: args.version,
            linkedFilePath: args.filePath,
            lastProcessedAt: now,
            updatedAt: now,
          })
        : entry
    ));
    await this.flush();
  }

  private normalizeEntry(entry: KnowledgeRawEntry): KnowledgeRawEntry {
    const now = new Date().toISOString();
    return {
      ...entry,
      status: entry.status ?? "pending",
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

  private async flush(): Promise<void> {
    const payload: KnowledgeRawFileV1 = {
      schemaVersion: 1,
      entries: this.entries,
    };
    await atomicWriteFile(this.filePath, JSON.stringify(payload, null, 2));
  }
}
