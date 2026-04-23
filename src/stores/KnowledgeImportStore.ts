import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  KnowledgeImportDocument,
  KnowledgeImportHit,
  KnowledgeImportMetadata,
  KnowledgeImportProvenance,
  KnowledgeImportSource,
  KnowledgeImportTrustModel,
} from "../types";

interface TopicIndexRecord {
  topics?: Array<{
    topicId?: string;
    latestVersion?: number;
    latestFile?: string;
    summary?: string;
  }>;
}

interface CachedImportDocument extends KnowledgeImportDocument {
  searchText: string;
}

interface ImportIndexFileV1 {
  schemaVersion: 1;
  generatedAt: string;
  signature: string;
  documents: CachedImportDocument[];
}

const INDEX_FILE_NAME = ".chaunyoms-import-index.json";
const INDEX_CHECK_INTERVAL_MS = 2000;

export class KnowledgeImportStore implements KnowledgeImportSource {
  public readonly id: string;
  private initialized = false;
  private documents: CachedImportDocument[] = [];
  private cachedSignature = "";
  private lastIndexCheckAt = 0;
  private readonly indexPath: string;

  constructor(
    private readonly baseDir: string,
    options?: {
      id?: string;
      cacheDir?: string;
    },
  ) {
    this.id = options?.id ?? "knowledge_import_store";
    const cacheDir =
      options?.cacheDir ??
      path.join(
        os.tmpdir(),
        "chaunyoms-import-cache",
        this.hash(path.resolve(baseDir)).slice(0, 16),
      );
    this.indexPath = path.join(cacheDir, INDEX_FILE_NAME);
  }

  async init(): Promise<void> {
    if (this.initialized) {
      await this.ensureIndexCurrent();
      return;
    }
    await this.ensureIndexCurrent(true);
    this.initialized = true;
  }

  describeCapabilities() {
    return {
      read: true,
      write: false,
      supportsVersions: false,
      supportsBacklinks: false,
    };
  }

  async search(query: string, limit = 3): Promise<KnowledgeImportHit[]> {
    await this.init();
    const terms = this.queryTerms(query);
    if (terms.length === 0) {
      return [];
    }

    return this.documents
      .map((document) => ({
        document,
        score: this.score(document.searchText, terms),
      }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.document.title.localeCompare(right.document.title),
      )
      .slice(0, Math.max(limit, 1))
      .map(({ document, score }) => ({
        id: document.id,
        sourceId: this.id,
        sourceKind: "imported" as const,
        title: document.title,
        summary: document.summary,
        tags: document.tags,
        canonicalKey: document.canonicalKey,
        filePath: document.filePath,
        ref: document.ref,
        score,
      }));
  }

  async getById(id: string): Promise<KnowledgeImportDocument | null> {
    await this.init();
    const document = this.documents.find((item) => item.id === id);
    return document ? await this.hydrateDocument(document) : null;
  }

  async resolveRef(ref: string): Promise<KnowledgeImportDocument | null> {
    await this.init();
    const normalized = ref.trim().toLowerCase();
    const document = this.documents.find(
      (item) =>
        item.ref?.toLowerCase() === normalized ||
        item.filePath?.toLowerCase() === normalized ||
        path.basename(item.filePath ?? "").toLowerCase() === normalized,
    );
    return document ? await this.hydrateDocument(document) : null;
  }

  async getMetadata(id: string): Promise<KnowledgeImportMetadata | null> {
    await this.init();
    const document = this.documents.find((item) => item.id === id);
    if (!document) {
      return null;
    }
    return {
      id: document.id,
      sourceId: this.id,
      title: document.title,
      canonicalKey: document.canonicalKey,
      tags: document.tags,
      filePath: document.filePath,
    };
  }

  async getProvenance(id: string): Promise<KnowledgeImportProvenance | null> {
    await this.init();
    const document = this.documents.find((item) => item.id === id);
    if (!document) {
      return null;
    }
    return {
      sourceId: this.id,
      ref: document.ref ?? document.filePath ?? document.id,
      trustModel:
        "Imported knowledge is managed by ChaunyOMS as part of the unified knowledge corpus, while preserving source provenance.",
    };
  }

  describeTrustModel(): KnowledgeImportTrustModel {
    return {
      owner: "external-provider",
      layer: "external_knowledge",
      writableByChaunyoms: false,
      versionedByChaunyoms: false,
      notes: [
        "Imported knowledge is treated as a read-only external reference layer.",
        "ChaunyOMS preserves provenance, but does not treat imported records as internal formal knowledge by default.",
        "Promotion into managed knowledge must happen through an explicit organizer/promotion flow.",
      ],
    };
  }

  private async ensureIndexCurrent(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastIndexCheckAt < INDEX_CHECK_INTERVAL_MS) {
      return;
    }
    this.lastIndexCheckAt = now;

    const signature = await this.computeDirectorySignature();
    if (signature === this.cachedSignature && this.documents.length > 0) {
      return;
    }

    const cached = await this.loadIndexFile();
    if (cached && cached.signature === signature) {
      this.documents = cached.documents;
      this.cachedSignature = cached.signature;
      return;
    }

    const documents = await this.scanDocuments();
    this.documents = documents;
    this.cachedSignature = signature;
    await this.flushIndexFile({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      signature,
      documents,
    });
  }

