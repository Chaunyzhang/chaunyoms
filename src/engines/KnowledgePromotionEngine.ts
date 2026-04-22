import { createHash } from "node:crypto";

import {
  KnowledgeDocBucket,
  KnowledgePromotionDraft,
  KnowledgePromotionResult,
  LlmCaller,
  LoggerLike,
  RawMessage,
  SummaryEntry,
} from "../types";
import { KnowledgeMarkdownStore } from "../stores/KnowledgeMarkdownStore";

const KNOWLEDGE_PROMPT_VERSION = "kb-md-v1";

interface PromoteArgs {
  summaryEntry: SummaryEntry;
  messages: RawMessage[];
  sessionId: string;
  summaryModel?: string;
  knowledgePromotionModel?: string;
  knowledgeStore: KnowledgeMarkdownStore;
}

export class KnowledgePromotionEngine {
  constructor(
    private readonly llmCaller: LlmCaller | null,
    private readonly logger: LoggerLike,
  ) {}

  async promote(args: PromoteArgs): Promise<KnowledgePromotionResult> {
    const {
      summaryEntry,
      messages,
      sessionId,
      summaryModel,
      knowledgePromotionModel,
      knowledgeStore,
    } = args;

    await knowledgeStore.init();
    const existing = knowledgeStore.findPromotion(summaryEntry);
    if (existing) {
      return {
        status: existing.status === "promoted" ? "duplicate" : existing.status,
        reason: `summary_already_${existing.status}`,
        docId: existing.docId,
        slug: existing.slug,
        version: existing.version,
        filePath: existing.filePath,
      };
    }

    const relatedDocs = knowledgeStore.searchRelatedDocuments(
      `${summaryEntry.summary} ${summaryEntry.keywords.join(" ")}`,
      3,
    );

    let draft = await this.generateDraft({
      summaryEntry,
      messages,
      relatedDocs,
      modelName: knowledgePromotionModel ?? summaryModel,
    });

    if (!draft.body.trim() && draft.shouldWrite) {
      draft = this.buildFallbackDraft(summaryEntry, messages, relatedDocs);
    }

    return await knowledgeStore.writePromotion(summaryEntry, draft, {
      sessionId,
      sourceHash: summaryEntry.sourceHash,
      sourceMessageCount: summaryEntry.sourceMessageCount,
      promptVersion: KNOWLEDGE_PROMPT_VERSION,
      modelName: knowledgePromotionModel ?? summaryModel,
    });
  }

