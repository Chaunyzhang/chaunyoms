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

    const draft = await this.generateDraft({
      summaryEntry,
      messages,
      relatedDocs,
      modelName: knowledgePromotionModel ?? summaryModel,
    });

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
      throw new Error("LLM caller unavailable for knowledge promotion");
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
      throw new Error("LLM knowledge promotion response was not valid JSON draft output");
    } catch (error) {
      this.logger.warn("knowledge_markdown_generation_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `knowledge-${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8)}`;
  }
}
