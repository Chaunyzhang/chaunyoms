import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  KnowledgeDocBucket,
  KnowledgeDocumentIndexEntry,
  KnowledgePromotionDraft,
  KnowledgePromotionResult,
  PromotionLedgerEntry,
  SummaryEntry,
} from "../types";

interface KnowledgeDocumentIndexFileV1 {
  schemaVersion: 1;
  documents: KnowledgeDocumentIndexEntry[];
}

interface PromotionLedgerFileV1 {
  schemaVersion: 1;
  entries: PromotionLedgerEntry[];
}

const README_CONTENT = `# ChaunyOMS Knowledge Base

This directory stores git-friendly Markdown knowledge promoted from historical conversations.

- decisions/: versioned decision records
- patterns/: reusable engineering patterns
- facts/: stable facts and constraints
- incidents/: incident write-ups and postmortems
- indexes/: promotion ledger and document index
`;

export class KnowledgeMarkdownStore {
  private documents: KnowledgeDocumentIndexEntry[] = [];
  private ledger: PromotionLedgerEntry[] = [];
  private initialized = false;

  private readonly indexesDir: string;
  private readonly ledgerPath: string;
  private readonly documentIndexPath: string;

  constructor(private readonly baseDir: string) {
    this.indexesDir = path.join(baseDir, "indexes");
    this.ledgerPath = path.join(this.indexesDir, "promotion-ledger.json");
    this.documentIndexPath = path.join(this.indexesDir, "document-index.json");
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(this.baseDir, { recursive: true });
    await Promise.all([
      mkdir(path.join(this.baseDir, "decisions"), { recursive: true }),
      mkdir(path.join(this.baseDir, "patterns"), { recursive: true }),
      mkdir(path.join(this.baseDir, "facts"), { recursive: true }),
      mkdir(path.join(this.baseDir, "incidents"), { recursive: true }),
      mkdir(this.indexesDir, { recursive: true }),
    ]);

    await this.ensureFile(path.join(this.baseDir, "README.md"), README_CONTENT);
    this.documents = await this.loadDocumentIndex();
    this.ledger = await this.loadLedger();
    this.initialized = true;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  findPromotion(summary: SummaryEntry): PromotionLedgerEntry | null {
    return (
      this.ledger.find((entry) => {
        if (entry.summaryEntryId === summary.id) {
          return true;
        }
        return (
          entry.startTurn === summary.startTurn &&
          entry.endTurn === summary.endTurn &&
          entry.sourceHash === summary.sourceHash &&
          entry.sourceMessageCount === summary.sourceMessageCount
        );
      }) ?? null
    );
  }

  searchRelatedDocuments(query: string, limit = 3): KnowledgeDocumentIndexEntry[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return [];
    }

    return [...this.documents]
      .map((entry) => ({
        entry,
        score: this.scoreDocument(entry, terms),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
      })
      .slice(0, Math.max(limit, 1))
      .map((item) => item.entry);
  }

  async writePromotion(
    summary: SummaryEntry,
    draft: KnowledgePromotionDraft,
    metadata: {
      sessionId: string;
      sourceHash?: string;
      sourceMessageCount?: number;
      promptVersion: string;
      modelName?: string;
    },
  ): Promise<KnowledgePromotionResult> {
    await this.init();

    const existingPromotion = this.findPromotion(summary);
    if (existingPromotion) {
      return {
        status: existingPromotion.status === "promoted" ? "duplicate" : existingPromotion.status,
        reason: `summary_already_${existingPromotion.status}`,
        docId: existingPromotion.docId,
        slug: existingPromotion.slug,
        version: existingPromotion.version,
        filePath: existingPromotion.filePath,
      };
    }

    if (!draft.shouldWrite) {
      await this.recordLedger({
        id: this.buildId(`ledger:${summary.id}:skip`),
        sessionId: metadata.sessionId,
        summaryEntryId: summary.id,
        sourceHash: metadata.sourceHash,
        sourceMessageCount: metadata.sourceMessageCount,
        startTurn: summary.startTurn,
        endTurn: summary.endTurn,
        status: "skipped",
        reason: draft.reason || "model_declined_promotion",
        promptVersion: metadata.promptVersion,
        createdAt: new Date().toISOString(),
      });
      return {
        status: "skipped",
        reason: draft.reason || "model_declined_promotion",
      };
    }

    const normalizedDraft = this.normalizeDraft(draft, summary);
    const existingDocument = this.findDocument(normalizedDraft);
    const contentHash = this.hash(
      `${normalizedDraft.title}\n${normalizedDraft.summary}\n${normalizedDraft.body}`,
    );

    if (
      existingDocument &&
      existingDocument.versions.at(-1)?.contentHash === contentHash
    ) {
      const latestVersion = existingDocument.versions.at(-1);
      await this.recordLedger({
        id: this.buildId(`ledger:${summary.id}:duplicate`),
        sessionId: metadata.sessionId,
        summaryEntryId: summary.id,
        sourceHash: metadata.sourceHash,
        sourceMessageCount: metadata.sourceMessageCount,
        startTurn: summary.startTurn,
        endTurn: summary.endTurn,
        status: "duplicate",
        reason: "latest_document_version_already_matches",
        promptVersion: metadata.promptVersion,
        createdAt: new Date().toISOString(),
        docId: existingDocument.docId,
        slug: existingDocument.slug,
        version: latestVersion?.version,
        filePath: latestVersion
          ? path.join(this.baseDir, existingDocument.bucket, latestVersion.fileName)
          : undefined,
      });
      return {
        status: "duplicate",
        reason: "latest_document_version_already_matches",
        draft: normalizedDraft,
        docId: existingDocument.docId,
        slug: existingDocument.slug,
        version: latestVersion?.version,
        filePath: latestVersion
          ? path.join(this.baseDir, existingDocument.bucket, latestVersion.fileName)
          : undefined,
      };
    }

    const nextVersion = (existingDocument?.latestVersion ?? 0) + 1;
    const fileName = `${normalizedDraft.slug}-v${nextVersion}.md`;
    const docId = `${normalizedDraft.slug}-v${nextVersion}`;
    const bucketDir = path.join(this.baseDir, normalizedDraft.bucket);
    const filePath = path.join(bucketDir, fileName);
    const frontmatter = this.buildFrontmatter({
      docId,
      version: nextVersion,
      summary,
      draft: normalizedDraft,
      metadata,
    });

    await writeFile(filePath, `${frontmatter}\n${normalizedDraft.body.trim()}\n`, "utf8");

    const versionRecord = {
      version: nextVersion,
      docId,
      fileName,
      createdAt: new Date().toISOString(),
      contentHash,
      summaryEntryId: summary.id,
    };

    if (existingDocument) {
      existingDocument.title = normalizedDraft.title;
      existingDocument.latestVersion = nextVersion;
      existingDocument.latestFile = fileName;
      existingDocument.summary = normalizedDraft.summary;
      existingDocument.tags = normalizedDraft.tags;
      existingDocument.canonicalKey = normalizedDraft.canonicalKey;
      existingDocument.status = normalizedDraft.status;
      existingDocument.updatedAt = versionRecord.createdAt;
      existingDocument.versions.push(versionRecord);
    } else {
      this.documents.push({
        docId,
        slug: normalizedDraft.slug,
        bucket: normalizedDraft.bucket,
        title: normalizedDraft.title,
        latestVersion: nextVersion,
        latestFile: fileName,
        summary: normalizedDraft.summary,
        tags: normalizedDraft.tags,
        canonicalKey: normalizedDraft.canonicalKey,
        status: normalizedDraft.status,
        updatedAt: versionRecord.createdAt,
        versions: [versionRecord],
      });
    }

    this.documents = this.normalizeDocuments(this.documents);
    await this.flushDocumentIndex();
    await this.recordLedger({
      id: this.buildId(`ledger:${summary.id}:promoted`),
      sessionId: metadata.sessionId,
      summaryEntryId: summary.id,
      sourceHash: metadata.sourceHash,
      sourceMessageCount: metadata.sourceMessageCount,
      startTurn: summary.startTurn,
      endTurn: summary.endTurn,
      status: "promoted",
      reason: normalizedDraft.reason,
      promptVersion: metadata.promptVersion,
      createdAt: versionRecord.createdAt,
      docId,
      slug: normalizedDraft.slug,
      version: nextVersion,
      filePath,
    });

    return {
      status: "promoted",
      reason: normalizedDraft.reason,
      draft: normalizedDraft,
      docId,
      slug: normalizedDraft.slug,
      version: nextVersion,
      filePath,
    };
  }

  private normalizeDraft(
    draft: KnowledgePromotionDraft,
    summary: SummaryEntry,
  ): KnowledgePromotionDraft {
    const slug = this.slugify(draft.slug || draft.title || `knowledge-${summary.startTurn}-${summary.endTurn}`);
    return {
      shouldWrite: draft.shouldWrite,
      reason: draft.reason || "knowledge_promoted_from_compaction",
      bucket: draft.bucket,
      slug,
      title: draft.title.trim() || `Knowledge ${summary.startTurn}-${summary.endTurn}`,
      summary: draft.summary.trim() || summary.summary.trim(),
      tags: [...new Set(draft.tags.map((tag) => this.slugify(tag)).filter(Boolean))],
      canonicalKey: this.slugify(draft.canonicalKey || slug),
      body: draft.body.trim(),
      status: draft.status,
    };
  }

  private findDocument(draft: KnowledgePromotionDraft): KnowledgeDocumentIndexEntry | null {
    return (
      this.documents.find((entry) => entry.canonicalKey === draft.canonicalKey) ??
      this.documents.find((entry) => entry.slug === draft.slug) ??
      null
    );
  }

  private buildFrontmatter(args: {
    docId: string;
    version: number;
    summary: SummaryEntry;
    draft: KnowledgePromotionDraft;
    metadata: {
      sessionId: string;
      sourceHash?: string;
      sourceMessageCount?: number;
      promptVersion: string;
      modelName?: string;
    };
  }): string {
    const { docId, version, summary, draft, metadata } = args;
    const lines = [
      "---",
      `id: ${docId}`,
      `slug: ${draft.slug}`,
      `version: ${version}`,
      `bucket: ${draft.bucket}`,
      `title: ${this.escapeFrontmatterValue(draft.title)}`,
      `status: ${draft.status}`,
      `summary: ${this.escapeFrontmatterValue(draft.summary)}`,
      `canonical_key: ${draft.canonicalKey}`,
      `session_id: ${metadata.sessionId}`,
      `summary_entry_id: ${summary.id}`,
      `turn_range: "${summary.startTurn}-${summary.endTurn}"`,
      `source_hash: ${metadata.sourceHash ?? ""}`,
      `source_message_count: ${metadata.sourceMessageCount ?? 0}`,
      `prompt_version: ${metadata.promptVersion}`,
      `model: ${metadata.modelName ?? "fallback"}`,
      `updated_at: ${new Date().toISOString()}`,
      "tags:",
      ...draft.tags.map((tag) => `  - ${tag}`),
      "---",
      "",
    ];
    return lines.join("\n");
  }

  private async loadDocumentIndex(): Promise<KnowledgeDocumentIndexEntry[]> {
    try {
      const raw = await readFile(this.documentIndexPath, "utf8");
      const parsed = JSON.parse(raw) as KnowledgeDocumentIndexFileV1;
      return Array.isArray(parsed.documents) ? parsed.documents : [];
    } catch {
      const docs = await this.rebuildDocumentsFromFilesystem();
      this.documents = docs;
      await this.flushDocumentIndex();
      return docs;
    }
  }

  private async loadLedger(): Promise<PromotionLedgerEntry[]> {
    try {
      const raw = await readFile(this.ledgerPath, "utf8");
      const parsed = JSON.parse(raw) as PromotionLedgerFileV1;
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      await this.flushLedger();
      return [];
    }
  }

  private async rebuildDocumentsFromFilesystem(): Promise<KnowledgeDocumentIndexEntry[]> {
    const buckets: KnowledgeDocBucket[] = ["decisions", "patterns", "facts", "incidents"];
    const docs: KnowledgeDocumentIndexEntry[] = [];
    for (const bucket of buckets) {
      const dir = path.join(this.baseDir, bucket);
      let files: string[] = [];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files.filter((name) => /-v\d+\.md$/i.test(name))) {
        const content = await readFile(path.join(dir, file), "utf8");
        const metadata = this.parseFrontmatter(content);
        if (!metadata.slug || !metadata.id || !metadata.title) {
          continue;
        }
        const version = Number(metadata.version ?? this.extractVersion(file));
        const existing = docs.find((item) => item.slug === metadata.slug);
        const versionRecord = {
          version,
          docId: String(metadata.id),
          fileName: file,
          createdAt: String(metadata.updated_at ?? new Date().toISOString()),
          contentHash: this.hash(content),
          summaryEntryId: String(metadata.summary_entry_id ?? "unknown-summary"),
        };
        if (existing) {
          existing.latestVersion = Math.max(existing.latestVersion, version);
          if (existing.latestVersion === version) {
            existing.latestFile = file;
            existing.docId = String(metadata.id);
            existing.title = String(metadata.title);
            existing.summary = String(metadata.summary ?? "");
            existing.tags = this.normalizeTagList(metadata.tags);
            existing.status = (metadata.status as KnowledgeDocumentIndexEntry["status"]) ?? "active";
            existing.updatedAt = String(metadata.updated_at ?? versionRecord.createdAt);
            existing.canonicalKey = String(metadata.canonical_key ?? metadata.slug);
          }
          existing.versions.push(versionRecord);
        } else {
          docs.push({
            docId: String(metadata.id),
            slug: String(metadata.slug),
            bucket,
            title: String(metadata.title),
            latestVersion: version,
            latestFile: file,
            summary: String(metadata.summary ?? ""),
            tags: this.normalizeTagList(metadata.tags),
            canonicalKey: String(metadata.canonical_key ?? metadata.slug),
            status: (metadata.status as KnowledgeDocumentIndexEntry["status"]) ?? "active",
            updatedAt: String(metadata.updated_at ?? versionRecord.createdAt),
            versions: [versionRecord],
          });
        }
      }
    }
    return this.normalizeDocuments(docs);
  }

