import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ContextItem, PrefixLoadOptions } from "../types";
import {
  parseProjectStateSnapshot,
  prioritizeProjectStateSnapshot,
} from "../utils/projectState";
import { estimateTokens } from "../utils/tokenizer";

interface KnowledgeTopicIndex {
  topics?: Array<{
    topicId?: string;
    latestVersion?: number;
    latestFile?: string;
  }>;
}

export interface RouteHit {
  kind: "navigation" | "knowledge_base";
  filePath?: string;
  title: string;
  content: string;
}

export class StablePrefixStore {
  private static readonly NAVIGATION_RETENTION_ROUNDS = 30;
  private static readonly KNOWLEDGE_REFERENCE_RE =
    /(knowledge[- ]?base|docs?|documentation|reference|manual|guide|playbook|spec|specification|api|readme|markdown|\.md\b|adr|rfc|architecture|design docs?|\u77e5\u8bc6\u5e93|\u6587\u6863|\u8d44\u6599|\u8bf4\u660e|\u624b\u518c|\u6559\u7a0b|\u89c4\u8303|\u63a5\u53e3\u6587\u6863|\u67b6\u6784|\u8bbe\u8ba1\u6587\u6863)/i;
  private static readonly REFERENCE_LOOKUP_RE =
    /(look up|lookup|search|find|read|check|consult|open|review|refer|\u67e5|\u641c|\u627e|\u770b|\u8bfb|\u7ffb|\u53c2\u8003|\u6839\u636e)/i;

