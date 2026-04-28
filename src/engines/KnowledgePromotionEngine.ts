import {
  BridgeConfig,
  KnowledgeDocBucket,
  KnowledgePromotionDraft,
  KnowledgePromotionResult,
  KnowledgeRepository,
  LlmCaller,
  LoggerLike,
  RawMessage,
  SummaryEntry,
} from "../types";

const KNOWLEDGE_PROMPT_VERSION = "kb-md-v1";

interface PromoteArgs {
  summaryEntry: SummaryEntry;
  messages: RawMessage[];
  sessionId: string;
  summaryModel?: string;
  knowledgePromotionModel?: string;
  config: Pick<BridgeConfig, "kbWriteEnabled" | "kbExportEnabled" | "emergencyBrake">;
  knowledgeStore: KnowledgeRepository;
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
      config,
      knowledgeStore,
    } = args;

    const writePolicy = this.resolveWritePolicy(config);
    if (!writePolicy.allowed) {
      return {
        status: "skipped",
        reason: writePolicy.reason,
      };
    }

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
      "You are promoting accepted knowledge raw into a git-friendly unified markdown knowledge base.",
      "History and knowledge are separate systems. Do NOT store raw chatter as knowledge.",
      "This summary has already passed knowledge intake and belongs in the knowledge module.",
      "Allowed buckets: decisions, patterns, facts, incidents.",
      "Do not re-evaluate whether the content deserves to enter the knowledge system. Focus on how to organize it.",
      "If the content refines an existing idea, keep the same slug/canonicalKey so the writer can create the next version automatically.",
      "Return JSON ONLY with exactly these keys:",
      "shouldWrite, reason, bucket, slug, title, summary, tags, canonicalKey, body, status",
      "status must be active or draft.",
      "body must be valid markdown WITHOUT frontmatter.",
      "Use a clean structure in body: '# Title', '## Why it matters', '## Canonical knowledge', '## Evidence'.",
      "Tags should be short lowercase identifiers.",
      "Set shouldWrite=true unless the payload is structurally invalid.",
      "Use concise, final wording. Avoid contradictions. If there is uncertainty, prefer draft.",
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
    const bucket = this.normalizeBucket(record.bucket);
    if (!bucket) {
      return null;
    }

    return {
      shouldWrite: true,
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

  private resolveWritePolicy(
    config: Pick<BridgeConfig, "kbWriteEnabled" | "kbExportEnabled" | "emergencyBrake">,
  ): { allowed: true } | { allowed: false; reason: string } {
    if (config.emergencyBrake) {
      return { allowed: false, reason: "emergency_brake_disables_knowledge_writes" };
    }
    if (!config.kbWriteEnabled) {
      return { allowed: false, reason: "kb_write_disabled" };
    }
    if (!config.kbExportEnabled) {
      return { allowed: false, reason: "kb_export_disabled" };
    }
    return { allowed: true };
  }
}
