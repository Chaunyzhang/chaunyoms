import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  KnowledgeDocBucket,
  KnowledgeDocVersionRecord,
  KnowledgeDocumentRecord,
  KnowledgeDocumentIndexEntry,
  KnowledgePromotionDraft,
  KnowledgePromotionResult,
  KnowledgeRepository,
  KnowledgeTrustModel,
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

const README_CONTENT = `# ChaunyOMS Unified Knowledge

This directory stores the unified ChaunyOMS knowledge corpus.

- raw/: user-provided raw knowledge notes; files dropped here are indexed with the same retrieval weight as AI-promoted knowledge
- raw/system/: system intake artifacts written before AI-generated promotions are finalized
- decisions/: versioned decision records
- patterns/: reusable engineering patterns
- facts/: stable facts and constraints
- incidents/: incident write-ups and postmortems
- indexes/: promotion ledger and document index
- origin is provenance metadata only; retrieval does not split knowledge by source-class weights
`;

const VERSIONED_BUCKETS: Exclude<KnowledgeDocBucket, "raw">[] = [
  "decisions",
  "patterns",
  "facts",
  "incidents",
];

export class KnowledgeMarkdownStore implements KnowledgeRepository {
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
      mkdir(path.join(this.baseDir, "raw"), { recursive: true }),
      mkdir(path.join(this.baseDir, "raw", "system"), { recursive: true }),
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
    this.refreshManualRawDocuments();
    const terms = this.queryTerms(query);
    if (terms.length === 0) {
      return [];
    }

    return [...this.documents]
      .map((entry) => ({
        entry,
        score: this.scoreDocument(entry, terms, query),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        const governanceDelta = this.governanceWeight(right.entry) - this.governanceWeight(left.entry);
        if (governanceDelta !== 0) {
          return governanceDelta;
        }
        return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
      })
      .slice(0, Math.max(limit, 1))
      .map((item) => item.entry);
  }

  async getById(id: string): Promise<KnowledgeDocumentRecord | null> {
    await this.init();
    const match = this.findDocumentById(id);
    if (!match) {
      return null;
    }
    const filePath = path.join(this.baseDir, match.entry.bucket, match.version.fileName);
    const content = await readFile(filePath, "utf8");
    return {
      entry: match.entry,
      version: match.version,
      filePath,
      content,
    };
  }

  listVersions(canonicalKey: string): KnowledgeDocumentIndexEntry["versions"] {
    const entry = this.documents.find((item) => item.canonicalKey === canonicalKey);
    return entry ? [...entry.versions] : [];
  }

  async markSuperseded(id: string, byId: string): Promise<boolean> {
    await this.init();
    const match = this.findDocumentById(id);
    if (!match) {
      return false;
    }
    match.entry.status = "superseded";
    match.entry.supersededById = byId;
    match.entry.updatedAt = new Date().toISOString();
    this.documents = this.normalizeDocuments(this.documents);
    await this.flushDocumentIndex();
    await this.updateLatestFrontmatter(match.entry);
    return true;
  }

  async reconcile(canonicalKey: string): Promise<KnowledgeDocumentIndexEntry | null> {
    await this.init();
    this.documents = await this.rebuildDocumentsFromFilesystem();
    await this.flushDocumentIndex();
    return this.documents.find((entry) => entry.canonicalKey === canonicalKey) ?? null;
  }

  async linkToSummary(id: string, summaryId: string): Promise<boolean> {
    await this.init();
    const match = this.findDocumentById(id);
    if (!match || !summaryId.trim()) {
      return false;
    }
    match.entry.linkedSummaryIds = this.uniqueStrings([
      ...(match.entry.linkedSummaryIds ?? []),
      summaryId.trim(),
    ]);
    match.entry.updatedAt = new Date().toISOString();
    this.documents = this.normalizeDocuments(this.documents);
    await this.flushDocumentIndex();
    await this.updateLatestFrontmatter(match.entry);
    return true;
  }

