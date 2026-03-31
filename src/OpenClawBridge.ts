import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { ContextAssembler } from "./engines/ContextAssembler";
import { CompactionEngine } from "./engines/CompactionEngine";
import { RecallResolver } from "./resolvers/RecallResolver";
import { MemoryRetrievalRouter } from "./routing/MemoryRetrievalRouter";
import { ContextViewStore } from "./stores/ContextViewStore";
import { RawMessageStore } from "./stores/RawMessageStore";
import { StablePrefixStore } from "./stores/StablePrefixStore";
import { SummaryIndexStore } from "./stores/SummaryIndexStore";
import { ExternalSystemBootstrap } from "./system/ExternalSystemBootstrap";
import {
  BridgeConfig,
  ContextItem,
  LlmCallParams,
  LlmCaller,
  LoggerLike,
  RawMessage,
  RetrievalDecision,
} from "./types";
import { estimateTokens } from "./utils/tokenizer";

const DEFAULT_CONFIG: BridgeConfig = {
  dataDir: path.join(process.cwd(), ".lossless-lite"),
  sessionId: "default-session",
  workspaceDir: path.join(process.env.USERPROFILE ?? "C:\\Users\\28227", ".openclaw", "workspace"),
  sharedDataDir: "C:\\openclaw-data",
  contextWindow: 32000,
  contextThreshold: 0.75,
  recentTailTurns: 8,
  compactionBatchTurns: 12,
  summaryModel: "gpt-4.1-mini",
  summaryMaxOutputTokens: 300,
};

const EMBEDDINGS_API_PROMPT =
  "当前任务需要启用 embeddings 检索。要现在配置 API 吗？可选 OpenAI 或 SiliconFlow；也可以回复忽略继续。";

class ConsoleLogger implements LoggerLike {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(`[lossless-lite] ${message}`, meta ?? {});
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(`[lossless-lite] ${message}`, meta ?? {});
  }

  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`[lossless-lite] ${message}`, meta ?? {});
  }
}

class OpenClawLlmCaller implements LlmCaller {
  constructor(private readonly api: any) {}

  async call(params: LlmCallParams): Promise<string> {
    const llm = this.api?.context?.llm ?? this.api?.llm ?? this.api?.runtime?.llm ?? this.api?.context?.model;

    if (!llm) {
      throw new Error("No OpenClaw LLM caller available");
    }

    if (typeof llm.call === "function") {
      const result = await llm.call(params);
      return typeof result === "string" ? result : JSON.stringify(result);
    }

    if (typeof llm.complete === "function") {
      const result = await llm.complete(params);
      return typeof result === "string" ? result : JSON.stringify(result);
    }

    throw new Error("Unsupported OpenClaw LLM API");
  }
}

export class OpenClawBridge {
  private api: any;
  private logger: LoggerLike = new ConsoleLogger();
  private config: BridgeConfig = DEFAULT_CONFIG;
  private rawStore: RawMessageStore | null = null;
  private summaryStore: SummaryIndexStore | null = null;
  private readonly contextViewStore = new ContextViewStore();
  private readonly assembler = new ContextAssembler(this.contextViewStore);
  private readonly recallResolver = new RecallResolver();
  private readonly retrievalRouter = new MemoryRetrievalRouter();
  private readonly stablePrefixStore = new StablePrefixStore();
  private externalSystemBootstrap = new ExternalSystemBootstrap(this.logger);
  private compactionEngine = new CompactionEngine(null, this.logger);

