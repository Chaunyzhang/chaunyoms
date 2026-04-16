import { readFileSync } from "node:fs";
import path from "node:path";

import { BridgeConfig, LoggerLike, RawMessage } from "../types";
import { DEFAULT_BRIDGE_CONFIG } from "./OpenClawHostServices";

export interface ToolConfigResult {
  enabled: boolean;
  source: string;
  runtimeEnableTools: unknown;
  fileEnableTools: unknown;
}

export interface RuntimeMessageSnapshot {
  id?: string;
  role: RawMessage["role"];
  content: unknown;
  text: string;
  timestamp?: number | string;
  metadata?: Record<string, unknown>;
}

export interface LifecycleContext {
  sessionId: string;
  config: BridgeConfig;
  totalBudget: number;
  systemPromptTokens: number;
  summaryModel?: string;
  runtimeMessages: RuntimeMessageSnapshot[];
}

export interface IngestPayload {
  sessionId: string;
  config: BridgeConfig;
  id: string;
  role: RawMessage["role"];
  content: string;
  turnNumber?: number;
  metadata?: Record<string, unknown>;
}

export class OpenClawPayloadAdapter {
  constructor(
    private readonly getApi: () => any,
    private readonly getLogger: () => LoggerLike,
  ) {}

  resolveLifecycleContext(
    payload?: any,
    currentConfig: BridgeConfig = DEFAULT_BRIDGE_CONFIG,
  ): LifecycleContext {
    const config = this.resolveConfig(payload, currentConfig);
    return {
      sessionId: this.resolveSessionId(payload, currentConfig),
      config,
      totalBudget: this.resolveContextWindow(payload, config),
      systemPromptTokens: this.resolveSystemPromptTokens(payload),
      summaryModel: this.resolveSummaryModel(payload, config),
      runtimeMessages: this.extractRuntimeMessages(payload),
    };
  }

  resolveIngestPayload(
    payload?: any,
    currentConfig: BridgeConfig = DEFAULT_BRIDGE_CONFIG,
  ): IngestPayload {
    const context = this.resolveLifecycleContext(payload, currentConfig);
    return {
      sessionId: context.sessionId,
      config: context.config,
      id: this.resolveMessageId(payload),
      role: this.resolveRole(payload),
      content: this.extractTextFromContent(
        payload?.message?.content ?? payload?.content,
      ),
      turnNumber: this.resolveExplicitTurnNumber(payload),
      metadata: this.resolveMetadata(payload),
    };
  }