  async linkToSource(id: string, sourceRef: string): Promise<boolean> {
    await this.init();
    const match = this.findDocumentById(id);
    if (!match || !sourceRef.trim()) {
      return false;
    }
    match.entry.sourceRefs = this.uniqueStrings([
      ...(match.entry.sourceRefs ?? []),
      sourceRef.trim(),
    ]);
    match.entry.updatedAt = new Date().toISOString();
    this.documents = this.normalizeDocuments(this.documents);
    await this.flushDocumentIndex();
    await this.updateLatestFrontmatter(match.entry);
    return true;
  }

  describeTrustModel(): KnowledgeTrustModel {
    return {
      owner: "chaunyoms",
      layer: "unified_knowledge",
      writable: true,
      versioned: true,
      requiresProvenance: true,
      notes: [
        "This repository stores AI-promoted and user-provided knowledge as one unified corpus.",
        "Origin is tracked as provenance metadata only; retrieval does not split internal vs external weights.",
        "User raw files can be dropped into raw/ and are indexed as first-class knowledge.",
        "AI-generated promotions write a system raw intake artifact before the final versioned document is committed.",
        "Documents must keep provenance back to summaries and source references.",
        "Knowledge can be superseded, reconciled, and version-audited.",
        "Search ranking prefers active, provenance-rich, better-governed records over weaker duplicates.",
        "Semantic duplicate detection links new evidence onto existing records before creating another near-clone.",
      ],
    };
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
    await this.writePromotionRawIntake(summary, draft, metadata);

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
    const semanticDuplicate = existingDocument
      ? null
      : this.findSemanticDuplicate(normalizedDraft);
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

    if (semanticDuplicate) {
      const latestVersion = semanticDuplicate.versions.at(-1);
      await this.linkPromotionEvidence(semanticDuplicate, summary, metadata);
      await this.recordLedger({
        id: this.buildId(`ledger:${summary.id}:semantic-duplicate`),
        sessionId: metadata.sessionId,
        summaryEntryId: summary.id,
        sourceHash: metadata.sourceHash,
        sourceMessageCount: metadata.sourceMessageCount,
        startTurn: summary.startTurn,
        endTurn: summary.endTurn,
        status: "duplicate",
        reason: "semantic_duplicate_of_existing_document",
        promptVersion: metadata.promptVersion,
        createdAt: new Date().toISOString(),
        docId: semanticDuplicate.docId,
        slug: semanticDuplicate.slug,
        version: latestVersion?.version,
        filePath: latestVersion
          ? path.join(this.baseDir, semanticDuplicate.bucket, latestVersion.fileName)
          : undefined,
      });
      return {
        status: "duplicate",
        reason: "semantic_duplicate_of_existing_document",
        draft: normalizedDraft,
        docId: semanticDuplicate.docId,
        slug: semanticDuplicate.slug,
        version: latestVersion?.version,
        filePath: latestVersion
          ? path.join(this.baseDir, semanticDuplicate.bucket, latestVersion.fileName)
          : undefined,
      };
    }

    const nextVersion = (existingDocument?.latestVersion ?? 0) + 1;
    const fileName = `${normalizedDraft.slug}-v${nextVersion}.md`;
    const docId = `${normalizedDraft.slug}-v${nextVersion}`;
    const bucketDir = path.join(this.baseDir, normalizedDraft.bucket);
    const filePath = path.join(bucketDir, fileName);
    const sourceRefs = this.buildPromotionSourceRefs(summary, metadata);
    const frontmatter = this.buildFrontmatter({
      docId,
      version: nextVersion,
      summary,
      draft: normalizedDraft,
      metadata,
      sourceRefs,
      linkedSummaryIds: [summary.id],
      supersededById: existingDocument?.supersededById,
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
      existingDocument.origin = "synthesized";
      existingDocument.status = normalizedDraft.status;
      existingDocument.linkedSummaryIds = this.uniqueStrings([
        ...(existingDocument.linkedSummaryIds ?? []),
        summary.id,
      ]);
      existingDocument.sourceRefs = this.uniqueStrings([
        ...(existingDocument.sourceRefs ?? []),
        ...sourceRefs,
      ]);
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
        origin: "synthesized",
        status: normalizedDraft.status,
        linkedSummaryIds: [summary.id],
        sourceRefs,
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

  private findSemanticDuplicate(draft: KnowledgePromotionDraft): KnowledgeDocumentIndexEntry | null {
    const draftText = [draft.title, draft.summary, draft.body, draft.canonicalKey, ...draft.tags].join(" ");
    const draftTerms = this.queryTerms(draftText);
    const candidates = this.documents
      .filter((entry) => entry.status !== "superseded")
      .map((entry) => ({
        entry,
        score:
          this.computeSimilarity(
          draftText,
          this.loadEntrySearchText(entry),
        ) +
          this.computeTermOverlapScore(draftTerms, this.queryTerms(this.loadEntrySearchText(entry))),
      }))
      .filter((item) => item.score >= 0.3)
      .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt));
    return candidates[0]?.entry ?? null;
  }

  private async linkPromotionEvidence(
    entry: KnowledgeDocumentIndexEntry,
    summary: SummaryEntry,
    metadata: {
      sessionId: string;
      sourceHash?: string;
      sourceMessageCount?: number;
      promptVersion: string;
      modelName?: string;
    },
  ): Promise<void> {
    const sourceRefs = this.buildPromotionSourceRefs(summary, metadata);
    entry.linkedSummaryIds = this.uniqueStrings([
      ...(entry.linkedSummaryIds ?? []),
      summary.id,
    ]);
    entry.sourceRefs = this.uniqueStrings([
      ...(entry.sourceRefs ?? []),
      ...sourceRefs,
    ]);
    entry.updatedAt = new Date().toISOString();
    this.documents = this.normalizeDocuments(this.documents);
    await this.flushDocumentIndex();
    await this.updateLatestFrontmatter(entry);
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
    sourceRefs: string[];
    linkedSummaryIds: string[];
    supersededById?: string;
    origin?: KnowledgeDocumentIndexEntry["origin"];
  }): string {
    const { docId, version, summary, draft, metadata, sourceRefs, linkedSummaryIds, supersededById, origin } = args;
    const lines = [
      "---",
      `id: ${docId}`,
      `slug: ${draft.slug}`,
      `version: ${version}`,
      `bucket: ${draft.bucket}`,
      `origin: ${origin ?? "synthesized"}`,
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
      `superseded_by_id: ${supersededById ?? ""}`,
      `updated_at: ${new Date().toISOString()}`,
      "linked_summary_ids:",
      ...linkedSummaryIds.map((summaryId) => `  - ${summaryId}`),
      "source_refs:",
      ...sourceRefs.map((sourceRef) => `  - ${this.escapeFrontmatterValue(sourceRef)}`),
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
    const docs: KnowledgeDocumentIndexEntry[] = [];
    for (const bucket of VERSIONED_BUCKETS) {
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
            existing.origin = this.normalizeOrigin(metadata.origin);
            existing.status = (metadata.status as KnowledgeDocumentIndexEntry["status"]) ?? "active";
            existing.supersededById = this.normalizeOptionalString(metadata.superseded_by_id);
            existing.updatedAt = String(metadata.updated_at ?? versionRecord.createdAt);
            existing.canonicalKey = String(metadata.canonical_key ?? metadata.slug);
          }
          existing.linkedSummaryIds = this.uniqueStrings([
            ...existing.linkedSummaryIds,
            ...this.normalizeTagList(metadata.linked_summary_ids),
            ...(this.normalizeOptionalString(metadata.summary_entry_id)
              ? [String(metadata.summary_entry_id)]
              : []),
          ]);
          existing.sourceRefs = this.uniqueStrings([
            ...existing.sourceRefs,
            ...this.normalizeTagList(metadata.source_refs),
          ]);
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
            origin: this.normalizeOrigin(metadata.origin),
            status: (metadata.status as KnowledgeDocumentIndexEntry["status"]) ?? "active",
            supersededById: this.normalizeOptionalString(metadata.superseded_by_id),
            linkedSummaryIds: this.uniqueStrings([
              ...this.normalizeTagList(metadata.linked_summary_ids),
              ...(this.normalizeOptionalString(metadata.summary_entry_id)
                ? [String(metadata.summary_entry_id)]
                : []),
            ]),
            sourceRefs: this.uniqueStrings(this.normalizeTagList(metadata.source_refs)),
            updatedAt: String(metadata.updated_at ?? versionRecord.createdAt),
            versions: [versionRecord],
          });
        }
      }
    }
    return this.normalizeDocuments([
      ...docs,
      ...(await this.rebuildManualRawDocumentsFromFilesystem()),
    ]);
  }

  private normalizeDocuments(entries: KnowledgeDocumentIndexEntry[]): KnowledgeDocumentIndexEntry[] {
    return [...entries]
      .map((entry) => ({
        ...entry,
        tags: this.uniqueStrings(entry.tags ?? []),
        linkedSummaryIds: this.uniqueStrings(entry.linkedSummaryIds ?? []),
        sourceRefs: this.uniqueStrings(entry.sourceRefs ?? []),
        origin: this.normalizeOrigin(entry.origin),
        versions: [...entry.versions].sort((a, b) => a.version - b.version),
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private scoreDocument(
    entry: KnowledgeDocumentIndexEntry,
    terms: string[],
    query: string,
  ): number {
    const haystack = `${entry.slug} ${entry.canonicalKey} ${entry.title} ${entry.summary} ${entry.tags.join(" ")} ${entry.sourceRefs.join(" ")}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += term.length >= 6 ? 3 : 2;
      }
    }
    if (terms.length > 0 && terms.every((term) => haystack.includes(term))) {
      score += 4;
    }
    const similarity = this.computeSimilarity(query, haystack);
    if (similarity >= 0.12) {
      score += Math.round(similarity * 20);
    }
    score += this.governanceWeight(entry);
    return score;
  }

  private governanceWeight(entry: KnowledgeDocumentIndexEntry): number {
    let score = 0;
    if (entry.status === "active") {
      score += 5;
    } else if (entry.status === "draft") {
      score += 2;
    } else {
      score -= 2;
    }
    if (entry.origin === "synthesized" || entry.origin === "native") {
      score += 2;
    }
    score += Math.min(entry.sourceRefs.length, 3);
    score += Math.min(entry.linkedSummaryIds.length, 2);
    score += Math.min(entry.versions.length, 2);
    return score;
  }

  private queryTerms(query: string): string[] {
    const baseTerms = query
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    const synonyms = new Map<string, string[]>([
      ["retry", ["backoff", "retries"]],
      ["backoff", ["retry", "retries"]],
      ["knowledge", ["docs", "reference", "manual"]],
      ["constraint", ["rule", "must", "limit"]],
      ["状态", ["进度", "当前"]],
      ["知识库", ["文档", "资料"]],
    ]);
    const expanded = [...baseTerms];
    for (const term of baseTerms) {
      expanded.push(...(synonyms.get(term) ?? []));
    }
    return [...new Set(expanded)];
  }

  private computeSimilarity(left: string, right: string): number {
    const leftSet = this.buildTrigramSet(left.toLowerCase());
    const rightSet = this.buildTrigramSet(right.toLowerCase());
    if (leftSet.size === 0 || rightSet.size === 0) {
      return 0;
    }
    let intersection = 0;
    for (const item of leftSet) {
      if (rightSet.has(item)) {
        intersection += 1;
      }
    }
    return intersection / Math.max(leftSet.size, rightSet.size);
  }

  private computeTermOverlapScore(left: string[], right: string[]): number {
    if (left.length === 0 || right.length === 0) {
      return 0;
    }
    const rightSet = new Set(right);
    const matches = left.filter((term) => rightSet.has(term)).length;
    return matches / Math.max(left.length, right.length);
  }

  private buildTrigramSet(value: string): Set<string> {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length < 3) {
      return new Set(normalized ? [normalized] : []);
    }
    const grams = new Set<string>();
    for (let index = 0; index <= normalized.length - 3; index += 1) {
      grams.add(normalized.slice(index, index + 3));
    }
    return grams;
  }

  private loadEntrySearchText(entry: KnowledgeDocumentIndexEntry): string {
    const latestVersion = entry.versions.at(-1);
    let body = "";
    if (latestVersion) {
      const filePath = path.join(this.baseDir, entry.bucket, latestVersion.fileName);
      try {
        body = readFileSync(filePath, "utf8");
      } catch {
        body = "";
      }
    }
    return [
      entry.title,
      entry.summary,
      entry.canonicalKey,
      ...entry.tags,
      body,
    ].join(" ");
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

  private flushDocumentIndexSync(): void {
    const payload: KnowledgeDocumentIndexFileV1 = {
      schemaVersion: 1,
      documents: this.documents,
    };
    writeFileSync(this.documentIndexPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private async flushLedger(): Promise<void> {
    const payload: PromotionLedgerFileV1 = {
      schemaVersion: 1,
      entries: this.ledger,
    };
    await writeFile(this.ledgerPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private findDocumentById(
    id: string,
  ): { entry: KnowledgeDocumentIndexEntry; version: KnowledgeDocVersionRecord } | null {
    for (const entry of this.documents) {
      const version =
        entry.versions.find((item) => item.docId === id) ??
        (entry.docId === id ? entry.versions.at(-1) ?? null : null);
      if (version) {
        return { entry, version };
      }
    }
    return null;
  }

  private buildPromotionSourceRefs(
    summary: SummaryEntry,
    metadata: {
      sessionId: string;
      sourceHash?: string;
      sourceMessageCount?: number;
      promptVersion: string;
      modelName?: string;
    },
  ): string[] {
    const refs = [
      `session:${metadata.sessionId}:turns:${summary.startTurn}-${summary.endTurn}`,
      summary.agentId ? `agent:${summary.agentId}` : null,
      typeof summary.sourceBinding?.sequenceMin === "number" &&
        typeof summary.sourceBinding?.sequenceMax === "number"
        ? `session:${summary.sourceBinding.sessionId}:sequences:${summary.sourceBinding.sequenceMin}-${summary.sourceBinding.sequenceMax}`
        : null,
      summary.sourceBinding?.messageIds && summary.sourceBinding.messageIds.length > 0
        ? `session:${summary.sourceBinding.sessionId}:messages:${summary.sourceBinding.messageIds[0]}..${summary.sourceBinding.messageIds[summary.sourceBinding.messageIds.length - 1]}`
        : null,
      summary.sourceHash ? `summary_hash:${summary.sourceHash}` : null,
      typeof metadata.sourceMessageCount === "number"
        ? `message_count:${metadata.sourceMessageCount}`
        : null,
    ].filter((value): value is string => Boolean(value));
    return this.uniqueStrings(refs);
  }

  private async writePromotionRawIntake(
    summary: SummaryEntry,
    draft: KnowledgePromotionDraft,
    metadata: {
      sessionId: string;
      sourceHash?: string;
      sourceMessageCount?: number;
      promptVersion: string;
      modelName?: string;
    },
  ): Promise<void> {
    const rawDir = path.join(this.baseDir, "raw", "system");
    await mkdir(rawDir, { recursive: true });
    const slug = this.slugify(draft.slug || draft.title || summary.id);
    const filePath = path.join(rawDir, `${slug}-${this.slugify(summary.id)}.md`);
    const frontmatter = [
      "---",
      `id: system-raw-${this.buildId(`${summary.id}:${metadata.promptVersion}`)}`,
      `slug: ${slug}`,
      `origin: synthesized`,
      `title: ${this.escapeFrontmatterValue(draft.title || summary.summary.slice(0, 80) || summary.id)}`,
      `summary_entry_id: ${summary.id}`,
      `session_id: ${metadata.sessionId}`,
      `source_hash: ${metadata.sourceHash ?? ""}`,
      `prompt_version: ${metadata.promptVersion}`,
      `model: ${metadata.modelName ?? "fallback"}`,
      "tags:",
      "  - system-intake",
      "---",
      "",
    ].join("\n");
    const body = [
      `# ${draft.title || "Knowledge raw intake"}`,
      "",
      "## Source summary",
      "",
      summary.summary,
      "",
      "## AI draft",
      "",
      draft.body || draft.summary || "",
    ].join("\n");
    await writeFile(filePath, `${frontmatter}${body.trim()}\n`, "utf8");
  }

  private refreshManualRawDocuments(): void {
    try {
      const rawDocuments = this.rebuildManualRawDocumentsFromFilesystemSync();
      const nonRawDocuments = this.documents.filter((entry) => entry.bucket !== "raw");
      this.documents = this.normalizeDocuments([...nonRawDocuments, ...rawDocuments]);
      this.flushDocumentIndexSync();
    } catch {
      // Manual raw indexing is best-effort; versioned unified knowledge remains usable.
    }
  }

  private async rebuildManualRawDocumentsFromFilesystem(): Promise<KnowledgeDocumentIndexEntry[]> {
    const rawDir = path.join(this.baseDir, "raw");
    const files = await this.readRawCandidateFiles(rawDir);
    const docs: KnowledgeDocumentIndexEntry[] = [];
    for (const filePath of files) {
      const content = await readFile(filePath, "utf8");
      const fileStat = await stat(filePath);
      docs.push(this.buildRawDocumentEntry(filePath, content, fileStat.mtime.toISOString()));
    }
    return docs;
  }

  private rebuildManualRawDocumentsFromFilesystemSync(): KnowledgeDocumentIndexEntry[] {
    const rawDir = path.join(this.baseDir, "raw");
    const files = this.readRawCandidateFilesSync(rawDir);
    return files.map((filePath) => {
      const content = readFileSync(filePath, "utf8");
      const fileStat = statSync(filePath);
      return this.buildRawDocumentEntry(filePath, content, fileStat.mtime.toISOString());
    });
  }

  private async readRawCandidateFiles(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name === "system") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.readRawCandidateFiles(fullPath));
      } else if (/\.(md|txt|json)$/i.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files.sort();
  }

  private readRawCandidateFilesSync(dir: string): string[] {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name === "system") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.readRawCandidateFilesSync(fullPath));
      } else if (/\.(md|txt|json)$/i.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files.sort();
  }

  private buildRawDocumentEntry(
    filePath: string,
    content: string,
    updatedAt: string,
  ): KnowledgeDocumentIndexEntry {
    const rawDir = path.join(this.baseDir, "raw");
    const relativePath = path.relative(rawDir, filePath);
    const metadata = this.parseFrontmatter(content);
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    const title = this.normalizeOptionalString(metadata.title) ??
      this.firstHeading(body) ??
      path.basename(filePath, path.extname(filePath));
    const slug = this.slugify(
      this.normalizeOptionalString(metadata.slug) ??
        path.basename(filePath, path.extname(filePath)),
    );
    const canonicalKey = this.slugify(
      this.normalizeOptionalString(metadata.canonical_key) ??
        this.normalizeOptionalString(metadata.canonicalKey) ??
        slug,
    );
    const docId = this.normalizeOptionalString(metadata.id) ??
      `raw-${this.hash(path.normalize(relativePath)).slice(0, 16)}`;
    const summary = this.normalizeOptionalString(metadata.summary) ??
      this.previewBody(body || content);
    const tags = this.normalizeTagList(metadata.tags);
    const sourceRefs = this.uniqueStrings([
      `raw:${relativePath.replace(/\\/g, "/")}`,
      ...this.normalizeTagList(metadata.source_refs),
    ]);
    return {
      docId,
      slug,
      bucket: "raw",
      title,
      latestVersion: 1,
      latestFile: relativePath,
      summary,
      tags,
      canonicalKey,
      origin: this.normalizeOrigin(metadata.origin ?? "manual"),
      status: "active",
      linkedSummaryIds: this.uniqueStrings(this.normalizeTagList(metadata.linked_summary_ids)),
      sourceRefs,
      updatedAt,
      versions: [{
        version: 1,
        docId,
        fileName: relativePath,
        createdAt: updatedAt,
        contentHash: this.hash(content),
        summaryEntryId: this.normalizeOptionalString(metadata.summary_entry_id) ?? "manual-raw",
      }],
    };
  }

  private async updateLatestFrontmatter(entry: KnowledgeDocumentIndexEntry): Promise<void> {
    const latestVersion = entry.versions.at(-1);
    if (!latestVersion) {
      return;
    }
    const filePath = path.join(this.baseDir, entry.bucket, latestVersion.fileName);
    const content = await readFile(filePath, "utf8");
    const metadata = this.parseFrontmatter(content);
    const [startTurn, endTurn] = this.parseTurnRange(metadata.turn_range);
    const rebuilt = this.buildFrontmatter({
      docId: latestVersion.docId,
      version: latestVersion.version,
      summary: {
        id:
          this.normalizeOptionalString(metadata.summary_entry_id) ??
          latestVersion.summaryEntryId,
        startTurn,
        endTurn,
        summary: entry.summary,
      } as SummaryEntry,
      draft: {
        shouldWrite: true,
        reason: "frontmatter_metadata_refresh",
        bucket: entry.bucket,
        slug: entry.slug,
        title: entry.title,
        summary: entry.summary,
        tags: entry.tags,
        canonicalKey: entry.canonicalKey,
        body: "",
        status: entry.status === "superseded" ? "active" : entry.status,
      },
      metadata: {
        sessionId: this.normalizeOptionalString(metadata.session_id) ?? "unknown",
        sourceHash: this.normalizeOptionalString(metadata.source_hash),
        sourceMessageCount: Number(metadata.source_message_count ?? 0) || undefined,
        promptVersion: this.normalizeOptionalString(metadata.prompt_version) ?? "unknown",
        modelName: this.normalizeOptionalString(metadata.model) ?? "unknown",
      },
      sourceRefs: entry.sourceRefs,
      linkedSummaryIds: entry.linkedSummaryIds,
      supersededById: entry.supersededById,
      origin: entry.origin,
    });
    const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    const normalizedStatus =
      entry.status === "superseded" ? "superseded" : entry.status;
    const frontmatter = rebuilt.replace(
      /^status:\s+.+$/m,
      `status: ${normalizedStatus}`,
    );
    await writeFile(filePath, `${frontmatter}\n${body}\n`, "utf8");
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
    return value
      .map((item) => String(item).trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    return normalized ? normalized : undefined;
  }

  private normalizeOrigin(value: unknown): KnowledgeDocumentIndexEntry["origin"] {
    switch (String(value ?? "").trim()) {
      case "manual":
      case "native":
      case "imported":
      case "synthesized":
        return String(value).trim() as KnowledgeDocumentIndexEntry["origin"];
      default:
        return "manual";
    }
  }

  private firstHeading(content: string): string | null {
    const heading = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^#\s+/.test(line));
    return heading ? heading.replace(/^#\s+/, "").trim() : null;
  }

  private previewBody(content: string): string {
    const preview = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6)
      .join(" ");
    return preview.length > 800 ? `${preview.slice(0, 800)}...` : preview;
  }

  private parseTurnRange(value: unknown): [number, number] {
    if (typeof value !== "string") {
      return [0, 0];
    }
    const match = value.match(/^(\d+)-(\d+)$/);
    if (!match) {
      return [0, 0];
    }
    return [Number(match[1]) || 0, Number(match[2]) || 0];
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

  private uniqueStrings(values: string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }
}