  private async generateDraft(args: {
    summaryEntry: SummaryEntry;
    messages: RawMessage[];
    relatedDocs: Array<{
      slug: string;
      title: string;
      bucket: KnowledgeDocBucket;
      latestVersion: number;
      summary: string;
      tags: string[];
      canonicalKey: string;
    }>;
    modelName?: string;
  }): Promise<KnowledgePromotionDraft> {
    if (!this.llmCaller) {
      return this.buildFallbackDraft(args.summaryEntry, args.messages, args.relatedDocs);
    }

    const prompt = this.buildPrompt(args.summaryEntry, args.messages, args.relatedDocs);
    try {
      const raw = await this.llmCaller.call({
        model: args.modelName,
        prompt,
        temperature: 0.1,
        maxOutputTokens: 1800,
        responseFormat: "json",
      });
      const parsed = this.parseDraft(raw);
      if (parsed) {
        return parsed;
      }
    } catch (error) {
      this.logger.warn("knowledge_markdown_generation_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return this.buildFallbackDraft(args.summaryEntry, args.messages, args.relatedDocs);
  }

  private buildPrompt(
    summaryEntry: SummaryEntry,
    messages: RawMessage[],
    relatedDocs: Array<{
      slug: string;
      title: string;
      bucket: KnowledgeDocBucket;
      latestVersion: number;
      summary: string;
      tags: string[];
      canonicalKey: string;
    }>,
  ): string {
    const transcript = messages
      .map(
        (message) =>
          `Turn ${message.turnNumber} | ${message.role}\n${message.content}`,
      )
      .join("\n\n");

    return [
      "You are promoting compressed chat history into a git-friendly markdown knowledge base.",
      "History and knowledge are separate systems. Do NOT store raw chatter as knowledge.",
      "Only write knowledge that has durable reuse value for future engineering work.",
      "Allowed buckets: decisions, patterns, facts, incidents.",
      "Do NOT store greetings, generic encouragement, temporary session bookkeeping, pure tool receipts, host wrappers, heartbeats, or one-off noise.",
      "Prefer SKIP when the content is too temporary or too narrow to help future work.",
      "If related docs already cover the same canonical knowledge and this batch adds nothing material, return shouldWrite=false.",
      "If the content refines an existing idea, keep the same slug/canonicalKey so the writer can create the next version automatically.",
      "Return JSON ONLY with exactly these keys:",
      "shouldWrite, reason, bucket, slug, title, summary, tags, canonicalKey, body, status",
      "status must be active or draft.",
      "body must be valid markdown WITHOUT frontmatter.",
      "Use a clean structure in body: '# Title', '## Why it matters', '## Canonical knowledge', '## Evidence'.",
      "Tags should be short lowercase identifiers.",
      "If skipping, set shouldWrite=false and body='' with empty tags.",
      "Use concise, final wording. Avoid contradictions. If there is uncertainty, prefer draft or skip.",
      "",
      `Compaction summary (${summaryEntry.startTurn}-${summaryEntry.endTurn}):`,
      summaryEntry.summary,
      "",
      "Related existing knowledge docs:",
      relatedDocs.length > 0 ? JSON.stringify(relatedDocs, null, 2) : "[]",
      "",
      "Source transcript:",
      transcript,
    ].join("\n");
  }

  private parseDraft(raw: string): KnowledgePromotionDraft | null {
    const candidate = this.tryParseObject(raw) ?? this.tryParseObject(this.extractJson(raw));
    if (!candidate || typeof candidate !== "object") {
      return null;
    }

    const record = candidate as Record<string, unknown>;
    if (typeof record.shouldWrite !== "boolean") {
      return null;
    }

    const bucket = this.normalizeBucket(record.bucket);
    if (!bucket) {
      return null;
    }

    return {
      shouldWrite: record.shouldWrite,
      reason: typeof record.reason === "string" ? record.reason : "model_generated_promotion",
      bucket,
      slug: typeof record.slug === "string" ? record.slug : "",
      title: typeof record.title === "string" ? record.title : "",
      summary: typeof record.summary === "string" ? record.summary : "",
      tags: Array.isArray(record.tags) ? record.tags.map((tag) => String(tag)) : [],
      canonicalKey: typeof record.canonicalKey === "string" ? record.canonicalKey : "",
      body: typeof record.body === "string" ? record.body : "",
      status: record.status === "draft" ? "draft" : "active",
    };
  }

  private tryParseObject(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private extractJson(raw: string): string {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  }

  private normalizeBucket(value: unknown): KnowledgeDocBucket | null {
    switch (String(value ?? "").trim()) {
      case "decisions":
      case "patterns":
      case "facts":
      case "incidents":
        return String(value).trim() as KnowledgeDocBucket;
      default:
        return null;
    }
  }

  private buildFallbackDraft(
    summaryEntry: SummaryEntry,
    messages: RawMessage[],
    relatedDocs: Array<{ slug: string; canonicalKey: string }>,
  ): KnowledgePromotionDraft {
    const material = messages
      .map((message) => message.content.trim())
      .filter((content) => content.length >= 20)
      .filter(
        (content) =>
          /(must|should|decision|fix|failed|error|constraint|parameter|config|risk|blocker|需要|必须|决定|修复|失败|错误|约束|参数|配置|风险|阻塞)/i.test(
            content,
          ),
      );

    if (material.length === 0) {
      return {
        shouldWrite: false,
        reason: "fallback_found_no_durable_knowledge",
        bucket: "facts",
        slug: "",
        title: "",
        summary: "",
        tags: [],
        canonicalKey: "",
        body: "",
        status: "draft",
      };
    }

    const bucket = this.chooseBucket(summaryEntry.summary, material.join(" "));
    const slug = this.slugify(
      relatedDocs[0]?.slug ||
        summaryEntry.keywords.slice(0, 3).join("-") ||
        `turns-${summaryEntry.startTurn}-${summaryEntry.endTurn}`,
    );
    const title = this.toTitle(slug);
    const summary = summaryEntry.summary.split(/\n/)[0].slice(0, 200).trim();
    const tags = [...new Set(summaryEntry.keywords.slice(0, 6).map((item) => this.slugify(item)).filter(Boolean))];
    const canonicalKey = relatedDocs[0]?.canonicalKey || slug;
    const evidence = material.slice(0, 4).map((item) => `- ${item}`);
    const body = [
      `# ${title}`,
      "",
      "## Why it matters",
      summary,
      "",
      "## Canonical knowledge",
      ...this.toKnowledgeBullets(material.slice(0, 4)),
      "",
      "## Evidence",
      ...evidence,
    ].join("\n");

    return {
      shouldWrite: true,
      reason: "fallback_promoted_reusable_history",
      bucket,
      slug,
      title,
      summary,
      tags,
      canonicalKey,
      body,
      status: "active",
    };
  }

  private chooseBucket(summary: string, material: string): KnowledgeDocBucket {
    const text = `${summary}\n${material}`.toLowerCase();
    if (/incident|postmortem|outage|failure|failed|traceback|error|事故|失败|报错/.test(text)) {
      return "incidents";
    }
    if (/decision|decided|keep|enable|disable|adopt|switch|决定|保持|启用|禁用|采用/.test(text)) {
      return "decisions";
    }
    if (/pattern|workflow|procedure|steps|how to|best practice|模式|流程|步骤|最佳实践/.test(text)) {
      return "patterns";
    }
    return "facts";
  }

  private toKnowledgeBullets(items: string[]): string[] {
    return items.map((item) => `- ${item}`);
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `knowledge-${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8)}`;
  }

  private toTitle(slug: string): string {
    return slug
      .split("-")
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" ");
  }
}