  resolveToolConfig(): ToolConfigResult {
    const api = this.getApi();
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

  hasEmbeddingsRetrievalReady(): boolean {
    const api = this.getApi();
    if (
      typeof api?.memorySearch?.search === "function" ||
      typeof api?.memorySearch?.query === "function" ||
      typeof api?.context?.memorySearch?.search === "function" ||
      typeof api?.context?.memorySearch?.query === "function" ||
      typeof api?.runtime?.memorySearch?.search === "function" ||
      typeof api?.runtime?.memorySearch?.query === "function"
    ) {
      return true;
    }

    const memorySearch = api?.config?.agents?.defaults?.memorySearch;
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

  extractTextFromContent(content: unknown): string {
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

  private resolveConfig(
    payload: any,
    currentConfig: BridgeConfig,
  ): BridgeConfig {
    const pluginConfig =
      payload?.config ??
      this.getApi()?.pluginConfig ??
      this.getApi()?.context?.pluginConfig ??
      this.getApi()?.runtime?.pluginConfig ??
      this.getApi()?.config?.plugins?.entries?.chaunyoms?.config ??
      this.getApi()?.context?.config?.plugins?.entries?.chaunyoms?.config ??
      this.getApi()?.runtime?.config?.plugins?.entries?.chaunyoms?.config ??
      this.getApi()?.config ??
      {};
    const baseConfig = currentConfig ?? DEFAULT_BRIDGE_CONFIG;
    return {
      dataDir: pluginConfig.dataDir ?? baseConfig.dataDir,
      sessionId: this.resolveSessionId(payload, baseConfig),
      workspaceDir: pluginConfig.workspaceDir ?? baseConfig.workspaceDir,
      sharedDataDir: pluginConfig.sharedDataDir ?? baseConfig.sharedDataDir,
      contextWindow: Number(
        pluginConfig.contextWindow ?? payload?.contextWindow ?? baseConfig.contextWindow,
      ),
      contextThreshold: Number(
        pluginConfig.contextThreshold ?? baseConfig.contextThreshold,
      ),
      freshTailTokens: Number(
        pluginConfig.freshTailTokens ??
          pluginConfig.recentTailTurns ??
          baseConfig.freshTailTokens,
      ),
      maxFreshTailTurns: Number(
        pluginConfig.maxFreshTailTurns ?? baseConfig.maxFreshTailTurns,
      ),
      compactionBatchTurns: Number(
        pluginConfig.compactionBatchTurns ?? baseConfig.compactionBatchTurns,
      ),
      summaryModel:
        typeof pluginConfig.summaryModel === "string" &&
        pluginConfig.summaryModel.trim().length > 0
          ? pluginConfig.summaryModel
          : undefined,
      summaryMaxOutputTokens: Number(
        pluginConfig.summaryMaxOutputTokens ?? baseConfig.summaryMaxOutputTokens,
      ),
    };
  }

  private resolveSessionId(
    payload: any,
    currentConfig: BridgeConfig,
  ): string {
    return (
      payload?.sessionId ??
      payload?.session?.id ??
      this.getApi()?.session?.id ??
      currentConfig.sessionId ??
      DEFAULT_BRIDGE_CONFIG.sessionId
    );
  }

  private resolveMessageId(payload: any): string {
    return payload?.message?.id ?? payload?.id ?? crypto.randomUUID();
  }

  private resolveRole(payload: any): RawMessage["role"] {
    return payload?.message?.role ?? payload?.role ?? "user";
  }

  private resolveExplicitTurnNumber(payload: any): number | undefined {
    if (typeof payload?.turnNumber === "number") {
      return payload.turnNumber;
    }
    if (typeof payload?.message?.turnNumber === "number") {
      return payload.message.turnNumber;
    }
    return undefined;
  }

  private resolveMetadata(payload: any): Record<string, unknown> | undefined {
    return payload?.message?.metadata ?? payload?.metadata;
  }

  private resolveContextWindow(
    payload: any,
    config: BridgeConfig,
  ): number {
    const runtimeBudget = Number(
      payload?.tokenBudget ?? payload?.contextWindow ?? config.contextWindow,
    );
    const configuredBudget = Number(config.contextWindow);
    if (
      Number.isFinite(runtimeBudget) &&
      runtimeBudget > 0 &&
      Number.isFinite(configuredBudget) &&
      configuredBudget > 0
    ) {
      return Math.min(runtimeBudget, configuredBudget);
    }
    if (Number.isFinite(runtimeBudget) && runtimeBudget > 0) {
      return runtimeBudget;
    }
    return configuredBudget;
  }

  private resolveSystemPromptTokens(payload: any): number {
    if (typeof payload?.systemPromptTokens === "number") {
      return payload.systemPromptTokens;
    }
    return this.estimateTokens(payload?.systemPrompt ?? "");
  }

  private resolveSummaryModel(
    payload: any,
    config: BridgeConfig,
  ): string | undefined {
    if (typeof config.summaryModel === "string" && config.summaryModel.trim()) {
      return config.summaryModel;
    }

    if (typeof payload?.model === "string" && payload.model.trim()) {
      return payload.model;
    }

    const contextModel = this.getApi()?.context?.model;
    if (typeof contextModel === "string" && contextModel.trim()) {
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

  private extractRuntimeMessages(payload: any): RuntimeMessageSnapshot[] {
    const candidates = [
      payload?.messages,
      payload?.conversation?.messages,
      payload?.turn?.messages,
      payload?.context?.messages,
      payload?.input?.messages,
    ];
    const messages = candidates.find((value) => Array.isArray(value));
    if (!Array.isArray(messages)) {
      return [];
    }

    const allowedRoles = new Set(["system", "user", "assistant", "tool"]);
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
        id:
          typeof message.id === "string" && message.id.trim().length > 0
            ? message.id
            : undefined,
        role: message.role as RawMessage["role"],
        content: message.content,
        text: this.extractTextFromContent(message.content).trim(),
        ...(typeof message.metadata === "object" &&
        message.metadata &&
        !Array.isArray(message.metadata)
          ? { metadata: message.metadata as Record<string, unknown> }
          : {}),
        ...(typeof message.timestamp === "number"
          ? { timestamp: message.timestamp }
          : typeof message.createdAt === "string"
            ? { timestamp: message.createdAt }
            : {}),
      }));
  }

  private estimateTokens(text: string): number {
    return Math.max(Math.ceil(text.length / 4), 1);
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
      this.getLogger().warn("tool_config_file_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
