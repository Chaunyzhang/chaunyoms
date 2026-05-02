import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { BridgeConfig, ConfigPreset, LoggerLike, RawMessage } from "../types";
import { DEFAULT_BRIDGE_CONFIG } from "./OpenClawHostServices";
import { getOpenClawConfigPath, getOpenClawHomeDir } from "./HostPathResolver";
import { HostRecord, isHostRecord, OpenClawApiLike } from "./OpenClawHostTypes";
import { OpenClawConfigResolver } from "./OpenClawConfigResolver";
import { OpenClawConfigGuidanceAdvisor } from "./OpenClawConfigGuidanceAdvisor";
import { OpenClawModelResolver } from "./OpenClawModelResolver";
import { OpenClawRuntimeMessageExtractor } from "./OpenClawRuntimeMessageExtractor";
import { OpenClawToolConfigResolver } from "./OpenClawToolConfigResolver";
import {
  inspectOpenClawCompatibility,
  OpenClawCompatibilityReport,
} from "./OpenClawCompatibilityContract";

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

interface PayloadMessage extends Record<string, unknown> {
  content?: unknown;
  id?: unknown;
  metadata?: unknown;
  role?: unknown;
  turnNumber?: unknown;
}

interface OpenClawPayloadLike extends Record<string, unknown> {
  agent?: Record<string, unknown>;
  agentId?: unknown;
  config?: Record<string, unknown>;
  content?: unknown;
  context?: Record<string, unknown>;
  contextWindow?: unknown;
  conversation?: Record<string, unknown>;
  id?: unknown;
  input?: Record<string, unknown>;
  message?: PayloadMessage;
  messages?: unknown;
  metadata?: unknown;
  model?: unknown;
  role?: unknown;
  session?: Record<string, unknown>;
  sessionId?: unknown;
  systemPrompt?: unknown;
  systemPromptTokens?: unknown;
  tokenBudget?: unknown;
  turn?: Record<string, unknown>;
  turnNumber?: unknown;
  cwd?: unknown;
  workspaceDir?: unknown;
}

export class OpenClawPayloadAdapter {
  private readonly configGuidanceAdvisor = new OpenClawConfigGuidanceAdvisor();
  private readonly configResolver = new OpenClawConfigResolver({
    applyRetrievalStrengthPreset: this.applyRetrievalStrengthPreset.bind(this),
    buildDataDir: this.buildDataDir.bind(this),
    buildKnowledgeBaseDir: this.buildKnowledgeBaseDir.bind(this),
    buildMemoryVaultDir: this.buildMemoryVaultDir.bind(this),
    firstRecordCandidate: this.firstRecordCandidate.bind(this),
    hasDirectoryValue: this.hasDirectoryValue.bind(this),
    inverseBoolean: this.inverseBoolean.bind(this),
    resolveAgentId: this.resolveAgentId.bind(this),
    resolveBooleanFlag: this.resolveBooleanFlag.bind(this),
    resolveConfiguredContextWindow: this.resolveConfiguredContextWindow.bind(this),
    resolveDirectoryValue: this.resolveDirectoryValue.bind(this),
    resolveNumberConfig: this.resolveNumberConfig.bind(this),
    resolveOptionalString: this.resolveOptionalString.bind(this),
    resolveOptionalStringEnum: this.resolveOptionalStringEnum.bind(this),
    resolvePluginConfig: this.resolvePluginConfig.bind(this),
    resolvePresetDefaults: this.resolvePresetDefaults.bind(this),
    resolveRetrievalStrengthValue: this.resolveRetrievalStrengthValue.bind(this),
    resolveSessionId: this.resolveSessionId.bind(this),
    resolveStringEnum: this.resolveStringEnum.bind(this),
    resolveStringList: this.resolveStringList.bind(this),
    resolveStringValue: this.resolveStringValue.bind(this),
    validateConfig: this.validateConfig.bind(this),
  });
  private readonly modelResolver = new OpenClawModelResolver(() => this.getApi());
  private readonly runtimeMessageExtractor = new OpenClawRuntimeMessageExtractor();
  private readonly toolConfigResolver = new OpenClawToolConfigResolver(
    () => this.getApi(),
    () => this.getLogger(),
  );

  constructor(
    private readonly getApi: () => OpenClawApiLike | undefined,
    private readonly getLogger: () => LoggerLike,
  ) {}

