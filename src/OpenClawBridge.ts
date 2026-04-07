import { readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
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
import { hashRawMessages } from "./utils/integrity";
const DEFAULT_CONFIG: BridgeConfig = {
  dataDir: path.join(process.cwd(), ".chaunyoms"),
  sessionId: "default-session",
  workspaceDir: path.join(
    process.env.USERPROFILE ?? "C:\\Users\\28227",
    ".openclaw",
    "workspace",
  ),
  sharedDataDir: "C:\\openclaw-data",
  contextWindow: 32000,
  contextThreshold: 0.75,
  freshTailTokens: 6000,
  maxFreshTailTurns: 8,
  compactionBatchTurns: 12,
  summaryMaxOutputTokens: 300,
};
const EMBEDDINGS_API_PROMPT =
  "当前任务需要启用 embeddings 检索。要现在配置 API 吗？可选 OpenAI 或 SiliconFlow；也可以回复忽略继续。";
const EMBEDDINGS_BOOTSTRAP_PROMPT =
  "ChaunyOMS 检测到当前还没有可用的 embeddings 检索能力。请主动询问用户是否现在配置 OpenClaw 的 memorySearch embeddings；如果用户同意，再指导其完成配置。";
class ConsoleLogger implements LoggerLike {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(`[chaunyoms] ${message}`, meta ?? {});
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(`[chaunyoms] ${message}`, meta ?? {});
  }
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`[chaunyoms] ${message}`, meta ?? {});
  }
}
class OpenClawLlmCaller implements LlmCaller {
  private readonly provider: {
    name: string;
    invoke: (params: LlmCallParams) => Promise<unknown>;
  } | null;
  constructor(
    private readonly api: any,
    private readonly logger?: LoggerLike,
  ) {
    this.provider = this.resolveProvider();
    if (!this.provider) {
      this.logger?.warn("llm_provider_unavailable", {
        checkedProviders: [
          "context.llm.call",
          "context.llm.complete",
          "llm.call",
          "llm.complete",
          "runtime.llm.call",
          "runtime.llm.complete",
          "context.model.call",
          "context.model.complete",
        ],
      });
    }
  }
  async call(params: LlmCallParams): Promise<string> {
    if (!this.provider) {
      throw new Error("No OpenClaw LLM caller available");
    }
    try {
      const result = await this.provider.invoke(params);
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (error) {
      throw new Error(
        `OpenClaw LLM call failed via ${this.provider.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  private resolveProvider(): {
    name: string;
    invoke: (params: LlmCallParams) => Promise<unknown>;
  } | null {
    const candidates: Array<{
      name: string;
      target: any;
      method: "call" | "complete";
    }> = [
      {
        name: "context.llm.call",
        target: this.api?.context?.llm,
        method: "call",
      },
      {
        name: "context.llm.complete",
        target: this.api?.context?.llm,
        method: "complete",
      },
      { name: "llm.call", target: this.api?.llm, method: "call" },
      { name: "llm.complete", target: this.api?.llm, method: "complete" },
      {
        name: "runtime.llm.call",
        target: this.api?.runtime?.llm,
        method: "call",
      },
      {
        name: "runtime.llm.complete",
        target: this.api?.runtime?.llm,
        method: "complete",
      },
      {
        name: "context.model.call",
        target: this.api?.context?.model,
        method: "call",
      },
      {
        name: "context.model.complete",
        target: this.api?.context?.model,
        method: "complete",
      },
    ];
    for (const candidate of candidates) {
      const fn = candidate.target?.[candidate.method];
      if (typeof fn === "function") {
        return {
          name: candidate.name,
          invoke: (params: LlmCallParams) =>
            Promise.resolve(fn.call(candidate.target, params)),
        };
      }
    }
    return null;
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
  private readonly embeddingsPromptedSessions = new Set<string>();
  register(api: any): void {
    this.api = api;
    this.logger = api?.logger ?? this.logger;
    this.compactionEngine = new CompactionEngine(
      new OpenClawLlmCaller(api, this.logger),
      this.logger,
    );
    this.externalSystemBootstrap = new ExternalSystemBootstrap(this.logger);
    const toolConfig = this.resolveToolConfig(api);
    const toolsEnabled = toolConfig.enabled;
    this.logger.info("tool_config_resolved", {
      toolsEnabled,
      source: toolConfig.source,
      runtimeEnableTools: toolConfig.runtimeEnableTools,
      fileEnableTools: toolConfig.fileEnableTools,
    });
    if (toolsEnabled && typeof api?.registerTool === "function") {
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
        execute: async (_toolCallId: string, args: any) =>
          this.executeMemoryRoute(args),
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
              description:
                "The detail or topic to recall from earlier in the conversation.",
            },
            budget: {
              type: "number",
              description: "Optional token budget for recalled raw messages.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, args: any) =>
          this.executeRecallDetail(args),
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
              description:
                "Optional token budget when source recall is needed.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, args: any) =>
          this.executeMemoryRetrieve(args),
      });

      api.registerTool({
        name: "lcm_describe",
        description:
          "Compatibility alias of memory_route for legacy chaunym-claw prompts.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "User query to classify." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, args: any) =>
          this.executeMemoryRoute(args),
      });

      api.registerTool({
        name: "lcm_grep",
        description:
          "Compatibility alias of recall_detail for source-level historical recall.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Recall query." },
            budget: {
              type: "number",
              description: "Optional token budget for recall.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, args: any) =>
          this.executeRecallDetail(args),
      });

      api.registerTool({
        name: "lcm_expand_query",
        description:
          "Compatibility alias of memory_retrieve for integrated route-hit/DAG/vector retrieval.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Retrieval query." },
            budget: {
              type: "number",
              description:
                "Optional token budget when source recall is needed.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (_toolCallId: string, args: any) =>
          this.executeMemoryRetrieve(args),
      });
    }
    if (!toolsEnabled) {
      this.logger.info("tool_registration_skipped", {
        reason: "enableTools_false",
      });
    }
    if (typeof api?.registerContextEngine === "function") {
      api.registerContextEngine("chaunyoms", () => ({
        info: {
          id: "chaunyoms",
          name: "Chaunyoms",
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
  async bootstrap(payload?: any): Promise<{
    bootstrapped: boolean;
    importedMessages?: number;
    reason?: string;
    embeddingsSetupRequired?: boolean;
  }> {
    const sessionId = this.resolveSessionId(payload);
    this.config = this.resolveConfig(payload);
    await this.externalSystemBootstrap.ensure(this.config.sharedDataDir);
    await this.ensureStores(sessionId);
    const integrityCheck = this.validateSummaryIntegrity();
    if (integrityCheck.mismatched > 0) {
      this.logger.warn("summary_integrity_mismatch_detected", integrityCheck);
    }
    return {
      bootstrapped: true,
      importedMessages: 0,
      embeddingsSetupRequired: this.needsEmbeddingsSetupPrompt(sessionId),
    };
  }

  private async executeMemoryRoute(args: any): Promise<{
    content: Array<Record<string, unknown>>;
    details: Record<string, unknown>;
  }> {
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    const { decision, promptForApi } =
      await this.resolveRetrievalDecision(query);
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
              shouldAutoRecall: this.shouldAutoRecall(decision),
              autoRecallReason: this.explainAutoRecall(decision),
              promptForApi,
              retrievalHitType: this.getRetrievalHitType(decision),
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
        retrievalHitType: this.getRetrievalHitType(decision),
        shouldAutoRecall: this.shouldAutoRecall(decision),
        autoRecallReason: this.explainAutoRecall(decision),
        promptForApi,
      },
    };
  }

  private async executeRecallDetail(args: any): Promise<{
    content: Array<Record<string, unknown>>;
    details: Record<string, unknown>;
  }> {
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
        details: { ok: false, missingParam: "query" },
      };
    }
    const { decision, promptForApi } =
      await this.resolveRetrievalDecision(query);
    if (promptForApi) {
      return {
        content: [{ type: "text", text: EMBEDDINGS_API_PROMPT }],
        details: {
          ok: false,
          route: decision.route,
          retrievalLabel: this.describeRetrievalRoute(decision),
          promptForApi: true,
          requiresEmbeddings: true,
          retrievalHitType: this.getRetrievalHitType(decision),
        },
      };
    }
    const totalBudget = this.resolveContextWindow(args);
    const recallBudget = Math.max(
      256,
      Math.floor(
        typeof args?.budget === "number" && Number.isFinite(args.budget)
          ? args.budget
          : totalBudget * 0.2,
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
            .map(
              (item) =>
                `[turn ${item.turnNumber ?? "?"}] ${item.role ?? "user"}: ${item.content}`,
            )
            .join("\n\n")
        : `No matching historical details found for query: ${query}`;
    return {
      content: [{ type: "text", text }],
      details: {
        ok: true,
        route: decision.route,
        retrievalLabel: this.describeRetrievalRoute(decision),
        query,
        recallBudget,
        consumedTokens: result.consumedTokens,
        hitCount: result.items.length,
        retrievalHitType: this.getRetrievalHitType(decision),
      },
    };
  }

  private async executeMemoryRetrieve(args: any): Promise<{
    content: Array<Record<string, unknown>>;
    details: Record<string, unknown>;
  }> {
    const sessionId = this.resolveSessionId(args);
    await this.ensureStores(sessionId);
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    if (!query) {
      return {
        content: [
          {
            type: "text",
            text: "memory_retrieve requires a non-empty `query`.",
          },
        ],
        details: { ok: false, missingParam: "query" },
      };
    }
    const { decision, promptForApi } =
      await this.resolveRetrievalDecision(query);
    if (promptForApi) {
      return {
        content: [{ type: "text", text: EMBEDDINGS_API_PROMPT }],
        details: {
          ok: false,
          route: decision.route,
          retrievalLabel: this.describeRetrievalRoute(decision),
          promptForApi: true,
          requiresEmbeddings: true,
          retrievalHitType: this.getRetrievalHitType(decision),
        },
      };
    }
    if (this.shouldAutoRecall(decision)) {
      const totalBudget = this.resolveContextWindow(args);
      const recallBudget = Math.max(
        256,
        Math.floor(
          typeof args?.budget === "number" && Number.isFinite(args.budget)
            ? args.budget
            : totalBudget * 0.2,
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
              .map(
                (item) =>
                  `[turn ${item.turnNumber ?? "?"}] ${item.role ?? "user"}: ${item.content}`,
              )
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
          retrievalHitType: "dag_recall",
          autoRecall: true,
          autoRecallReason: this.explainAutoRecall(decision),
        },
      };
    }
    if (decision.route === "navigation") {
      const hit = await this.stablePrefixStore.getNavigationHit(
        this.config.workspaceDir,
        query,
      );
      return this.buildRouteHitResult(hit, decision, query);
    }
    if (decision.route === "shared_insights") {
      const hit = await this.stablePrefixStore.getSharedInsightHit(
        this.config.sharedDataDir,
        query,
      );
      return this.buildRouteHitResult(hit, decision, query);
    }
    if (decision.route === "knowledge_base") {
      const hit = await this.stablePrefixStore.getKnowledgeBaseHit(
        this.config.sharedDataDir,
        query,
      );
      return this.buildRouteHitResult(hit, decision, query);
    }
    if (decision.route === "vector_search") {
      const vector = await this.tryVectorRetrieve(query);
      if (vector) {
        return {
          content: [{ type: "text", text: vector.text }],
          details: {
            ok: true,
            route: decision.route,
            retrievalLabel: this.describeRetrievalRoute(decision),
            query,
            retrievalHitType: "vector_retrieval",
            autoRecall: false,
            autoRecallReason: null,
            source: vector.source,
            score: vector.score ?? null,
          },
        };
      }
    }
    const totalBudget = this.resolveContextWindow(args);
    const recallBudget = Math.max(
      256,
      Math.floor(
        typeof args?.budget === "number" && Number.isFinite(args.budget)
          ? args.budget
          : totalBudget * 0.2,
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
            .map(
              (item) =>
                `[turn ${item.turnNumber ?? "?"}] ${item.role ?? "user"}: ${item.content}`,
            )
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
        retrievalHitType: this.getRetrievalHitType(decision),
      },
    };
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
    const embeddingsPrompt =
      this.consumeEmbeddingsSetupPrompt(sessionId)
        ? EMBEDDINGS_BOOTSTRAP_PROMPT
        : undefined;
    const runtimeMessages = this.extractRuntimeMessages(payload);
    if (runtimeMessages.length > 0) {
      const estimatedTokens = runtimeMessages.reduce(
        (sum, message) => sum + estimateTokens(this.extractTextFromContent(message.content)),
        0,
      );
      this.logger.info("assemble_passthrough_runtime_messages", {
        sessionId,
        messageCount: runtimeMessages.length,
        estimatedTokens,
      });
      return {
        messages: runtimeMessages,
        estimatedTokens,
        systemPromptAddition: embeddingsPrompt,
      };
    }
    const totalBudget = this.resolveContextWindow(payload);
    const systemPromptTokens = this.resolveSystemPromptTokens(payload);
    try {
      const result = await this.assembler.assemble(
        this.rawStore as RawMessageStore,
        this.summaryStore as SummaryIndexStore,
        totalBudget,
        systemPromptTokens,
        this.config.freshTailTokens,
        this.config.maxFreshTailTurns,
        this.config.sharedDataDir,
        this.config.workspaceDir,
      );
      return {
        messages: this.toAgentMessages(result.items),
        estimatedTokens: result.items.reduce(
          (sum, item) => sum + item.tokenCount,
          0,
        ),
        systemPromptAddition: embeddingsPrompt,
      };
    } catch (error) {
      this.logger.warn("assemble_failed_recent_tail_fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
      const fallback = this.assembler.assembleRecentTail(
        this.rawStore as RawMessageStore,
        Math.max(totalBudget - systemPromptTokens, 0),
        this.config.freshTailTokens,
        this.config.maxFreshTailTurns,
      );
      this.contextViewStore.setItems(fallback);
      return {
        messages: this.toAgentMessages(fallback),
        estimatedTokens: fallback.reduce(
          (sum, item) => sum + item.tokenCount,
          0,
        ),
        systemPromptAddition: [
          "Chaunyoms degraded to recent-tail fallback for this turn.",
          embeddingsPrompt,
        ]
          .filter(Boolean)
          .join("\n"),
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
    const tokensBefore = (
      this.rawStore as RawMessageStore
    ).totalUncompactedTokens();
    const entry = await this.compactionEngine.runCompaction(
      this.rawStore as RawMessageStore,
      this.summaryStore as SummaryIndexStore,
      this.resolveContextWindow(payload),
      this.config.contextThreshold,
      this.config.freshTailTokens,
      this.config.maxFreshTailTurns,
      this.resolveSummaryModelForCompaction(payload),
      this.config.summaryMaxOutputTokens,
      sessionId,
      this.config.compactionBatchTurns,
    );
    if (!entry) {
      return {
        ok: true,
        compacted: false,
        reason: "threshold_not_met_or_no_candidate",
      };
    }
    return {
      ok: true,
      compacted: true,
      result: {
        summary: entry.summary,
        tokensBefore,
        tokensAfter: (
          this.rawStore as RawMessageStore
        ).totalUncompactedTokens(),
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
    const stats = {
      timestamp: new Date().toISOString(),
      sessionId,
      contextWindow,
      contextThreshold: this.config.contextThreshold,
      uncompactedTokens: rawStore.totalUncompactedTokens(),
      summaryCount: summaryStore.getAllSummaries().length,
      summaryTokens: summaryStore.getTotalTokens(),
      contextItems: this.contextViewStore.getItems().length,
      compactedThisTurn: false,
    };
    this.logger.info("after_turn_stats", stats);
    await this.writeStatsLog(sessionId, stats);
    const navigationSnapshot = this.buildNavigationSnapshot(
      rawStore,
      summaryStore,
    );
    const navigationWrite =
      await this.stablePrefixStore.writeNavigationSnapshot(
        this.config.workspaceDir,
        navigationSnapshot,
      );
    if (navigationWrite.written) {
      this.logger.info("navigation_snapshot_written", {
        filePath: navigationWrite.filePath,
      });
    }
    return { ok: true };
  }
  private async ensureStores(sessionId: string): Promise<void> {
    if (
      this.rawStore &&
      this.summaryStore &&
      this.config.sessionId === sessionId
    ) {
      return;
    }
    this.config = { ...this.config, sessionId };
    this.rawStore = new RawMessageStore(this.config.dataDir, sessionId);
    this.summaryStore = new SummaryIndexStore(this.config.dataDir, sessionId);
    await this.rawStore.init();
    await this.summaryStore.init();
  }
  private resolveToolConfig(api: any): {
    enabled: boolean;
    source: string;
    runtimeEnableTools: unknown;
    fileEnableTools: unknown;
  } {
    const runtimeConfig =
      api?.config ??
      api?.pluginConfig ??
      api?.runtime?.config ??
      api?.context?.config ??
      {};
    const runtimeEnableTools = runtimeConfig?.enableTools;
    if (runtimeEnableTools === true) {
      return {
        enabled: true,
        source: "runtime",
        runtimeEnableTools,
        fileEnableTools: undefined,
      };
    }

    const fileEnableTools = this.readEnableToolsFromOpenClawConfig();
    if (fileEnableTools === true) {
      return {
        enabled: true,
        source: "openclaw_json",
        runtimeEnableTools,
        fileEnableTools,
      };
    }

    return {
      enabled: false,
      source: "disabled",
      runtimeEnableTools,
      fileEnableTools,
    };
  }

  private readEnableToolsFromOpenClawConfig(): unknown {
    try {
      const configPath = path.join(
        process.env.USERPROFILE ?? "C:\\Users\\28227",
        ".openclaw",
        "openclaw.json",
      );
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      return parsed?.plugins?.entries?.chaunyoms?.config?.enableTools;
    } catch (error) {
      this.logger.warn("tool_config_file_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
  private resolveConfig(payload?: any): BridgeConfig {
    const pluginConfig = payload?.config ?? this.api?.config ?? {};
    return {
      dataDir: pluginConfig.dataDir ?? DEFAULT_CONFIG.dataDir,
      sessionId: this.resolveSessionId(payload),
      workspaceDir: pluginConfig.workspaceDir ?? DEFAULT_CONFIG.workspaceDir,
      sharedDataDir: pluginConfig.sharedDataDir ?? DEFAULT_CONFIG.sharedDataDir,
      contextWindow: Number(
        pluginConfig.contextWindow ??
          payload?.contextWindow ??
          DEFAULT_CONFIG.contextWindow,
      ),
      contextThreshold: Number(
        pluginConfig.contextThreshold ?? DEFAULT_CONFIG.contextThreshold,
      ),
      freshTailTokens: Number(
        pluginConfig.freshTailTokens ??
          pluginConfig.recentTailTurns ??
          DEFAULT_CONFIG.freshTailTokens,
      ),
      maxFreshTailTurns: Number(
        pluginConfig.maxFreshTailTurns ?? DEFAULT_CONFIG.maxFreshTailTurns,
      ),
      compactionBatchTurns: Number(
        pluginConfig.compactionBatchTurns ??
          DEFAULT_CONFIG.compactionBatchTurns,
      ),
      summaryModel:
        typeof pluginConfig.summaryModel === "string" &&
        pluginConfig.summaryModel.trim().length > 0
          ? pluginConfig.summaryModel
          : undefined,
      summaryMaxOutputTokens: Number(
        pluginConfig.summaryMaxOutputTokens ??
          DEFAULT_CONFIG.summaryMaxOutputTokens,
      ),
    };
  }
  private resolveSessionId(payload?: any): string {
    return (
      payload?.sessionId ??
      payload?.session?.id ??
      this.api?.session?.id ??
      this.config.sessionId ??
      DEFAULT_CONFIG.sessionId
    );
  }
  private resolveMessageId(payload?: any): string {
    return payload?.message?.id ?? payload?.id ?? randomUUID();
  }
  private resolveRole(payload?: any): RawMessage["role"] {
    return payload?.message?.role ?? payload?.role ?? "user";
  }
  private resolveContent(payload?: any): string {
    return this.extractTextFromContent(payload?.message?.content ?? payload?.content);
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
    return this.resolveRole(payload) === "assistant"
      ? Math.max(lastTurn, 1)
      : lastTurn + 1;
  }
  private resolveMetadata(payload?: any): Record<string, unknown> | undefined {
    return payload?.message?.metadata ?? payload?.metadata;
  }
  private validateSummaryIntegrity(): {
    total: number;
    verified: number;
    mismatched: number;
    unchecked: number;
  } {
    const rawStore = this.rawStore as RawMessageStore;
    const summaryStore = this.summaryStore as SummaryIndexStore;
    const summaries = summaryStore.getAllSummaries();
    let verified = 0;
    let mismatched = 0;
    let unchecked = 0;
    for (const summary of summaries) {
      if (
        !summary.sourceHash ||
        typeof summary.sourceMessageCount !== "number"
      ) {
        unchecked += 1;
        continue;
      }
      const sourceMessages = rawStore.getByRange(
        summary.startTurn,
        summary.endTurn,
      );
      const actualHash = hashRawMessages(sourceMessages);
      const actualCount = sourceMessages.length;
      if (
        actualHash !== summary.sourceHash ||
        actualCount !== summary.sourceMessageCount
      ) {
        mismatched += 1;
      } else {
        verified += 1;
      }
    }
    return { total: summaries.length, verified, mismatched, unchecked };
  }
  private resolveContextWindow(payload?: any): number {
    return Number(
      payload?.tokenBudget ?? payload?.contextWindow ?? this.config.contextWindow,
    );
  }
  private resolveSummaryModelForCompaction(payload?: any): string | undefined {
    const configured = this.config.summaryModel;
    if (typeof configured === "string" && configured.trim().length > 0) {
      return configured;
    }
    const payloadModel = payload?.model;
    if (typeof payloadModel === "string" && payloadModel.trim().length > 0) {
      return payloadModel;
    }
    const contextModel = this.api?.context?.model;
    if (typeof contextModel === "string" && contextModel.trim().length > 0) {
      return contextModel;
    }
    if (
      typeof contextModel?.id === "string" &&
      contextModel.id.trim().length > 0
    ) {
      return contextModel.id;
    }
    return undefined;
  }
  private resolveSystemPromptTokens(payload?: any): number {
    if (typeof payload?.systemPromptTokens === "number") {
      return payload.systemPromptTokens;
    }
    return estimateTokens(payload?.systemPrompt ?? "");
  }
  private buildNavigationSnapshot(
    rawStore: RawMessageStore,
    summaryStore: SummaryIndexStore,
  ): string {
    const latestMessages = rawStore.getAll().slice(-12);
    const latestUser =
      [...latestMessages].reverse().find((item) => item.role === "user")
        ?.content ?? "(none)";
    const latestAssistant =
      [...latestMessages].reverse().find((item) => item.role === "assistant")
        ?.content ?? "(none)";
    const latestSummary = summaryStore.getAllSummaries().at(-1);
    const today = new Date();
    const dateLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return [
      `${dateLabel}:`,
      `- active: ${this.truncateNavigationLine(latestUser)}`,
      `- decision: ${this.truncateNavigationLine(latestAssistant)}`,
      `- todo: review follow-up actions from latest turn`,
      `- recall: ${latestSummary ? `summary:${latestSummary.id} turns ${latestSummary.startTurn}-${latestSummary.endTurn}` : "none"}`,
    ].join("\n");
  }
  private truncateNavigationLine(input: string, maxChars = 120): string {
    const normalized = input.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, maxChars - 3)}...`;
  }
  private async tryVectorRetrieve(
    query: string,
  ): Promise<{ text: string; source?: string; score?: number } | null> {
    const callCandidate = async (
      target: any,
      method: "search" | "query",
    ): Promise<{ text: string; source?: string; score?: number } | null> => {
      const fn = target?.[method];
      if (typeof fn !== "function") {
        return null;
      }
      const tryParse = (
        value: any,
      ): { text: string; source?: string; score?: number } | null => {
        if (!value) {
          return null;
        }
        const list = Array.isArray(value)
          ? value
          : Array.isArray(value?.hits)
            ? value.hits
            : Array.isArray(value?.items)
              ? value.items
              : Array.isArray(value?.results)
                ? value.results
                : [];
        const first = list[0] ?? value?.hit ?? value?.result;
        if (!first) {
          return null;
        }
        if (typeof first === "string") {
          return { text: first, source: method };
        }
        const text =
          first.content ??
          first.text ??
          first.chunk ??
          first.snippet ??
          first.document;
        if (typeof text !== "string" || !text.trim()) {
          return null;
        }
        return {
          text: text.trim(),
          source: first.source ?? first.filePath ?? first.path ?? method,
          score: typeof first.score === "number" ? first.score : undefined,
        };
      };
      try {
        const byObject = await Promise.resolve(
          fn.call(target, { query, topK: 3, k: 3 }),
        );
        const parsed = tryParse(byObject);
        if (parsed) {
          return parsed;
        }
      } catch {}
      try {
        const byString = await Promise.resolve(fn.call(target, query));
        const parsed = tryParse(byString);
        if (parsed) {
          return parsed;
        }
      } catch {}
      return null;
    };
    const runtimeCandidate =
      (await callCandidate(this.api?.memorySearch, "search")) ??
      (await callCandidate(this.api?.memorySearch, "query")) ??
      (await callCandidate(this.api?.context?.memorySearch, "search")) ??
      (await callCandidate(this.api?.context?.memorySearch, "query")) ??
      (await callCandidate(this.api?.runtime?.memorySearch, "search")) ??
      (await callCandidate(this.api?.runtime?.memorySearch, "query"));
    if (runtimeCandidate) {
      return runtimeCandidate;
    }
    const vectorDir = path.join(this.config.sharedDataDir, "vector-store");
    let files: string[] = [];
    try {
      files = await readdir(vectorDir);
    } catch {
      return null;
    }
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return null;
    }
    let best: { text: string; source?: string; score?: number } | null = null;
    for (const file of files.filter((item) =>
      /\.(jsonl|json|txt|md)$/i.test(item),
    )) {
      const filePath = path.join(vectorDir, file);
      let body = "";
      try {
        body = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      if (!body.trim()) {
        continue;
      }
      const lower = body.toLowerCase();
      const score = terms.reduce(
        (sum, term) => (lower.includes(term) ? sum + 1 : sum),
        0,
      );
      if (score <= 0) {
        continue;
      }
      if (!best || score > (best.score ?? 0)) {
        best = {
          text: body.length > 1200 ? `${body.slice(0, 1200)}...` : body,
          source: filePath,
          score,
        };
      }
    }
    return best;
  }
  private async writeStatsLog(
    sessionId: string,
    stats: Record<string, unknown>,
  ): Promise<void> {
    const logDir = path.join(this.config.dataDir, "logs");
    await mkdir(logDir, { recursive: true });
    await appendFile(
      path.join(logDir, `${sessionId}.after-turn.log`),
      `${JSON.stringify(stats)}\n`,
      "utf8",
    );
  }
  private toAgentMessages(
    items: ContextItem[],
  ): Array<Record<string, unknown>> {
    return items.map((item) => {
      if (item.kind === "summary") {
        return {
          role: "system",
          content: `[chaunyoms summary] ${item.content}`,
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

  private extractRuntimeMessages(payload?: any): Array<Record<string, unknown>> {
    const messages = payload?.messages;
    if (!Array.isArray(messages)) {
      return [];
    }
    const allowedRoles = new Set(["system", "user", "assistant"]);
    return messages
      .filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) &&
          typeof message === "object" &&
          typeof message.role === "string" &&
          allowedRoles.has(String(message.role)) &&
          "content" in message,
      )
      .map((message) => ({
        role: message.role,
        content: message.content,
        ...(typeof message.timestamp === "number"
          ? { timestamp: message.timestamp }
          : {}),
      }));
  }

  private extractTextFromContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            return (part as { text: string }).text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }
  private async resolveRetrievalDecision(
    query: string,
  ): Promise<{ decision: RetrievalDecision; promptForApi: boolean }> {
    const memorySearchEnabled = this.hasEmbeddingsRetrievalReady();
    const [hasTopicIndexHit, hasSharedInsightHint, hasNavigationHint] =
      await Promise.all([
        this.stablePrefixStore.hasKnowledgeBaseTopicHit(
          this.config.sharedDataDir,
          query,
        ),
        this.stablePrefixStore.hasSharedInsightHint(
          this.config.sharedDataDir,
          query,
        ),
        this.stablePrefixStore.hasNavigationHint(
          this.config.workspaceDir,
          query,
        ),
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
  private needsEmbeddingsSetupPrompt(sessionId: string): boolean {
    return !this.hasEmbeddingsRetrievalReady() &&
      !this.embeddingsPromptedSessions.has(sessionId);
  }
  private markEmbeddingsPrompted(sessionId: string): void {
    this.embeddingsPromptedSessions.add(sessionId);
  }
  private consumeEmbeddingsSetupPrompt(sessionId: string): boolean {
    if (!this.needsEmbeddingsSetupPrompt(sessionId)) {
      return false;
    }
    this.markEmbeddingsPrompted(sessionId);
    return true;
  }
  private hasEmbeddingsRetrievalReady(): boolean {
    if (
      typeof this.api?.memorySearch?.search === "function" ||
      typeof this.api?.memorySearch?.query === "function" ||
      typeof this.api?.context?.memorySearch?.search === "function" ||
      typeof this.api?.context?.memorySearch?.query === "function" ||
      typeof this.api?.runtime?.memorySearch?.search === "function" ||
      typeof this.api?.runtime?.memorySearch?.query === "function"
    ) {
      return true;
    }
    const memorySearch = this.api?.config?.agents?.defaults?.memorySearch;
    if (!memorySearch || memorySearch.enabled !== true) {
      return false;
    }
    return Boolean(
      memorySearch.provider ??
        memorySearch.profile ??
        memorySearch.model ??
        memorySearch.embedModel ??
        memorySearch.baseUrl ??
        memorySearch.endpoint,
    );
  }
  private shouldAutoRecall(decision: RetrievalDecision): boolean {
    return decision.requiresSourceRecall || decision.route === "dag";
  }
  private explainAutoRecall(decision: RetrievalDecision): string | null {
    if (!this.shouldAutoRecall(decision)) {
      return null;
    }
    if (decision.requiresSourceRecall) {
      return "fact_or_constraint_query_requires_source_recall";
    }
    if (decision.route === "dag") {
      return "historical_dialog_route_requires_recall";
    }
    return "route_policy_requires_recall";
  }
  private getRetrievalHitType(
    decision: RetrievalDecision,
  ): "route_hit" | "dag_recall" | "vector_retrieval" | "recent_tail" {
    if (
      decision.route === "navigation" ||
      decision.route === "shared_insights" ||
      decision.route === "knowledge_base"
    ) {
      return "route_hit";
    }
    if (decision.route === "dag") {
      return "dag_recall";
    }
    if (decision.route === "vector_search") {
      return "vector_retrieval";
    }
    return "recent_tail";
  }
  private describeRetrievalRoute(decision: RetrievalDecision): string {
    switch (decision.route) {
      case "recent_tail":
        return "recent-tail direct context";
      case "navigation":
        return "navigation route hit";
      case "dag":
        return "oms DAG/source recall";
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
  ): {
    content: Array<Record<string, unknown>>;
    details: Record<string, unknown>;
  } {
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
        retrievalHitType: "route_hit",
        autoRecall: false,
        autoRecallReason: null,
      },
    };
  }
}