  register(api: any): void {
    this.api = api;
    this.logger = api?.logger ?? this.logger;
    this.compactionEngine = new CompactionEngine(new OpenClawLlmCaller(api), this.logger);
    this.externalSystemBootstrap = new ExternalSystemBootstrap(this.logger);

    if (typeof api?.registerTool === "function") {
      api.registerTool({
        name: "memory_route",
        description:
          "Explain which memory layer should handle a query, whether embeddings are required, and whether the system should ask the user to configure an embeddings API.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The user query or retrieval intent to classify.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, args: any) => {
          const query = typeof args?.query === "string" ? args.query.trim() : "";
          const { decision, promptForApi } = await this.resolveRetrievalDecision(query);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    query,
                    route: decision.route,
                    retrievalLabel: this.describeRetrievalRoute(decision),
                    reason: decision.reason,
                    requiresEmbeddings: decision.requiresEmbeddings,
                    requiresSourceRecall: decision.requiresSourceRecall,
                    canAnswerDirectly: decision.canAnswerDirectly,
                    promptForApi,
                    apiPrompt: promptForApi ? EMBEDDINGS_API_PROMPT : null,
                  },
                  null,
                  2,
                ),
              },
            ],
            details: {
              ok: true,
              route: decision.route,
              retrievalLabel: this.describeRetrievalRoute(decision),
              promptForApi,
            },
          };
        },
      });

      api.registerTool({
        name: "recall_detail",
        description:
          "Recall original conversation details from the compressed memory system by searching summaries and expanding matching source messages.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The detail or topic to recall from earlier in the conversation.",
            },
            budget: {
              type: "number",
              description: "Optional token budget for recalled raw messages.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, args: any) => {
          const sessionId = this.resolveSessionId(args);
          await this.ensureStores(sessionId);
          const query = typeof args?.query === "string" ? args.query.trim() : "";
          if (!query) {
            return {
              content: [
                {
                  type: "text",
                  text: "recall_detail requires a non-empty `query`.",
                },
              ],
              details: {
                ok: false,
                missingParam: "query",
              },
            };
          }

          const { decision, promptForApi } = await this.resolveRetrievalDecision(query);
          if (promptForApi) {
            return {
              content: [
                {
                  type: "text",
                  text: EMBEDDINGS_API_PROMPT,
                },
              ],
              details: {
                ok: false,
                route: decision.route,
                retrievalLabel: this.describeRetrievalRoute(decision),
                promptForApi: true,
                requiresEmbeddings: true,
              },
            };
          }

          const totalBudget = this.resolveContextWindow(args);
          const recallBudget = Math.max(
            256,
            Math.floor(
              typeof args?.budget === "number" && Number.isFinite(args.budget) ? args.budget : totalBudget * 0.2,
            ),
          );
          const result = this.recallResolver.resolve(
            query,
            this.summaryStore as SummaryIndexStore,
            this.rawStore as RawMessageStore,
            recallBudget,
          );

          const text =
            result.items.length > 0
              ? result.items
                  .map((item) => `[turn ${item.turnNumber ?? "?"}] ${item.role ?? "user"}: ${item.content}`)
                  .join("\n\n")
              : `No matching historical details found for query: ${query}`;

          return {
            content: [
              {
                type: "text",
                text,
              },
            ],
            details: {
              ok: true,
              route: decision.route,
              retrievalLabel: this.describeRetrievalRoute(decision),
              query,
              recallBudget,
              consumedTokens: result.consumedTokens,
              hitCount: result.items.length,
            },
          };
        },
      });

      api.registerTool({
        name: "memory_retrieve",
        description:
          "Run the memory routing decision and return the first practical retrieval result from navigation, shared insights, knowledge base, DAG recall, or an embeddings API prompt.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The user query or retrieval intent.",
            },
            budget: {
              type: "number",
              description: "Optional token budget when source recall is needed.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, args: any) => {
          const sessionId = this.resolveSessionId(args);
          await this.ensureStores(sessionId);
          const query = typeof args?.query === "string" ? args.query.trim() : "";
          if (!query) {
            return {
              content: [{ type: "text", text: "memory_retrieve requires a non-empty `query`." }],
              details: { ok: false, missingParam: "query" },
            };
          }

          const { decision, promptForApi } = await this.resolveRetrievalDecision(query);
          if (promptForApi) {
            return {
              content: [{ type: "text", text: EMBEDDINGS_API_PROMPT }],
              details: {
                ok: false,
                route: decision.route,
                retrievalLabel: this.describeRetrievalRoute(decision),
                promptForApi: true,
                requiresEmbeddings: true,
              },
            };
          }

          if (decision.route === "navigation") {
            const hit = await this.stablePrefixStore.getNavigationHit(this.config.workspaceDir, query);
            return this.buildRouteHitResult(hit, decision, query);
          }

          if (decision.route === "shared_insights") {
            const hit = await this.stablePrefixStore.getSharedInsightHit(this.config.sharedDataDir, query);
            return this.buildRouteHitResult(hit, decision, query);
          }

          if (decision.route === "knowledge_base") {
            const hit = await this.stablePrefixStore.getKnowledgeBaseHit(this.config.sharedDataDir, query);
            return this.buildRouteHitResult(hit, decision, query);
          }

          const totalBudget = this.resolveContextWindow(args);
          const recallBudget = Math.max(
            256,
            Math.floor(typeof args?.budget === "number" && Number.isFinite(args.budget) ? args.budget : totalBudget * 0.2),
          );
          const result = this.recallResolver.resolve(
            query,
            this.summaryStore as SummaryIndexStore,
            this.rawStore as RawMessageStore,
            recallBudget,
          );
          const text =
            result.items.length > 0
              ? result.items
                  .map((item) => `[turn ${item.turnNumber ?? "?"}] ${item.role ?? "user"}: ${item.content}`)
                  .join("\n\n")
              : `No matching historical details found for query: ${query}`;
          return {
            content: [{ type: "text", text }],
            details: {
              ok: true,
              route: decision.route,
              retrievalLabel: this.describeRetrievalRoute(decision),
              query,
              consumedTokens: result.consumedTokens,
              hitCount: result.items.length,
            },
          };
        },
      });
    }

    if (typeof api?.registerContextEngine === "function") {
      api.registerContextEngine("lossless-lite", () => ({
        info: {
          id: "lossless-lite",
          name: "Lossless Lite",
          version: "0.1.0",
          ownsCompaction: true,
        },
        bootstrap: this.bootstrap.bind(this),
        ingest: this.ingest.bind(this),
        assemble: this.assemble.bind(this),
        compact: this.compact.bind(this),
        afterTurn: this.afterTurn.bind(this),
      }));
    }
  }

  async bootstrap(payload?: any): Promise<{ bootstrapped: boolean; importedMessages?: number; reason?: string }> {
    const sessionId = this.resolveSessionId(payload);
    this.config = this.resolveConfig(payload);
    await this.externalSystemBootstrap.ensure(this.config.sharedDataDir);
    await this.ensureStores(sessionId);
    return { bootstrapped: true, importedMessages: 0 };
  }

  async ingest(payload?: any): Promise<{ ingested: boolean }> {
    const sessionId = this.resolveSessionId(payload);
    await this.ensureStores(sessionId);

    const role = this.resolveRole(payload);
    const content = this.resolveContent(payload);
    const turnNumber = this.resolveTurnNumber(payload);
    const message: RawMessage = {
      id: this.resolveMessageId(payload),
      sessionId,
      role,
      content,
      turnNumber,
      createdAt: new Date().toISOString(),
      tokenCount: estimateTokens(content),
      compacted: false,
      metadata: this.resolveMetadata(payload),
    };

    await (this.rawStore as RawMessageStore).append(message);
    return { ingested: true };
  }

  async assemble(payload?: any): Promise<{
    messages: Array<Record<string, unknown>>;
    estimatedTokens: number;
    systemPromptAddition?: string;
  }> {
    const sessionId = this.resolveSessionId(payload);
    await this.ensureStores(sessionId);

    const totalBudget = this.resolveContextWindow(payload);
    const systemPromptTokens = this.resolveSystemPromptTokens(payload);

    try {
      const result = await this.assembler.assemble(
        this.rawStore as RawMessageStore,
        this.summaryStore as SummaryIndexStore,
        totalBudget,
        systemPromptTokens,
        this.config.recentTailTurns,
        this.config.sharedDataDir,
        this.config.workspaceDir,
      );
      return {
        messages: this.toAgentMessages(result.items),
        estimatedTokens: result.items.reduce((sum, item) => sum + item.tokenCount, 0),
      };
    } catch (error) {
      this.logger.warn("assemble_failed_recent_tail_fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
      const fallback = this.assembler.assembleRecentTail(
        this.rawStore as RawMessageStore,
        Math.max(totalBudget - systemPromptTokens, 0),
        this.config.recentTailTurns,
      );
      this.contextViewStore.setItems(fallback);
      return {
        messages: this.toAgentMessages(fallback),
        estimatedTokens: fallback.reduce((sum, item) => sum + item.tokenCount, 0),
        systemPromptAddition: "Lossless-lite degraded to recent-tail fallback for this turn.",
      };
    }
  }

  async compact(payload?: any): Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    result?: {
      summary?: string;
      tokensBefore: number;
      tokensAfter?: number;
      details?: unknown;
    };
  }> {
    const sessionId = this.resolveSessionId(payload);
    await this.ensureStores(sessionId);
    const tokensBefore = (this.rawStore as RawMessageStore).totalUncompactedTokens();

    const entry = await this.compactionEngine.runCompaction(
      this.rawStore as RawMessageStore,
      this.summaryStore as SummaryIndexStore,
      this.resolveContextWindow(payload),
      this.config.contextThreshold,
      this.config.recentTailTurns,
      this.config.summaryModel,
      this.config.summaryMaxOutputTokens,
      sessionId,
      this.config.compactionBatchTurns,
    );

    if (!entry) {
      return { ok: true, compacted: false, reason: "threshold_not_met_or_no_candidate" };
    }

    return {
      ok: true,
      compacted: true,
      result: {
        summary: entry.summary,
        tokensBefore,
        tokensAfter: (this.rawStore as RawMessageStore).totalUncompactedTokens(),
        details: {
          startTurn: entry.startTurn,
          endTurn: entry.endTurn,
          summaryId: entry.id,
        },
      },
    };
  }

  async afterTurn(payload?: any): Promise<{ ok: true }> {
    const sessionId = this.resolveSessionId(payload);
    await this.ensureStores(sessionId);

    const rawStore = this.rawStore as RawMessageStore;
    const summaryStore = this.summaryStore as SummaryIndexStore;
    const contextWindow = this.resolveContextWindow(payload);
    const entry = await this.compactionEngine.runCompaction(
      rawStore,
      summaryStore,
      contextWindow,
      this.config.contextThreshold,
      this.config.recentTailTurns,
      this.config.summaryModel,
      this.config.summaryMaxOutputTokens,
      sessionId,
      this.config.compactionBatchTurns,
    );

    const stats = {
      timestamp: new Date().toISOString(),
      sessionId,
      contextWindow,
      contextThreshold: this.config.contextThreshold,
      uncompactedTokens: rawStore.totalUncompactedTokens(),
      summaryCount: summaryStore.getAllSummaries().length,
      summaryTokens: summaryStore.getTotalTokens(),
      contextItems: this.contextViewStore.getItems().length,
      compactedThisTurn: Boolean(entry),
    };

    this.logger.info("after_turn_stats", stats);
    await this.writeStatsLog(sessionId, stats);
    return { ok: true };
  }

  private async ensureStores(sessionId: string): Promise<void> {
    if (this.rawStore && this.summaryStore && this.config.sessionId === sessionId) {
      return;
    }

    this.config = { ...this.config, sessionId };
    this.rawStore = new RawMessageStore(this.config.dataDir, sessionId);
    this.summaryStore = new SummaryIndexStore(this.config.dataDir, sessionId);
    await this.rawStore.init();
    await this.summaryStore.init();
  }

  private resolveConfig(payload?: any): BridgeConfig {
    const pluginConfig = payload?.config ?? this.api?.config ?? {};
    return {
      dataDir: pluginConfig.dataDir ?? DEFAULT_CONFIG.dataDir,
      sessionId: this.resolveSessionId(payload),
      workspaceDir: pluginConfig.workspaceDir ?? DEFAULT_CONFIG.workspaceDir,
      sharedDataDir: pluginConfig.sharedDataDir ?? DEFAULT_CONFIG.sharedDataDir,
      contextWindow: Number(pluginConfig.contextWindow ?? payload?.contextWindow ?? DEFAULT_CONFIG.contextWindow),
      contextThreshold: Number(pluginConfig.contextThreshold ?? DEFAULT_CONFIG.contextThreshold),
      recentTailTurns: Number(pluginConfig.recentTailTurns ?? DEFAULT_CONFIG.recentTailTurns),
      compactionBatchTurns: Number(pluginConfig.compactionBatchTurns ?? DEFAULT_CONFIG.compactionBatchTurns),
      summaryModel: String(pluginConfig.summaryModel ?? DEFAULT_CONFIG.summaryModel),
      summaryMaxOutputTokens: Number(pluginConfig.summaryMaxOutputTokens ?? DEFAULT_CONFIG.summaryMaxOutputTokens),
    };
  }

  private resolveSessionId(payload?: any): string {
    return (
      payload?.sessionId ?? payload?.session?.id ?? this.api?.session?.id ?? this.config.sessionId ?? DEFAULT_CONFIG.sessionId
    );
  }

  private resolveMessageId(payload?: any): string {
    return payload?.message?.id ?? payload?.id ?? randomUUID();
  }

  private resolveRole(payload?: any): RawMessage["role"] {
    return payload?.message?.role ?? payload?.role ?? "user";
  }

  private resolveContent(payload?: any): string {
    return payload?.message?.content ?? payload?.content ?? "";
  }

  private resolveTurnNumber(payload?: any): number {
    if (typeof payload?.turnNumber === "number") {
      return payload.turnNumber;
    }

    if (typeof payload?.message?.turnNumber === "number") {
      return payload.message.turnNumber;
    }

    const messages = this.rawStore?.getAll() ?? [];
    const lastTurn = messages[messages.length - 1]?.turnNumber ?? 0;
    return this.resolveRole(payload) === "assistant" ? Math.max(lastTurn, 1) : lastTurn + 1;
  }

  private resolveMetadata(payload?: any): Record<string, unknown> | undefined {
    return payload?.message?.metadata ?? payload?.metadata;
  }

  private resolveContextWindow(payload?: any): number {
    return Number(payload?.contextWindow ?? this.config.contextWindow);
  }

  private resolveSystemPromptTokens(payload?: any): number {
    if (typeof payload?.systemPromptTokens === "number") {
      return payload.systemPromptTokens;
    }
    return estimateTokens(payload?.systemPrompt ?? "");
  }

  private async writeStatsLog(sessionId: string, stats: Record<string, unknown>): Promise<void> {
    const logDir = path.join(this.config.dataDir, "logs");
    await mkdir(logDir, { recursive: true });
    await appendFile(path.join(logDir, `${sessionId}.after-turn.log`), `${JSON.stringify(stats)}\n`, "utf8");
  }

  private toAgentMessages(items: ContextItem[]): Array<Record<string, unknown>> {
    return items.map((item) => {
      if (item.kind === "summary") {
        return {
          role: "system",
          content: `[lossless-lite summary] ${item.content}`,
          metadata: item.metadata,
        };
      }

      return {
        role: item.role ?? "user",
        content: item.content,
        metadata: item.metadata,
      };
    });
  }

  private async resolveRetrievalDecision(query: string): Promise<{ decision: RetrievalDecision; promptForApi: boolean }> {
    const memorySearchEnabled = Boolean(this.api?.config?.agents?.defaults?.memorySearch?.enabled);
    const [hasTopicIndexHit, hasSharedInsightHint, hasNavigationHint] = await Promise.all([
      this.stablePrefixStore.hasKnowledgeBaseTopicHit(this.config.sharedDataDir, query),
      this.stablePrefixStore.hasSharedInsightHint(this.config.sharedDataDir, query),
      this.stablePrefixStore.hasNavigationHint(this.config.workspaceDir, query),
    ]);
    const decision = this.retrievalRouter.decide(query, {
      memorySearchEnabled,
      hasTopicIndexHit,
      hasSharedInsightHint,
      hasNavigationHint,
    });
    return {
      decision,
      promptForApi: decision.requiresEmbeddings && !memorySearchEnabled,
    };
  }

  private describeRetrievalRoute(decision: RetrievalDecision): string {
    switch (decision.route) {
      case "recent_tail":
        return "recent-tail direct context";
      case "navigation":
        return "navigation route hit";
      case "dag":
        return "lossless DAG/source recall";
      case "shared_insights":
        return "shared-insights route hit";
      case "knowledge_base":
        return "knowledge-base route hit";
      case "vector_search":
        return "vector retrieval";
      default:
        return decision.route;
    }
  }

  private buildRouteHitResult(
    hit: { title: string; content: string; filePath?: string } | null,
    decision: RetrievalDecision,
    query: string,
  ): { content: Array<Record<string, unknown>>; details: Record<string, unknown> } {
    const text =
      hit && hit.content.trim()
        ? hit.content
        : `No direct route-hit content found for query: ${query}`;
    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        title: hit?.title ?? null,
        filePath: hit?.filePath ?? null,
      },
    };
  }
}