  resolveLifecycleContext(
    payload?: unknown,
    currentConfig: BridgeConfig = DEFAULT_BRIDGE_CONFIG,
  ): LifecycleContext {
    const payloadRecord = this.toPayloadRecord(payload);
    const config = this.resolveConfig(payloadRecord, currentConfig);
    return {
      sessionId: this.resolveSessionId(payloadRecord, currentConfig),
      config,
      totalBudget: this.resolveContextWindow(payloadRecord, config),
      systemPromptTokens: this.resolveSystemPromptTokens(payloadRecord),
      summaryModel: this.resolveSummaryModel(payloadRecord, config),
      runtimeMessages: this.extractRuntimeMessages(payloadRecord),
    };
  }

  resolveIngestPayload(
    payload?: unknown,
    currentConfig: BridgeConfig = DEFAULT_BRIDGE_CONFIG,
  ): IngestPayload {
    const payloadRecord = this.toPayloadRecord(payload);
    const context = this.resolveLifecycleContext(payloadRecord, currentConfig);
    return {
      sessionId: context.sessionId,
      config: context.config,
      id: this.resolveMessageId(payloadRecord),
      role: this.resolveRole(payloadRecord),
      content: this.extractTextFromContent(
        payloadRecord.message?.content ?? payloadRecord.content,
      ),
      turnNumber: this.resolveExplicitTurnNumber(payloadRecord),
      metadata: this.resolveMetadata(payloadRecord),
    };
  }

  resolveToolConfig(): ToolConfigResult {
    return this.toolConfigResolver.resolveToolConfig();
  }

  inspectOpenClawCompatibility(): OpenClawCompatibilityReport {
    return inspectOpenClawCompatibility(this.getApi());
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

  describeConfigGuidance(config: BridgeConfig): {
    preset: ConfigPreset;
    warnings: string[];
  } {
    return this.configGuidanceAdvisor.describe(config);
  }

  private resolveConfig(
    payload: OpenClawPayloadLike,
    currentConfig: BridgeConfig,
  ): BridgeConfig {
    return this.configResolver.resolve(payload, currentConfig);
  }

  private resolvePresetDefaults(
    configPreset: ConfigPreset,
    baseConfig: BridgeConfig,
  ): Pick<
    BridgeConfig,
    "autoRecallEnabled" | "semanticCandidateExpansionEnabled" | "semanticCandidateLimit"
  > {
    switch (configPreset) {
      case "safe":
        return {
          autoRecallEnabled: false,
          semanticCandidateExpansionEnabled: false,
          semanticCandidateLimit: 3,
        };
      case "enhanced_recall":
        return {
          autoRecallEnabled: true,
          semanticCandidateExpansionEnabled: true,
          semanticCandidateLimit: Math.max(baseConfig.semanticCandidateLimit, 8),
        };
      case "balanced":
      default:
        return {
          autoRecallEnabled: baseConfig.autoRecallEnabled,
          semanticCandidateExpansionEnabled: baseConfig.semanticCandidateExpansionEnabled,
          semanticCandidateLimit: baseConfig.semanticCandidateLimit,
        };
    }
  }

  private resolveRetrievalStrengthValue(
    candidates: unknown[],
    fallback: BridgeConfig["retrievalStrength"],
  ): BridgeConfig["retrievalStrength"] {
    const allowed: BridgeConfig["retrievalStrength"][] = ["low", "medium", "high", "xhigh", "custom"];
    const legacyAliases: Record<string, BridgeConfig["retrievalStrength"]> = {
      off: "low",
      light: "low",
      auto: "medium",
      strict: "high",
      forensic: "xhigh",
    };
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const normalized = candidate.trim().toLowerCase();
      if ((allowed as string[]).includes(normalized)) {
        return normalized as BridgeConfig["retrievalStrength"];
      }
      if (legacyAliases[normalized]) {
        return legacyAliases[normalized];
      }
    }
    return fallback;
  }

  private applyRetrievalStrengthPreset(config: BridgeConfig): BridgeConfig {
    if (config.retrievalStrength === "custom") {
      return config;
    }
    if (config.retrievalStrength === "high") {
      return {
        ...config,
        autoRecallEnabled: config.emergencyBrake ? false : true,
      };
    }
    if (config.retrievalStrength !== "xhigh") {
      return config;
    }
    const enabled = !config.emergencyBrake;
    return {
      ...config,
      autoRecallEnabled: enabled,
      ragEnabled: enabled && config.ragProvider !== "none",
      graphEnabled: enabled && config.graphProvider !== "none",
      rerankEnabled: enabled && config.rerankProvider !== "none",
      graphBuilderEnabled: enabled && config.graphBuilderProvider !== "none",
      embeddingEnabled: enabled && config.embeddingProvider !== "none",
      evidenceAnswerResolverEnabled: enabled && config.evidenceAnswerResolverProvider !== "none",
      heavyRetrievalPolicy: "planner_only",
      ragPlannerPolicy: "planner_only",
      graphPlannerPolicy: "planner_only",
      rerankPlannerPolicy: "candidate_overload_required",
    };
  }