  private normalizeDocuments(entries: KnowledgeDocumentIndexEntry[]): KnowledgeDocumentIndexEntry[] {
    return [...entries]
      .map((entry) => ({
        ...entry,
        versions: [...entry.versions].sort((a, b) => a.version - b.version),
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private scoreDocument(entry: KnowledgeDocumentIndexEntry, terms: string[]): number {
    const haystack = `${entry.slug} ${entry.title} ${entry.summary} ${entry.tags.join(" ")}`.toLowerCase();
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

  private async recordLedger(entry: PromotionLedgerEntry): Promise<void> {
    this.ledger.push(entry);
    await this.flushLedger();
  }

  private async flushDocumentIndex(): Promise<void> {
    const payload: KnowledgeDocumentIndexFileV1 = {
      schemaVersion: 1,
      documents: this.documents,
    };
    await writeFile(this.documentIndexPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private async flushLedger(): Promise<void> {
    const payload: PromotionLedgerFileV1 = {
      schemaVersion: 1,
      entries: this.ledger,
    };
    await writeFile(this.ledgerPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private async ensureFile(filePath: string, content: string): Promise<void> {
    try {
      await readFile(filePath, "utf8");
    } catch {
      await writeFile(filePath, content, "utf8");
    }
  }

  private parseFrontmatter(content: string): Record<string, unknown> {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
      return {};
    }
    const result: Record<string, unknown> = {};
    let currentArrayKey: string | null = null;
    for (const rawLine of match[1].split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        continue;
      }
      const arrayMatch = line.match(/^\s*-\s+(.+)$/);
      if (arrayMatch && currentArrayKey) {
        const existing = Array.isArray(result[currentArrayKey]) ? result[currentArrayKey] as string[] : [];
        existing.push(arrayMatch[1].trim());
        result[currentArrayKey] = existing;
        continue;
      }
      const keyValue = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
      if (!keyValue) {
        continue;
      }
      const [, key, value] = keyValue;
      if (!value) {
        currentArrayKey = key;
        result[key] = [];
        continue;
      }
      currentArrayKey = null;
      result[key] = value.replace(/^"|"$/g, "").trim();
    }
    return result;
  }

  private normalizeTagList(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  private escapeFrontmatterValue(value: string): string {
    return JSON.stringify(value);
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "knowledge-doc";
  }

  private extractVersion(fileName: string): number {
    const match = fileName.match(/-v(\d+)\.md$/i);
    return match ? Number(match[1]) : 1;
  }

  private buildId(input: string): string {
    return this.hash(input).slice(0, 24);
  }

  private hash(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  }
}
