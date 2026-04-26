import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { EvidenceAtomEntry, EvidenceAtomRepository } from "../types";
import { atomicWriteFile } from "../utils/atomicFile";

interface EvidenceAtomFileV1 {
  schemaVersion: 1;
  atoms: EvidenceAtomEntry[];
}

export class EvidenceAtomStore implements EvidenceAtomRepository {
  private readonly filePath: string;
  private atoms: EvidenceAtomEntry[] = [];

  constructor(private readonly baseDir: string, private readonly agentId: string) {
    this.filePath = path.join(baseDir, `${agentId}.evidence-atoms.json`);
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as EvidenceAtomFileV1 | EvidenceAtomEntry[];
      this.atoms = Array.isArray(parsed)
        ? this.normalize(parsed)
        : this.normalize(parsed.atoms ?? []);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async upsertMany(entries: EvidenceAtomEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const byId = new Map(this.atoms.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      byId.set(entry.id, this.normalizeOne(entry));
    }
    this.atoms = this.normalize([...byId.values()]);
    await this.flush();
  }

  getAll(options: { sessionId?: string } = {}): EvidenceAtomEntry[] {
    return this.atoms.filter((entry) => !options.sessionId || entry.sessionId === options.sessionId);
  }

  search(query: string, options: { sessionId?: string; limit?: number } = {}): EvidenceAtomEntry[] {
    const terms = this.queryTerms(query);
    if (terms.length === 0) {
      return [];
    }
    const limit = Math.max(1, Math.min(options.limit ?? 12, 50));
    return this.getAll({ sessionId: options.sessionId })
      .map((entry) => ({ entry, score: this.score(entry, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) =>
        right.score - left.score ||
        right.entry.importance - left.entry.importance ||
        left.entry.startTurn - right.entry.startTurn,
      )
      .slice(0, limit)
      .map((item) => item.entry);
  }

  async removeSession(sessionId: string): Promise<number> {
    const before = this.atoms.length;
    this.atoms = this.atoms.filter((entry) => entry.sessionId !== sessionId);
    const removed = before - this.atoms.length;
    if (removed > 0) {
      await this.flush();
    }
    return removed;
  }

  private score(entry: EvidenceAtomEntry, terms: string[]): number {
    const haystack = [
      entry.text,
      entry.retrievalText,
      entry.type,
      entry.tags.join(" "),
      entry.projectId ?? "",
      entry.topicId ?? "",
    ].join(" ").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += term.length >= 6 ? 5 : 3;
      }
    }
    score += Math.round(entry.importance * 3);
    return score;
  }

  private queryTerms(query: string): string[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .flatMap((term) => this.expandCjkTerm(term));
    return [...new Set(terms)].slice(0, 80);
  }

  private expandCjkTerm(term: string): string[] {
    if (!/[\u4e00-\u9fff]/.test(term) || term.length <= 4) {
      return [term];
    }
    const terms = [term];
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index <= term.length - size; index += 1) {
        terms.push(term.slice(index, index + size));
      }
    }
    return terms;
  }

  private normalize(entries: EvidenceAtomEntry[]): EvidenceAtomEntry[] {
    return entries
      .map((entry) => this.normalizeOne(entry))
      .sort((left, right) =>
        left.sessionId.localeCompare(right.sessionId) ||
        left.startTurn - right.startTurn ||
        left.type.localeCompare(right.type) ||
        left.id.localeCompare(right.id),
      );
  }

  private normalizeOne(entry: EvidenceAtomEntry): EvidenceAtomEntry {
    return {
      ...entry,
      recordStatus: entry.recordStatus ?? "active",
      atomStatus: entry.atomStatus ?? "candidate",
      tags: [...new Set(entry.tags ?? [])],
      sourceMessageIds: [...new Set(entry.sourceMessageIds ?? [])],
      confidence: Number.isFinite(entry.confidence) ? entry.confidence : 0.7,
      importance: Number.isFinite(entry.importance) ? entry.importance : 0.5,
      stability: Number.isFinite(entry.stability) ? entry.stability : 0.5,
      sourceTraceComplete: entry.sourceTraceComplete ?? Boolean(entry.sourceBinding || entry.sourceHash),
    };
  }

  private async flush(): Promise<void> {
    const payload: EvidenceAtomFileV1 = {
      schemaVersion: 1,
      atoms: this.atoms,
    };
    await atomicWriteFile(this.filePath, JSON.stringify(payload, null, 2));
  }
}