  private hasDirectoryValue(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
  }

  private resolveDirectoryValue(...values: unknown[]): string {
    for (const value of values) {
      if (this.hasDirectoryValue(value)) {
        return value.trim();
      }
    }
    return "";
  }

  private resolveStringValue(value: unknown, fallback: string): string {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    return fallback;
  }

  private buildDataDir(sharedDataDir: string): string {
    return path.join(sharedDataDir, "data", "chaunyoms");
  }

  private buildMemoryVaultDir(sharedDataDir: string): string {
    return path.join(sharedDataDir, "vaults", "chaunyoms");
  }

  private buildKnowledgeBaseDir(sharedDataDir: string): string {
    return path.join(sharedDataDir, "knowledge-base");
  }

  private resolveSessionId(
    payload: OpenClawPayloadLike,
    currentConfig: BridgeConfig,
  ): string {
    const value =
      payload?.sessionId ??
      payload?.session?.id ??
      this.getApi()?.session?.id ??
      currentConfig.sessionId ??
      DEFAULT_BRIDGE_CONFIG.sessionId;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : DEFAULT_BRIDGE_CONFIG.sessionId;
  }

  private resolveAgentId(
    payload: OpenClawPayloadLike,
    currentConfig: BridgeConfig,
  ): string {
    const direct =
      payload?.agentId ??
      payload?.agent?.id ??
      payload?.session?.agentId ??
      this.getApi()?.agent?.id ??
      this.getApi()?.runtime?.agent?.id ??
      this.getApi()?.context?.agent?.id;

    const directAgentId = typeof direct === "string" && direct.trim().length > 0
      ? direct.trim()
      : null;
    if (directAgentId && directAgentId !== DEFAULT_BRIDGE_CONFIG.agentId) {
      return directAgentId;
    }

    const configuredAgentId =
      typeof currentConfig.agentId === "string" && currentConfig.agentId.trim().length > 0
        ? currentConfig.agentId.trim()
        : null;
    if (configuredAgentId && configuredAgentId !== DEFAULT_BRIDGE_CONFIG.agentId) {
      return configuredAgentId;
    }

    const inferredFromSession = this.resolveAgentIdFromOpenClawSessionOwner(
      payload,
      currentConfig,
    );
    if (inferredFromSession) {
      return inferredFromSession;
    }

    const inferredFromWorkspace = this.resolveAgentIdFromOpenClawWorkspaceOwner(
      payload,
    );
    if (inferredFromWorkspace) {
      return inferredFromWorkspace;
    }

    if (directAgentId) {
      return directAgentId;
    }

    const fallback =
      configuredAgentId ??
      currentConfig.agentId ??
      DEFAULT_BRIDGE_CONFIG.agentId;

    return typeof fallback === "string" && fallback.trim().length > 0
      ? fallback.trim()
      : DEFAULT_BRIDGE_CONFIG.agentId;
  }