  async getKnowledgeBaseHit(
    sharedDataDir: string,
    query: string,
  ): Promise<RouteHit | null> {
    const raw = await this.readUtf8OrEmpty(
      path.join(sharedDataDir, "knowledge-base", "topic-index.json"),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as KnowledgeTopicIndex;
    const terms = this.queryTerms(query);
    const topic = (parsed.topics ?? []).find((entry) => {
      const haystack = JSON.stringify(entry).toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
    if (!topic) {
      return await this.findSourceDocHit(
        path.join(sharedDataDir, "knowledge-base"),
        query,
        "knowledge_base",
      );
    }
    const latestFile = await this.selectLatestVersionFile(
      path.join(sharedDataDir, "knowledge-base"),
      topic.topicId ?? "",
      topic.latestFile,
    );
    const filePath = latestFile
      ? path.join(sharedDataDir, "knowledge-base", latestFile)
      : undefined;
    const body = filePath ? await this.readUtf8OrEmpty(filePath) : "";
    return {
      kind: "knowledge_base",
      filePath,
      title: topic.topicId ?? "knowledge-base",
      content: body,
    };
  }

  async getNavigationHit(
    workspaceDir: string,
    query: string,
  ): Promise<RouteHit | null> {
    const latest = await this.getLatestNavigation(workspaceDir);
    if (!latest.content) return null;
    const haystack = latest.content.toLowerCase();
    if (!this.queryTerms(query).some((term) => haystack.includes(term)))
      return null;
    return {
      kind: "navigation",
      filePath: latest.filePath,
      title: path.basename(latest.filePath ?? "navigation"),
      content: latest.content,
    };
  }

  async getNavigationStateHit(
    workspaceDir: string,
    query: string,
  ): Promise<RouteHit | null> {
    const latest = await this.getLatestNavigation(workspaceDir);
    if (!latest.content) return null;

    const snapshot = parseProjectStateSnapshot(latest.content);
    if (!snapshot) {
      return {
        kind: "navigation",
        filePath: latest.filePath,
        title: path.basename(latest.filePath ?? "navigation"),
        content: latest.content,
      };
    }

    return {
      kind: "navigation",
      filePath: latest.filePath,
      title: path.basename(latest.filePath ?? "navigation"),
      content: prioritizeProjectStateSnapshot(snapshot, query),
    };
  }

  async hasKnowledgeBaseTopicHit(
    sharedDataDir: string,
    query: string,
  ): Promise<boolean> {
    const raw = await this.readUtf8OrEmpty(
      path.join(sharedDataDir, "knowledge-base", "topic-index.json"),
    );
    if (!raw) return false;
    const parsed = JSON.parse(raw) as KnowledgeTopicIndex;
    const haystack = JSON.stringify(parsed.topics ?? []).toLowerCase();
    return this.queryTerms(query).some((term) => haystack.includes(term));
  }

  async hasNavigationHint(
    workspaceDir: string,
    query: string,
  ): Promise<boolean> {
    const content = await this.readNavigation(workspaceDir);
    if (!content) return false;
    const haystack = content.toLowerCase();
    return this.queryTerms(query).some((term) => haystack.includes(term));
  }

  async hasStructuredNavigationState(workspaceDir: string): Promise<boolean> {
    const latest = await this.getLatestNavigation(workspaceDir);
    if (!latest.content) return false;
    return parseProjectStateSnapshot(latest.content) !== null;
  }

  async load(
    sharedDataDir: string,
    workspaceDir: string,
    budget: number,
    options: PrefixLoadOptions = {},
  ): Promise<ContextItem[]> {
    await this.cleanupOldNavigation(
      workspaceDir,
      StablePrefixStore.NAVIGATION_RETENTION_ROUNDS,
    );
    const items: ContextItem[] = [];
    let consumed = 0;

    const pushIfFits = (
      label: string,
      content: string,
      metadata?: Record<string, unknown>,
    ) => {
      const normalized = content.trim();
      if (!normalized) return;
      const text = `[${label}]\n${normalized}`;
      const tokenCount = estimateTokens(text);
      if (consumed + tokenCount > budget && items.length > 0) return;
      consumed += tokenCount;
      items.push({
        kind: "summary",
        tokenCount,
        content: text,
        metadata,
      });
    };

    pushIfFits(
      "shared_cognition",
      await this.readSharedCognition(sharedDataDir),
      {
        layer: "shared_cognition",
      },
    );
    pushIfFits("navigation", await this.readNavigation(workspaceDir), {
      layer: "navigation",
    });
    if (await this.shouldIncludeKnowledgeBaseIndex(sharedDataDir, options.activeQuery)) {
      pushIfFits(
        "knowledge_base_index",
        await this.readKnowledgeBaseIndex(sharedDataDir),
        {
          layer: "knowledge_base_index",
        },
      );
    }

    return items;
  }

  private async readSharedCognition(sharedDataDir: string): Promise<string> {
    return await this.readUtf8OrEmpty(
      path.join(sharedDataDir, "shared-cognition", "COGNITION.md"),
    );
  }

  private async readKnowledgeBaseIndex(sharedDataDir: string): Promise<string> {
    const raw = await this.readUtf8OrEmpty(
      path.join(sharedDataDir, "knowledge-base", "topic-index.json"),
    );
    if (!raw) return "";
    const parsed = JSON.parse(raw) as KnowledgeTopicIndex;
    const topics = parsed.topics ?? [];
    return topics
      .map((topic) => {
        const id = topic.topicId ?? "unknown-topic";
        const latestVersion = topic.latestVersion ?? "?";
        const latestFile = topic.latestFile ?? "unknown-file";
        return `- ${id}: v${latestVersion} -> ${latestFile}`;
      })
      .join("\n");
  }

  private async shouldIncludeKnowledgeBaseIndex(
    sharedDataDir: string,
    activeQuery?: string,
  ): Promise<boolean> {
    const normalized = activeQuery?.trim();
    if (!normalized) {
      return false;
    }

    // The knowledge-base index is only useful when the current ask is clearly
    // doc-seeking; otherwise it is just prompt pressure.
    if (StablePrefixStore.KNOWLEDGE_REFERENCE_RE.test(normalized)) {
      return true;
    }

    if (!StablePrefixStore.REFERENCE_LOOKUP_RE.test(normalized)) {
      return false;
    }

    return await this.hasKnowledgeBaseTopicHit(sharedDataDir, normalized);
  }

  private async readNavigation(workspaceDir: string): Promise<string> {
    const latest = await this.getLatestNavigation(workspaceDir);
    return latest.content;
  }

  private async getLatestNavigation(
    workspaceDir: string,
  ): Promise<{ filePath?: string; content: string }> {
    const memoryDir = path.join(workspaceDir, "memory");
    let files: string[] = [];
    try {
      files = await readdir(memoryDir);
    } catch {
      return { content: "" };
    }
    const latest = files
      .filter((file) => this.isNavigationFileName(file))
      .filter((file) => this.parseNavigationDate(file) !== null)
      .sort()
      .at(-1);
    if (!latest) return { content: "" };
    const filePath = path.join(memoryDir, latest);
    return {
      filePath,
      content: await this.readUtf8OrEmpty(filePath),
    };
  }

  private async cleanupOldNavigation(
    workspaceDir: string,
    keepRounds: number,
  ): Promise<void> {
    const memoryDir = path.join(workspaceDir, "memory");
    let files: string[] = [];
    try {
      files = await readdir(memoryDir);
    } catch {
      return;
    }

    const navigationFiles = files
      .filter((file) => this.isNavigationFileName(file))
      .sort();
    const keep = Math.max(keepRounds, 1);
    const toDelete = navigationFiles.slice(
      0,
      Math.max(navigationFiles.length - keep, 0),
    );
    await Promise.all(
      toDelete.map(async (file) =>
        rm(path.join(memoryDir, file), { force: true }),
      ),
    );
  }

  private isNavigationFileName(fileName: string): boolean {
    return /^\d{4}-\d{2}-\d{2}(?:-\d{2}-\d{2})?\.md$/.test(fileName);
  }

  private parseNavigationDate(fileName: string): Date | null {
    const match = fileName.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})-(\d{2}))?\.md$/,
    );
    if (!match) {
      return null;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] ?? 0);
    const minute = Number(match[5] ?? 0);
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  async writeNavigationSnapshot(
    workspaceDir: string,
    content: string,
  ): Promise<{ written: boolean; filePath?: string }> {
    const normalized = content.trim();
    if (!normalized) {
      return { written: false };
    }

    const memoryDir = path.join(workspaceDir, "memory");
    await this.cleanupOldNavigation(
      workspaceDir,
      StablePrefixStore.NAVIGATION_RETENTION_ROUNDS,
    );
    const latest = await this.getLatestNavigation(workspaceDir);
    if (latest.content.trim() === normalized) {
      return { written: false, filePath: latest.filePath };
    }

    const now = new Date();
    const fileName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}.md`;
    const filePath = path.join(memoryDir, fileName);
    await rm(filePath, { force: true }).catch(() => undefined);
    await mkdir(memoryDir, { recursive: true });
    await writeFile(filePath, `${normalized}\n`, "utf8");
    await this.cleanupOldNavigation(
      workspaceDir,
      StablePrefixStore.NAVIGATION_RETENTION_ROUNDS,
    );
    return { written: true, filePath };
  }

  private async findSourceDocHit(
    dirPath: string,
    query: string,
    kind: RouteHit["kind"],
  ): Promise<RouteHit | null> {
    const terms = this.queryTerms(query);
    if (terms.length === 0) {
      return null;
    }

    let files: string[] = [];
    try {
      files = await readdir(dirPath);
    } catch {
      return null;
    }

    const candidates = files.filter(
      (file) => /\.(md|txt|json)$/i.test(file) && !/index\.json$/i.test(file),
    );
    let best: {
      filePath: string;
      title: string;
      content: string;
      score: number;
    } | null = null;

    for (const file of candidates) {
      const filePath = path.join(dirPath, file);
      const content = await this.readUtf8OrEmpty(filePath);
      if (!content) {
        continue;
      }
      const haystack = `${file.toLowerCase()}\n${content.toLowerCase()}`;
      const score = terms.reduce(
        (sum, term) => (haystack.includes(term) ? sum + 1 : sum),
        0,
      );
      if (score <= 0) {
        continue;
      }
      if (!best || score > best.score) {
        best = {
          filePath,
          title: file,
          content,
          score,
        };
      }
    }

    if (!best) {
      return null;
    }

    return {
      kind,
      filePath: best.filePath,
      title: best.title,
      content: best.content,
    };
  }

  private async selectLatestVersionFile(
    dirPath: string,
    topicId: string,
    preferredFile?: string,
  ): Promise<string | undefined> {
    if (!topicId) {
      return preferredFile;
    }
    let files: string[] = [];
    try {
      files = await readdir(dirPath);
    } catch {
      return preferredFile;
    }

    const topicTerms = topicId
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((term) => term.length >= 2);
    const candidates = files.filter((file) => {
      const lower = file.toLowerCase();
      return topicTerms.every((term) => lower.includes(term));
    });
    if (candidates.length === 0) {
      return preferredFile;
    }

    const pick = candidates
      .map((file) => ({ file, version: this.extractVersionFromFileName(file) }))
      .sort(
        (left, right) =>
          right.version - left.version || left.file.localeCompare(right.file),
      )
      .at(0);

    return pick?.file ?? preferredFile;
  }

  private extractVersionFromFileName(fileName: string): number {
    const match = fileName
      .toLowerCase()
      .match(/(?:^|[^a-z0-9])v(\d+)(?:[^a-z0-9]|$)/i);
    if (!match) {
      return 0;
    }
    return Number(match[1]) || 0;
  }

  private async readUtf8OrEmpty(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return "";
    }
  }

  private queryTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
  }
}
