import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { ContextItem } from "../types";
import { estimateTokens } from "../utils/tokenizer";

interface SharedInsightIndex {
  topics?: Array<{
    topicId?: string;
    latestVersion?: number;
    latestFile?: string;
    summary?: string;
  }>;
}

interface KnowledgeTopicIndex {
  topics?: Array<{
    topicId?: string;
    latestVersion?: number;
    latestFile?: string;
  }>;
}

export interface RouteHit {
  kind: "navigation" | "shared_insights" | "knowledge_base";
  filePath?: string;
  title: string;
  content: string;
}

export class StablePrefixStore {
  async getSharedInsightHit(sharedDataDir: string, query: string): Promise<RouteHit | null> {
    const raw = await this.readUtf8OrEmpty(path.join(sharedDataDir, "shared-insights", "insight-index.json"));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SharedInsightIndex;
    const terms = this.queryTerms(query);
    const topic = (parsed.topics ?? []).find((entry) => {
      const haystack = JSON.stringify(entry).toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
    if (!topic) return null;
    const filePath = topic.latestFile ? path.join(sharedDataDir, "shared-insights", topic.latestFile) : undefined;
    const body = filePath ? await this.readUtf8OrEmpty(filePath) : "";
    return {
      kind: "shared_insights",
      filePath,
      title: topic.topicId ?? "shared-insights",
      content: body || topic.summary || "",
    };
  }

  async getKnowledgeBaseHit(sharedDataDir: string, query: string): Promise<RouteHit | null> {
    const raw = await this.readUtf8OrEmpty(path.join(sharedDataDir, "knowledge-base", "topic-index.json"));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as KnowledgeTopicIndex;
    const terms = this.queryTerms(query);
    const topic = (parsed.topics ?? []).find((entry) => {
      const haystack = JSON.stringify(entry).toLowerCase();
      return terms.some((term) => haystack.includes(term));
    });
    if (!topic) return null;
    const filePath = topic.latestFile ? path.join(sharedDataDir, "knowledge-base", topic.latestFile) : undefined;
    const body = filePath ? await this.readUtf8OrEmpty(filePath) : "";
    return {
      kind: "knowledge_base",
      filePath,
      title: topic.topicId ?? "knowledge-base",
      content: body,
    };
  }

  async getNavigationHit(workspaceDir: string, query: string): Promise<RouteHit | null> {
    const latest = await this.getLatestNavigation(workspaceDir);
    if (!latest.content) return null;
    const haystack = latest.content.toLowerCase();
    if (!this.queryTerms(query).some((term) => haystack.includes(term))) return null;
    return {
      kind: "navigation",
      filePath: latest.filePath,
      title: path.basename(latest.filePath ?? "navigation"),
      content: latest.content,
    };
  }

  async hasSharedInsightHint(sharedDataDir: string, query: string): Promise<boolean> {
    const raw = await this.readUtf8OrEmpty(path.join(sharedDataDir, "shared-insights", "insight-index.json"));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as SharedInsightIndex;
    const haystack = JSON.stringify(parsed.topics ?? []).toLowerCase();
    return this.queryTerms(query).some((term) => haystack.includes(term));
  }

  async hasKnowledgeBaseTopicHit(sharedDataDir: string, query: string): Promise<boolean> {
    const raw = await this.readUtf8OrEmpty(path.join(sharedDataDir, "knowledge-base", "topic-index.json"));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as KnowledgeTopicIndex;
    const haystack = JSON.stringify(parsed.topics ?? []).toLowerCase();
    return this.queryTerms(query).some((term) => haystack.includes(term));
  }

  async hasNavigationHint(workspaceDir: string, query: string): Promise<boolean> {
    const content = await this.readNavigation(workspaceDir);
    if (!content) return false;
    const haystack = content.toLowerCase();
    return this.queryTerms(query).some((term) => haystack.includes(term));
  }

  async load(sharedDataDir: string, workspaceDir: string, budget: number): Promise<ContextItem[]> {
    const items: ContextItem[] = [];
    let consumed = 0;

    const pushIfFits = (label: string, content: string, metadata?: Record<string, unknown>) => {
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

    pushIfFits("shared_cognition", await this.readSharedCognition(sharedDataDir), {
      layer: "shared_cognition",
    });
    pushIfFits("shared_insights", await this.readSharedInsights(sharedDataDir), {
      layer: "shared_insights",
    });
    pushIfFits("knowledge_base_index", await this.readKnowledgeBaseIndex(sharedDataDir), {
      layer: "knowledge_base_index",
    });
    pushIfFits("navigation", await this.readNavigation(workspaceDir), {
      layer: "navigation",
    });

    return items;
  }

  private async readSharedCognition(sharedDataDir: string): Promise<string> {
    return await this.readUtf8OrEmpty(path.join(sharedDataDir, "shared-cognition", "COGNITION.md"));
  }

  private async readSharedInsights(sharedDataDir: string): Promise<string> {
    const raw = await this.readUtf8OrEmpty(path.join(sharedDataDir, "shared-insights", "insight-index.json"));
    if (!raw) return "";
    const parsed = JSON.parse(raw) as SharedInsightIndex;
    const topics = parsed.topics ?? [];
    return topics
      .map((topic) => {
        const id = topic.topicId ?? "unknown-topic";
        const file = topic.latestFile ?? "unknown-file";
        const summary = topic.summary?.trim() ?? "";
        return `- ${id}: latest=${file}${summary ? ` | ${summary}` : ""}`;
      })
      .join("\n");
  }

  private async readKnowledgeBaseIndex(sharedDataDir: string): Promise<string> {
    const raw = await this.readUtf8OrEmpty(path.join(sharedDataDir, "knowledge-base", "topic-index.json"));
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

  private async readNavigation(workspaceDir: string): Promise<string> {
    const latest = await this.getLatestNavigation(workspaceDir);
    return latest.content;
  }

  private async getLatestNavigation(workspaceDir: string): Promise<{ filePath?: string; content: string }> {
    const memoryDir = path.join(workspaceDir, "memory");
    let files: string[] = [];
    try {
      files = await readdir(memoryDir);
    } catch {
      return { content: "" };
    }
    const latest = files
      .filter((file) => /^\d{4}-\d{2}-\d{2}(?:-\d{2}-\d{2})?\.md$/.test(file))
      .sort()
      .at(-1);
    if (!latest) return { content: "" };
    const filePath = path.join(memoryDir, latest);
    return {
      filePath,
      content: await this.readUtf8OrEmpty(filePath),
    };
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