  private async loadIndexFile(): Promise<ImportIndexFileV1 | null> {
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as ImportIndexFileV1;
      return Array.isArray(parsed.documents) && parsed.schemaVersion === 1
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  private async flushIndexFile(payload: ImportIndexFileV1): Promise<void> {
    await mkdir(path.dirname(this.indexPath), { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private async computeDirectorySignature(): Promise<string> {
    let files: string[] = [];
    try {
      files = await readdir(this.baseDir);
    } catch {
      return this.hash("empty-directory");
    }

    const relevantFiles = files
      .filter((file) => file !== INDEX_FILE_NAME)
      .filter((file) => /\.(md|txt|json)$/i.test(file))
      .sort();
    const parts: string[] = [];
    for (const file of relevantFiles) {
      const filePath = path.join(this.baseDir, file);
      try {
        const fileStat = await stat(filePath);
        parts.push(`${file}|${fileStat.size}|${fileStat.mtimeMs}`);
      } catch {
        parts.push(`${file}|missing`);
      }
    }
    return this.hash(parts.join("\n"));
  }

  private async scanDocuments(): Promise<CachedImportDocument[]> {
    const index = await this.readTopicIndex();
    const indexedDocuments = await Promise.all(
      (index.topics ?? []).map(async (topic) => {
        const fileName = topic.latestFile ?? "";
        const filePath = fileName ? path.join(this.baseDir, fileName) : null;
        const contentPreview = filePath
          ? await this.readPreview(filePath)
          : "";
        const id =
          topic.topicId?.trim() ||
          path.basename(fileName || "knowledge-import");
        const title =
          topic.topicId?.trim() ||
          path.basename(fileName || "knowledge-import");
        return {
          id,
          sourceId: this.id,
          title,
          content: "",
          summary: topic.summary?.trim() ?? this.firstNonEmptyLine(contentPreview),
          tags: this.queryTerms(`${topic.topicId ?? ""} ${fileName}`),
          canonicalKey: this.slugify(topic.topicId ?? title),
          filePath: filePath ?? undefined,
          ref: topic.topicId?.trim() || fileName || id,
          searchText: `${title} ${topic.summary ?? ""} ${contentPreview}`.toLowerCase(),
        } satisfies CachedImportDocument;
      }),
    );

    const directoryFiles = await this.readCandidateFiles();
    const discoveredDocuments = await Promise.all(
      directoryFiles.map(async (filePath) => {
        const preview = await this.readPreview(filePath);
        const title = path.basename(filePath);
        return {
          id: title,
          sourceId: this.id,
          title,
          content: "",
          summary: this.firstNonEmptyLine(preview),
          tags: this.queryTerms(title),
          canonicalKey: this.slugify(title),
          filePath,
          ref: title,
          searchText: `${title} ${preview}`.toLowerCase(),
        } satisfies CachedImportDocument;
      }),
    );

    const deduped = new Map<string, CachedImportDocument>();
    for (const document of [...indexedDocuments, ...discoveredDocuments]) {
      if (!deduped.has(document.id)) {
        deduped.set(document.id, document);
      }
    }
    return [...deduped.values()];
  }

  private async hydrateDocument(
    document: CachedImportDocument,
  ): Promise<KnowledgeImportDocument> {
    const content = document.filePath
      ? await this.readUtf8OrEmpty(document.filePath)
      : "";
    return {
      ...document,
      content,
      summary: document.summary || this.firstNonEmptyLine(content),
    };
  }

  private async readTopicIndex(): Promise<TopicIndexRecord> {
    const raw = await this.readUtf8OrEmpty(
      path.join(this.baseDir, "topic-index.json"),
    );
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw) as TopicIndexRecord;
    } catch {
      return {};
    }
  }

  private async readCandidateFiles(): Promise<string[]> {
    let files: string[] = [];
    try {
      files = await readdir(this.baseDir);
    } catch {
      return [];
    }
    return files
      .filter((file) => file !== INDEX_FILE_NAME)
      .filter(
        (file) => /\.(md|txt|json)$/i.test(file) && !/topic-index\.json$/i.test(file),
      )
      .map((file) => path.join(this.baseDir, file));
  }

  private async readPreview(filePath: string): Promise<string> {
    const content = await this.readUtf8OrEmpty(filePath);
    return content.length > 1600 ? `${content.slice(0, 1600)}...` : content;
  }

  private async readUtf8OrEmpty(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return "";
    }
  }

  private firstNonEmptyLine(content: string): string {
    return (
      content
        .split(/\r?\n/)
        .find((line) => line.trim().length > 0)
        ?.trim() ?? ""
    );
  }

  private queryTerms(query: string): string[] {
    return [
      ...new Set(
        query
          .toLowerCase()
          .split(/[^a-z0-9\u4e00-\u9fff-]+/i)
          .map((term) => term.trim())
          .filter((term) => term.length >= 2),
      ),
    ];
  }

  private score(haystack: string, terms: string[]): number {
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

  private slugify(value: string): string {
    return (
      value
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "knowledge-import"
    );
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}