  private resolveAgentIdFromOpenClawSessionOwner(
    payload: OpenClawPayloadLike,
    currentConfig: BridgeConfig,
  ): string | null {
    const sessionId = this.resolveSessionId(payload, currentConfig);
    if (
      sessionId === DEFAULT_BRIDGE_CONFIG.sessionId ||
      sessionId.includes("/") ||
      sessionId.includes("\\") ||
      path.basename(sessionId) !== sessionId
    ) {
      return null;
    }

    const agentsDir = path.join(getOpenClawHomeDir(), "agents");
    if (!existsSync(agentsDir)) {
      return null;
    }

    try {
      for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (this.agentRegistryContainsSession(agentsDir, entry.name, sessionId)) {
          return entry.name;
        }
        const sessionPath = path.join(
          agentsDir,
          entry.name,
          "sessions",
          `${sessionId}.jsonl`,
        );
        if (existsSync(sessionPath)) {
          return entry.name;
        }
      }
    } catch (error) {
      this.getLogger().warn("agent_id_session_owner_lookup_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  }

  private agentRegistryContainsSession(
    agentsDir: string,
    agentId: string,
    sessionId: string,
  ): boolean {
    const registryPath = path.join(agentsDir, agentId, "sessions", "sessions.json");
    if (!existsSync(registryPath)) {
      return false;
    }
    try {
      const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Record<
        string,
        { sessionId?: unknown }
      >;
      return Object.values(registry).some((entry) => entry?.sessionId === sessionId);
    } catch {
      return false;
    }
  }

  private resolveAgentIdFromOpenClawWorkspaceOwner(
    payload: OpenClawPayloadLike,
  ): string | null {
    const workspace = this.resolveWorkspaceCandidate(payload);
    if (!workspace) {
      return null;
    }

    try {
      const config = JSON.parse(readFileSync(getOpenClawConfigPath(), "utf8")) as {
        agents?: {
          list?: Array<{ id?: unknown; workspace?: unknown }>;
        };
      };
      const workspacePath = path.resolve(workspace);
      const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
      for (const agent of agents) {
        if (
          typeof agent.id === "string" &&
          agent.id.trim().length > 0 &&
          typeof agent.workspace === "string" &&
          path.resolve(agent.workspace) === workspacePath
        ) {
          return agent.id.trim();
        }
      }
    } catch (error) {
      this.getLogger().warn("agent_id_workspace_owner_lookup_failed", {
        workspace,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return null;
  }

  private resolveWorkspaceCandidate(payload: OpenClawPayloadLike): string | null {
    const context = isHostRecord(payload.context) ? payload.context : {};
    const runtime = this.getApi()?.runtime;
    const apiContext = this.getApi()?.context;
    const candidates = [
      payload.workspaceDir,
      payload.cwd,
      context.workspaceDir,
      context.workspace,
      context.cwd,
      runtime?.workspaceDir,
      runtime?.workspace,
      runtime?.cwd,
      apiContext?.workspaceDir,
      apiContext?.workspace,
      apiContext?.cwd,
      process.cwd(),
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return null;
  }

  private resolveMessageId(payload: OpenClawPayloadLike): string {
    const value = payload?.message?.id ?? payload?.id;
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : crypto.randomUUID();
  }

  private resolveRole(payload: OpenClawPayloadLike): RawMessage["role"] {
    const value = payload?.message?.role ?? payload?.role;
    return value === "system" ||
      value === "user" ||
      value === "assistant" ||
      value === "tool"
      ? value
      : "user";
  }

  private resolveExplicitTurnNumber(payload: OpenClawPayloadLike): number | undefined {
    if (typeof payload?.turnNumber === "number") {
      return payload.turnNumber;
    }
    if (typeof payload?.message?.turnNumber === "number") {
      return payload.message.turnNumber;
    }
    return undefined;
  }

  private resolveMetadata(payload: OpenClawPayloadLike): Record<string, unknown> | undefined {
    const metadata = payload?.message?.metadata ?? payload?.metadata;
    return isHostRecord(metadata) ? metadata : undefined;
  }

  private resolveConfiguredContextWindow(
    pluginConfig: Record<string, unknown>,
    payload: OpenClawPayloadLike,
    baseConfig: BridgeConfig,
  ): number {
    const explicitPluginWindow = this.resolvePositiveNumber([
      pluginConfig.contextWindow,
      pluginConfig.maxContextWindow,
      pluginConfig.contextWindowTokens,
    ]);
    if (explicitPluginWindow !== null) {
      return explicitPluginWindow;
    }

    const hostWindow = this.resolveHostModelContextWindow(payload);
    if (hostWindow !== null) {
      return hostWindow;
    }

    const payloadWindow = this.resolvePositiveNumber([
      payload?.contextWindow,
      payload?.context?.contextWindow,
    ]);
    if (payloadWindow !== null) {
      return payloadWindow;
    }

    return baseConfig.contextWindow;
  }

  private resolveContextWindow(
    payload: OpenClawPayloadLike,
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

  private resolveHostModelContextWindow(payload: OpenClawPayloadLike): number | null {
    return this.modelResolver.resolveHostModelContextWindow(payload?.model);
  }

  private resolveDeclaredModelContextWindow(
    config: HostRecord,
    modelRef: string,
  ): number | null {
    const defaults = config.agents;
    if (!isHostRecord(defaults)) {
      return null;
    }
    const agentsDefaults = defaults.defaults;
    if (!isHostRecord(agentsDefaults)) {
      return null;
    }
    const models = agentsDefaults.models;
    if (!isHostRecord(models)) {
      return null;
    }

    const modelConfig = models[modelRef] ?? models[this.stripProviderId(modelRef)];
    return this.resolveContextWindowFromRecord(modelConfig);
  }

  private resolveProviderModelContextWindow(
    config: HostRecord,
    modelRef: string,
  ): number | null {
    const providerId = this.resolveProviderId(modelRef);
    if (!providerId) {
      return null;
    }
    const modelId = this.stripProviderId(modelRef);
    const modelsConfig = config.models;
    if (!isHostRecord(modelsConfig)) {
      return null;
    }
    const providers = modelsConfig.providers;
    if (!isHostRecord(providers)) {
      return null;
    }
    const providerConfig = providers[providerId];
    if (!isHostRecord(providerConfig)) {
      return null;
    }
    const providerModels = providerConfig.models;
    if (!Array.isArray(providerModels)) {
      return this.resolveContextWindowFromRecord(providerConfig);
    }

    const matched = providerModels.find((entry) => {
      if (!isHostRecord(entry)) {
        return false;
      }
      const ids = [
        entry.id,
        entry.name,
        entry.model,
        entry.ref,
        entry.modelRef,
        entry.fullRef,
      ].filter((value): value is string => typeof value === "string");
      return ids.some((id) =>
        id.trim() === modelId ||
        id.trim() === modelRef ||
        `${providerId}/${id.trim()}` === modelRef,
      );
    });

    return this.resolveContextWindowFromRecord(matched);
  }

  private resolveContextWindowFromRecord(value: unknown): number | null {
    if (!isHostRecord(value)) {
      return null;
    }
    return this.resolvePositiveNumber([
      value.contextWindow,
      value.context_window,
      value.maxContextWindow,
      value.maxContextTokens,
      value.contextLength,
      value.maxInputTokens,
    ]);
  }

  private resolveSystemPromptTokens(payload: OpenClawPayloadLike): number {
    if (typeof payload?.systemPromptTokens === "number") {
      return payload.systemPromptTokens;
    }
    return this.estimateTokens(
      typeof payload?.systemPrompt === "string" ? payload.systemPrompt : "",
    );
  }

  private resolveSummaryModel(
    payload: OpenClawPayloadLike,
    config: BridgeConfig,
  ): string | undefined {
    return this.modelResolver.resolveSummaryModel(payload?.model, config);
  }

  private resolveConfiguredPrimaryModelRef(): string | undefined {
    const configCandidates = [
      this.getApi()?.config,
      this.getApi()?.context?.config,
      this.getApi()?.runtime?.config,
    ].filter((candidate): candidate is NonNullable<typeof candidate> => isHostRecord(candidate));

    for (const candidate of configCandidates) {
      const primary = candidate?.agents?.defaults?.model?.primary;
      if (typeof primary === "string" && primary.trim().length > 0) {
        return primary.trim();
      }
    }

    return undefined;
  }

  private resolveModelRefCandidate(value: unknown): string | undefined {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const directRefCandidates = [
      candidate.ref,
      candidate.modelRef,
      candidate.fullRef,
      candidate.name,
    ];
    for (const directRef of directRefCandidates) {
      if (
        typeof directRef === "string" &&
        directRef.trim().length > 0 &&
        directRef.includes("/")
      ) {
        return directRef.trim();
      }
    }

    const provider =
      typeof candidate.provider === "string" && candidate.provider.trim().length > 0
        ? candidate.provider.trim()
        : typeof candidate.providerId === "string" && candidate.providerId.trim().length > 0
          ? candidate.providerId.trim()
          : undefined;
    const modelId =
      typeof candidate.id === "string" && candidate.id.trim().length > 0
        ? candidate.id.trim()
        : typeof candidate.model === "string" && candidate.model.trim().length > 0
          ? candidate.model.trim()
          : typeof candidate.name === "string" && candidate.name.trim().length > 0
            ? candidate.name.trim()
            : undefined;

    if (provider && modelId) {
      return `${provider}/${modelId}`;
    }

    return modelId;
  }

  private extractRuntimeMessages(payload: OpenClawPayloadLike): RuntimeMessageSnapshot[] {
    return this.runtimeMessageExtractor.extract([
      payload?.messages,
      payload?.conversation?.messages,
      payload?.turn?.messages,
      payload?.context?.messages,
      payload?.input?.messages,
    ], this.extractTextFromContent.bind(this));
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

  private resolveNumberFlag(candidates: unknown[], fallback: number): number {
    for (const candidate of candidates) {
      const value = typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && candidate.trim().length > 0
          ? Number(candidate)
          : Number.NaN;
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return fallback;
  }

  private resolvePositiveNumber(candidates: unknown[]): number | null {
    for (const candidate of candidates) {
      const value = typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && candidate.trim().length > 0
          ? Number(candidate)
          : Number.NaN;
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return null;
  }

  private resolveProviderId(modelRef: string): string | null {
    const slashIndex = modelRef.indexOf("/");
    if (slashIndex <= 0) {
      return null;
    }
    return modelRef.slice(0, slashIndex);
  }

  private stripProviderId(modelRef: string): string {
    const slashIndex = modelRef.indexOf("/");
    return slashIndex <= 0 ? modelRef.trim() : modelRef.slice(slashIndex + 1).trim();
  }

  private resolveNumberConfig(candidates: unknown[], fallback: number): number {
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null || candidate === "") {
        continue;
      }
      return typeof candidate === "number" ? candidate : Number(candidate);
    }
    return fallback;
  }

  private validateConfig(config: BridgeConfig): BridgeConfig {
    const errors: string[] = [];
    const pathFields: Array<keyof Pick<
      BridgeConfig,
      "dataDir" | "workspaceDir" | "sharedDataDir" | "knowledgeBaseDir" | "memoryVaultDir" | "brainPackOutputDir"
    >> = [
      "dataDir",
      "workspaceDir",
      "sharedDataDir",
      "knowledgeBaseDir",
      "memoryVaultDir",
      "brainPackOutputDir",
    ];

    for (const field of pathFields) {
      const value = config[field];
      if (typeof value !== "string" || value.trim().length === 0) {
        errors.push(`${field} must be a non-empty path`);
      } else if (value.includes("\0")) {
        errors.push(`${field} must not contain null bytes`);
      }
    }

    if (!Number.isFinite(config.contextWindow) || config.contextWindow <= 0) {
      errors.push("contextWindow must be a finite number greater than 0");
    }
    if (!Number.isFinite(config.contextThreshold) || config.contextThreshold <= 0 || config.contextThreshold >= 1) {
      errors.push("contextThreshold must be greater than 0 and less than 1");
    }
    if (!Number.isFinite(config.freshTailTokens) || config.freshTailTokens < 0) {
      errors.push("freshTailTokens must be a finite non-negative number");
    }
    if (
      Number.isFinite(config.freshTailTokens) &&
      Number.isFinite(config.contextWindow) &&
      config.freshTailTokens >= config.contextWindow
    ) {
      errors.push("freshTailTokens must be less than contextWindow");
    }
    if (!Number.isFinite(config.maxFreshTailTurns) || config.maxFreshTailTurns < 0 || !Number.isInteger(config.maxFreshTailTurns)) {
      errors.push("maxFreshTailTurns must be a non-negative integer");
    }
    if (!Number.isFinite(config.compactionBatchTurns) || config.compactionBatchTurns <= 0 || !Number.isInteger(config.compactionBatchTurns)) {
      errors.push("compactionBatchTurns must be a positive integer");
    }
    if (!Number.isFinite(config.summaryMaxOutputTokens) || config.summaryMaxOutputTokens <= 0 || config.summaryMaxOutputTokens > 8192) {
      errors.push("summaryMaxOutputTokens must be greater than 0 and at most 8192");
    }
    if (
      !Number.isFinite(config.semanticCandidateLimit) ||
      config.semanticCandidateLimit < 0 ||
      !Number.isInteger(config.semanticCandidateLimit)
    ) {
      errors.push("semanticCandidateLimit must be a non-negative integer");
    }
    if (!["low", "medium", "high", "xhigh", "custom"].includes(config.retrievalStrength)) {
      errors.push("retrievalStrength must be low, medium, high, xhigh, or custom");
    }
    if (!["off", "shadow", "auto"].includes(config.llmPlannerMode)) {
      errors.push("llmPlannerMode must be off, shadow, or auto");
    }
    if (!["manual", "scheduled"].includes(config.brainPackMode)) {
      errors.push("brainPackMode must be manual or scheduled");
    }
    if (!Number.isFinite(config.brainPackTurnInterval) || config.brainPackTurnInterval <= 0 || !Number.isInteger(config.brainPackTurnInterval)) {
      errors.push("brainPackTurnInterval must be a positive integer");
    }
    if (!Number.isFinite(config.brainPackIntervalHours) || config.brainPackIntervalHours <= 0) {
      errors.push("brainPackIntervalHours must be a positive number");
    }
    if (!["strict", "redact", "report_only"].includes(config.brainPackRedactionMode)) {
      errors.push("brainPackRedactionMode must be strict, redact, or report_only");
    }
    if (!["never", "redacted_excerpt", "private_archive_only"].includes(config.brainPackIncludeRawTranscript)) {
      errors.push("brainPackIncludeRawTranscript must be never, redacted_excerpt, or private_archive_only");
    }
    if (!["never", "redacted_excerpt", "private_archive_only"].includes(config.brainPackIncludeToolOutputs)) {
      errors.push("brainPackIncludeToolOutputs must be never, redacted_excerpt, or private_archive_only");
    }
    if (!["disabled", "coexist", "absorbed"].includes(config.openClawNativeMode)) {
      errors.push("openClawNativeMode must be disabled, coexist, or absorbed");
    }
    for (const [field, value] of Object.entries({
      openClawNativeMemoryCoreMode: config.openClawNativeMemoryCoreMode,
      openClawNativeActiveMemoryMode: config.openClawNativeActiveMemoryMode,
      openClawNativeMemoryWikiMode: config.openClawNativeMemoryWikiMode,
      openClawNativeDreamingMode: config.openClawNativeDreamingMode,
    })) {
      if (value !== undefined && !["disabled", "coexist", "absorbed"].includes(value)) {
        errors.push(`${field} must be disabled, coexist, or absorbed`);
      }
    }
    if (!["none", "sqlite_graph", "sqlite_edges", "external"].includes(config.graphProvider)) {
      errors.push("graphProvider must be none, sqlite_graph, sqlite_edges, or external");
    }
    if (!["none", "sqlite_vec", "brute_force", "embedding", "external"].includes(config.ragProvider)) {
      errors.push("ragProvider must be none, sqlite_vec, brute_force, embedding, or external");
    }
    if (!["none", "deterministic", "llm", "specialist", "model", "external"].includes(config.rerankProvider)) {
      errors.push("rerankProvider must be none, deterministic, llm, specialist, model, or external");
    }
    if (!["none", "local_hash", "external"].includes(config.embeddingProvider)) {
      errors.push("embeddingProvider must be none, local_hash, or external");
    }
    if (!Number.isFinite(config.embeddingDimensions) || config.embeddingDimensions < 16 || !Number.isInteger(config.embeddingDimensions)) {
      errors.push("embeddingDimensions must be an integer of at least 16");
    }
    if (!Number.isFinite(config.embeddingJobMaxBatch) || config.embeddingJobMaxBatch < 1 || !Number.isInteger(config.embeddingJobMaxBatch)) {
      errors.push("embeddingJobMaxBatch must be a positive integer");
    }
    if (!Number.isFinite(config.embeddingJobMaxRetries) || config.embeddingJobMaxRetries < 0 || !Number.isInteger(config.embeddingJobMaxRetries)) {
      errors.push("embeddingJobMaxRetries must be a non-negative integer");
    }
    if (!Number.isFinite(config.vectorSearchMaxCandidates) || config.vectorSearchMaxCandidates < 1 || !Number.isInteger(config.vectorSearchMaxCandidates)) {
      errors.push("vectorSearchMaxCandidates must be a positive integer");
    }
    if (!Number.isFinite(config.bruteForceVectorMaxRows) || config.bruteForceVectorMaxRows < 1 || !Number.isInteger(config.bruteForceVectorMaxRows)) {
      errors.push("bruteForceVectorMaxRows must be a positive integer");
    }
    if (!["none", "deterministic", "llm", "external"].includes(config.graphBuilderProvider)) {
      errors.push("graphBuilderProvider must be none, deterministic, llm, or external");
    }
    if (!["none", "deterministic", "llm", "external"].includes(config.evidenceAnswerResolverProvider)) {
      errors.push("evidenceAnswerResolverProvider must be none, deterministic, llm, or external");
    }
    if (!Number.isFinite(config.evidenceAnswerResolverTimeoutMs) || config.evidenceAnswerResolverTimeoutMs < 1 || !Number.isInteger(config.evidenceAnswerResolverTimeoutMs)) {
      errors.push("evidenceAnswerResolverTimeoutMs must be a positive integer");
    }
    if (!["deterministic", "planner_decides", "delegated_agent"].includes(config.dagExpansionMode)) {
      errors.push("dagExpansionMode must be deterministic, planner_decides, or delegated_agent");
    }
    if (!["none", "host_subagent", "llm"].includes(config.dagExpansionAgentProvider)) {
      errors.push("dagExpansionAgentProvider must be none, host_subagent, or llm");
    }
    if (config.dagExpansionMode === "delegated_agent" && config.dagExpansionAgentProvider === "none") {
      errors.push("dagExpansionMode=delegated_agent requires dagExpansionAgentProvider to be host_subagent or llm");
    }
    if (!Number.isFinite(config.dagExpansionAgentTimeoutMs) || config.dagExpansionAgentTimeoutMs < 1 || !Number.isInteger(config.dagExpansionAgentTimeoutMs)) {
      errors.push("dagExpansionAgentTimeoutMs must be a positive integer");
    }
    if (!Number.isFinite(config.graphMaxDepth) || config.graphMaxDepth < 1 || !Number.isInteger(config.graphMaxDepth)) {
      errors.push("graphMaxDepth must be a positive integer");
    }
    if (!Number.isFinite(config.graphMaxFanout) || config.graphMaxFanout < 1 || !Number.isInteger(config.graphMaxFanout)) {
      errors.push("graphMaxFanout must be a positive integer");
    }
    if (!Number.isFinite(config.graphMinConfidence) || config.graphMinConfidence < 0 || config.graphMinConfidence > 1) {
      errors.push("graphMinConfidence must be between 0 and 1");
    }
    if (!Array.isArray(config.graphAllowedRelations) || config.graphAllowedRelations.some((relation) => typeof relation !== "string" || relation.trim().length === 0)) {
      errors.push("graphAllowedRelations must be a list of non-empty relation names");
    }
    if (!Number.isFinite(config.graphCandidateLimit) || config.graphCandidateLimit < 1 || !Number.isInteger(config.graphCandidateLimit)) {
      errors.push("graphCandidateLimit must be a positive integer");
    }
    if (!Number.isFinite(config.rerankTimeoutMs) || config.rerankTimeoutMs < 0) {
      errors.push("rerankTimeoutMs must be a finite non-negative number");
    }
    if (!["fail_closed", "isolate_optional"].includes(config.featureIsolationMode)) {
      errors.push("featureIsolationMode must be fail_closed or isolate_optional");
    }
    if (!["disabled", "planner_only"].includes(config.heavyRetrievalPolicy)) {
      errors.push("heavyRetrievalPolicy must be disabled or planner_only");
    }
    if (!["disabled", "planner_only"].includes(config.ragPlannerPolicy)) {
      errors.push("ragPlannerPolicy must be disabled or planner_only");
    }
    if (!["disabled", "planner_only"].includes(config.graphPlannerPolicy)) {
      errors.push("graphPlannerPolicy must be disabled or planner_only");
    }
    if (!["disabled", "planner_only", "candidate_overload_required"].includes(config.rerankPlannerPolicy)) {
      errors.push("rerankPlannerPolicy must be disabled, planner_only, or candidate_overload_required");
    }
    if (
      !Number.isFinite(config.candidateRerankThreshold) ||
      config.candidateRerankThreshold < 1 ||
      !Number.isInteger(config.candidateRerankThreshold)
    ) {
      errors.push("candidateRerankThreshold must be a positive integer");
    }
    if (
      !Number.isFinite(config.laneCandidateRerankThreshold) ||
      config.laneCandidateRerankThreshold < 1 ||
      !Number.isInteger(config.laneCandidateRerankThreshold)
    ) {
      errors.push("laneCandidateRerankThreshold must be a positive integer");
    }
    if (
      !Number.isFinite(config.candidateAmbiguityMargin) ||
      config.candidateAmbiguityMargin < 0 ||
      config.candidateAmbiguityMargin >= 1
    ) {
      errors.push("candidateAmbiguityMargin must be greater than or equal to 0 and less than 1");
    }
    if (!Number.isFinite(config.maxEnhancementLatencyMs) || config.maxEnhancementLatencyMs < 0) {
      errors.push("maxEnhancementLatencyMs must be a finite non-negative number");
    }
    if (!Number.isFinite(config.maxRerankCandidates) || config.maxRerankCandidates < 0 || !Number.isInteger(config.maxRerankCandidates)) {
      errors.push("maxRerankCandidates must be a non-negative integer");
    }
    if (!["delete", "wal"].includes(config.sqliteJournalMode)) {
      errors.push("sqliteJournalMode must be either delete or wal");
    }
    if (errors.length > 0) {
      const message = `Invalid ChaunyOMS config: ${errors.join("; ")}`;
      this.getLogger().error("config_validation_failed", { errors });
      throw new Error(message);
    }

    return config;
  }

  private resolveOptionalString(value: unknown, fallback?: string): string | undefined {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    return fallback;
  }

  private resolveOptionalStringEnum(
    candidates: unknown[],
    allowed: string[],
    fallback?: string,
  ): string | undefined {
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const normalized = candidate.trim().toLowerCase();
      if (allowed.includes(normalized)) {
        return normalized;
      }
    }
    return fallback;
  }

  private resolveStringEnum(
    candidates: unknown[],
    allowed: string[],
    fallback: string,
  ): string {
    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        continue;
      }
      const normalized = candidate.trim().toLowerCase();
      if (allowed.includes(normalized)) {
        return normalized;
      }
    }
    return fallback;
  }

  private resolveStringList(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) {
      return [...fallback];
    }
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
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

  private resolvePluginConfig(payload: OpenClawPayloadLike): Record<string, unknown> {
    return this.firstRecordCandidate(
      payload.config,
      this.getApi()?.pluginConfig ??
        this.getApi()?.context?.pluginConfig ??
        this.getApi()?.runtime?.pluginConfig ??
        this.getApi()?.config?.plugins?.entries?.oms?.config ??
        this.getApi()?.context?.config?.plugins?.entries?.oms?.config ??
        this.getApi()?.runtime?.config?.plugins?.entries?.oms?.config ??
        this.getApi()?.config,
    ) ?? {};
  }

  private toPayloadRecord(payload: unknown): OpenClawPayloadLike {
    return isHostRecord(payload) ? payload : {};
  }

  private firstRecordCandidate(
    ...candidates: unknown[]
  ): Record<string, unknown> | null {
    return candidates.find(isHostRecord) ?? null;
  }
}
