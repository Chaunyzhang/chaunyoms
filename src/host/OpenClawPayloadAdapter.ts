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
  sourceKey: string;
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

    const emergencyBrake = this.resolveBooleanFlag(
      [
        pluginConfig.emergencyBrake,
        pluginConfig.memoryEmergencyBrake,
        pluginConfig.memoryEmergencyStop,
        pluginConfig.isolationMode,
      ],
      baseConfig.emergencyBrake,
    );

    const runtimeCaptureEnabled = emergencyBrake
      ? false
      : this.resolveBooleanFlag(
          [
            pluginConfig.runtimeCaptureEnabled,
            this.inverseBoolean(pluginConfig.pauseRuntimeCapture),
            this.inverseBoolean(pluginConfig.stopRuntimeCapture),
          ],
          baseConfig.runtimeCaptureEnabled,
        );

    const durableMemoryEnabled = emergencyBrake
      ? false
      : this.resolveBooleanFlag(
          [
            pluginConfig.durableMemoryEnabled,
            this.inverseBoolean(pluginConfig.stopDurableWrites),
            this.inverseBoolean(pluginConfig.pauseDurableMemory),
          ],
          baseConfig.durableMemoryEnabled,
        );

    const autoRecallEnabled = emergencyBrake
      ? false
      : this.resolveBooleanFlag(
          [
            pluginConfig.autoRecallEnabled,
            this.inverseBoolean(pluginConfig.disableAutoRecall),
            this.inverseBoolean(pluginConfig.stopAutoRecall),
          ],
          baseConfig.autoRecallEnabled,
        );

    const knowledgePromotionEnabled = emergencyBrake
      ? false
      : this.resolveBooleanFlag(
          [
            pluginConfig.knowledgePromotionEnabled,
            this.inverseBoolean(pluginConfig.disableKnowledgePromotion),
            this.inverseBoolean(pluginConfig.stopKnowledgePromotion),
          ],
          baseConfig.knowledgePromotionEnabled,
        );

    const workspaceDir = pluginConfig.workspaceDir ?? baseConfig.workspaceDir;
    const knowledgeBaseDir =
      pluginConfig.knowledgeBaseDir ??
      pluginConfig.knowledgeDir ??
      path.join(workspaceDir, "knowledge-base");

    return {
      dataDir: pluginConfig.dataDir ?? baseConfig.dataDir,
      sessionId: this.resolveSessionId(payload, baseConfig),
      workspaceDir,
      sharedDataDir: pluginConfig.sharedDataDir ?? baseConfig.sharedDataDir,
      knowledgeBaseDir,
      contextWindow: Number(
        pluginConfig.contextWindow ?? payload?.contextWindow ?? baseConfig.contextWindow,
      ),
      contextThreshold: Number(
        pluginConfig.contextThreshold ??
          pluginConfig.compactionTriggerRatio ??
          baseConfig.contextThreshold,
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
      knowledgePromotionModel:
        typeof pluginConfig.knowledgePromotionModel === "string" &&
        pluginConfig.knowledgePromotionModel.trim().length > 0
          ? pluginConfig.knowledgePromotionModel
          : typeof pluginConfig.knowledgeModel === "string" &&
              pluginConfig.knowledgeModel.trim().length > 0
            ? pluginConfig.knowledgeModel
            : undefined,
      summaryMaxOutputTokens: Number(
        pluginConfig.summaryMaxOutputTokens ?? baseConfig.summaryMaxOutputTokens,
      ),
      strictCompaction: this.resolveBooleanFlag(
        [
          pluginConfig.strictCompaction,
          pluginConfig.requireLlmSummary,
          this.inverseBoolean(pluginConfig.allowFallbackSummary),
          this.inverseBoolean(pluginConfig.enableFallbackSummary),
        ],
        baseConfig.strictCompaction,
      ),
      compactionBarrierEnabled: this.resolveBooleanFlag(
        [
          pluginConfig.compactionBarrierEnabled,
          pluginConfig.compressBeforeAssemble,
          this.inverseBoolean(pluginConfig.disableCompactionBarrier),
        ],
        baseConfig.compactionBarrierEnabled,
      ),
      runtimeCaptureEnabled,
      durableMemoryEnabled,
      autoRecallEnabled,
      knowledgePromotionEnabled,
      emergencyBrake,
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
    const occurrenceCounts = new Map<string, number>();
    return messages
      .filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) &&
          typeof message === "object" &&
          typeof message.role === "string" &&
          allowedRoles.has(String(message.role)) &&
          "content" in message,
      )
      .map((message) => {
        const role = message.role as RawMessage["role"];
        const text = this.normalizeRuntimeMessageText(
          this.extractTextFromContent(message.content),
        );
        const occurrenceKey = `${role}:${this.normalizeWhitespace(text)}`;
        const occurrenceIndex = (occurrenceCounts.get(occurrenceKey) ?? 0) + 1;
        occurrenceCounts.set(occurrenceKey, occurrenceIndex);

        const mergedMetadata = this.mergeRuntimeMetadata(message);
        return {
          sourceKey: this.resolveRuntimeMessageSourceKey(
            message,
            role,
            text,
            occurrenceIndex,
          ),
          id:
            typeof message.id === "string" && message.id.trim().length > 0
              ? message.id
              : undefined,
          role,
          content: message.content,
          text,
          ...(Object.keys(mergedMetadata).length > 0
            ? { metadata: mergedMetadata }
            : {}),
          ...(typeof message.timestamp === "number"
            ? { timestamp: message.timestamp }
            : typeof message.createdAt === "string"
              ? { timestamp: message.createdAt }
              : {}),
        };
      });
  }

  private mergeRuntimeMetadata(
    message: Record<string, unknown>,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> =
      typeof message.metadata === "object" && message.metadata && !Array.isArray(message.metadata)
        ? { ...(message.metadata as Record<string, unknown>) }
        : {};

    const envelopeKeys = [
      "type",
      "kind",
      "origin",
      "source",
      "channel",
      "visibility",
      "name",
      "subtype",
      "internal",
      "hidden",
      "ephemeral",
      "controlPlane",
      "hostGenerated",
      "persist",
      "status",
    ] as const;

    for (const key of envelopeKeys) {
      const value = message[key];
      if (value !== undefined && metadata[key] === undefined) {
        metadata[key] = value;
      }
    }

    return metadata;
  }

  private resolveRuntimeMessageSourceKey(
    message: Record<string, unknown>,
    role: RawMessage["role"],
    text: string,
    occurrenceIndex: number,
  ): string {
    const explicitId =
      typeof message.id === "string" && message.id.trim().length > 0
        ? message.id.trim()
        : null;
    if (explicitId) {
      return `id:${explicitId}`;
    }

    return `derived:${role}:${occurrenceIndex}:${this.buildStableDigest(this.normalizeWhitespace(text))}`;
  }

  private buildStableDigest(text: string): string {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  private normalizeRuntimeMessageText(text: string): string {
    let normalized = text.trim();
    const metadataPrefix =
      /^(?:conversation|message)\s+info\s*\(untrusted metadata\):\s*```(?:json)?\s*[\s\S]*?```\s*/i;

    while (normalized.length > 0) {
      const stripped = normalized.replace(metadataPrefix, "").trim();
      if (stripped === normalized) {
        break;
      }
      normalized = stripped;
    }

    return normalized;
  }

  private normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private estimateTokens(text: string): number {
    return Math.max(Math.ceil(text.length / 4), 1);
  }

  private resolveBooleanFlag(candidates: unknown[], fallback: boolean): boolean {
    for (const candidate of candidates) {
      if (typeof candidate === "boolean") {
        return candidate;
      }
      if (typeof candidate === "string") {
        const normalized = candidate.trim().toLowerCase();
        if (["true", "1", "yes", "on", "enabled"].includes(normalized)) {
          return true;
        }
        if (["false", "0", "no", "off", "disabled"].includes(normalized)) {
          return false;
        }
      }
    }
    return fallback;
  }

  private inverseBoolean(value: unknown): boolean | undefined {
    if (typeof value === "boolean") {
      return !value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on", "enabled"].includes(normalized)) {
        return false;
      }
      if (["false", "0", "no", "off", "disabled"].includes(normalized)) {
        return true;
      }
    }
    return undefined;
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

