import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { BridgeConfig, ConfigPreset, LoggerLike, RawMessage } from "../types";
import { DEFAULT_BRIDGE_CONFIG } from "./OpenClawHostServices";
import { getOpenClawConfigPath, getOpenClawHomeDir } from "./HostPathResolver";
import { HostRecord, isHostRecord, OpenClawApiLike } from "./OpenClawHostTypes";

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
    const api = this.getApi();
    const runtimeConfig =
      api?.config ??
      api?.pluginConfig ??
      api?.runtime?.config ??
      api?.context?.config ??
      {};
    const runtimeEnableTools = isHostRecord(runtimeConfig)
      ? runtimeConfig.enableTools
      : undefined;
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
    const warnings: string[] = [];
    if (config.emergencyBrake) {
      warnings.push("Emergency brake is enabled; runtime capture, durable writes, auto recall, and knowledge promotion are forced off.");
    }
    if (!config.strictCompaction && config.knowledgePromotionEnabled) {
      warnings.push("Knowledge promotion is enabled while strict compaction is off; weaker summaries may reduce promotion quality.");
    }
    if (!config.runtimeCaptureEnabled && config.semanticCandidateExpansionEnabled) {
      warnings.push("Semantic candidate expansion is enabled without runtime capture; only stored assets can contribute candidates.");
    }
    if (config.semanticCandidateExpansionEnabled && config.semanticCandidateLimit <= 0) {
      warnings.push("Semantic candidate expansion is enabled but semanticCandidateLimit is non-positive.");
    }
    if (config.knowledgePromotionEnabled && !config.durableMemoryEnabled) {
      warnings.push("Knowledge promotion is enabled while durable memory extraction is disabled; promotion inputs will be thinner than expected.");
    }
    if (config.knowledgePromotionEnabled && !config.knowledgePromotionManualReviewEnabled) {
      warnings.push("Knowledge promotion is automatic. Set knowledgePromotionManualReviewEnabled=true if you want a scored manual approval queue before Markdown writes.");
    }
    return {
      preset: config.configPreset,
      warnings,
    };
  }

  private resolveConfig(
    payload: OpenClawPayloadLike,
    currentConfig: BridgeConfig,
  ): BridgeConfig {
    const pluginConfig = this.firstRecordCandidate(
      payload.config,
      this.getApi()?.pluginConfig ??
        this.getApi()?.context?.pluginConfig ??
        this.getApi()?.runtime?.pluginConfig ??
        this.getApi()?.config?.plugins?.entries?.chaunyoms?.config ??
        this.getApi()?.context?.config?.plugins?.entries?.chaunyoms?.config ??
        this.getApi()?.runtime?.config?.plugins?.entries?.chaunyoms?.config ??
        this.getApi()?.config,
    ) ?? {};
    const baseConfig = currentConfig ?? DEFAULT_BRIDGE_CONFIG;
    const configPreset = this.resolveStringEnum(
      [
        pluginConfig.configPreset,
        pluginConfig.preset,
      ],
      ["safe", "balanced", "enhanced_recall"],
      baseConfig.configPreset,
    ) as ConfigPreset;
    const presetDefaults = this.resolvePresetDefaults(configPreset, baseConfig);
    const sharedDataDir = this.resolveDirectoryValue(
      pluginConfig.sharedDataDir,
      baseConfig.sharedDataDir,
    );
    const workspaceDir = this.resolveDirectoryValue(
      pluginConfig.workspaceDir,
      baseConfig.workspaceDir,
    );
    const hasExplicitSharedDataDir = this.hasDirectoryValue(
      pluginConfig.sharedDataDir,
    );
    const dataDir = this.resolveDirectoryValue(
      pluginConfig.dataDir,
      hasExplicitSharedDataDir
        ? this.buildDataDir(sharedDataDir)
        : baseConfig.dataDir,
    );
    const knowledgeBaseDir = this.resolveDirectoryValue(
      pluginConfig.knowledgeBaseDir,
      pluginConfig.knowledgeDir,
      hasExplicitSharedDataDir
        ? this.buildKnowledgeBaseDir(sharedDataDir)
        : baseConfig.knowledgeBaseDir,
    );
    const memoryVaultDir = this.resolveDirectoryValue(
      pluginConfig.memoryVaultDir,
      hasExplicitSharedDataDir
        ? this.buildMemoryVaultDir(sharedDataDir)
        : baseConfig.memoryVaultDir,
    );

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
          presetDefaults.autoRecallEnabled,
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

    const knowledgePromotionManualReviewEnabled = this.resolveBooleanFlag(
      [
        pluginConfig.knowledgePromotionManualReviewEnabled,
        pluginConfig.knowledgeManualReviewEnabled,
        pluginConfig.manualKnowledgeReview,
      ],
      baseConfig.knowledgePromotionManualReviewEnabled,
    );

    const knowledgeIntakeMode = this.resolveStringEnum(
      [
        pluginConfig.knowledgeIntakeMode,
        pluginConfig.knowledgeIntakePolicy,
      ],
      ["conservative", "balanced", "aggressive"],
      baseConfig.knowledgeIntakeMode,
    ) as BridgeConfig["knowledgeIntakeMode"];

    const knowledgeIntakeAllowProjectState = this.resolveBooleanFlag(
      [
        pluginConfig.knowledgeIntakeAllowProjectState,
        pluginConfig.allowProjectStateKnowledge,
      ],
      baseConfig.knowledgeIntakeAllowProjectState,
    );

    const knowledgeIntakeAllowBranchSummaries = this.resolveBooleanFlag(
      [
        pluginConfig.knowledgeIntakeAllowBranchSummaries,
        pluginConfig.allowBranchSummaryKnowledge,
      ],
      baseConfig.knowledgeIntakeAllowBranchSummaries,
    );

    const knowledgeIntakeUserOverrideEnabled = this.resolveBooleanFlag(
      [
        pluginConfig.knowledgeIntakeUserOverrideEnabled,
        pluginConfig.knowledgeUserOverrideEnabled,
      ],
      baseConfig.knowledgeIntakeUserOverrideEnabled,
    );

    const knowledgeIntakeUserOverridePatterns = this.resolveStringList(
      pluginConfig.knowledgeIntakeUserOverridePatterns,
      baseConfig.knowledgeIntakeUserOverridePatterns,
    );

    const sqliteJournalMode = this.resolveStringEnum(
      [
        pluginConfig.sqliteJournalMode,
        pluginConfig.runtimeSqliteJournalMode,
      ],
      ["delete", "wal"],
      baseConfig.sqliteJournalMode,
    ) as BridgeConfig["sqliteJournalMode"];

    return this.validateConfig({
      dataDir,
      sessionId: this.resolveSessionId(payload, baseConfig),
      agentId: this.resolveAgentId(payload, baseConfig),
      configPreset,
      workspaceDir,
      sharedDataDir,
      memoryVaultDir,
      knowledgeBaseDir,
      contextWindow: this.resolveConfiguredContextWindow(
        pluginConfig,
        payload,
        baseConfig,
      ),
      contextThreshold: this.resolveNumberConfig(
        [
          pluginConfig.contextThreshold,
          pluginConfig.compactionTriggerRatio,
        ],
        baseConfig.contextThreshold,
      ),
      freshTailTokens: this.resolveNumberConfig(
        [
          pluginConfig.freshTailTokens,
          pluginConfig.recentTailTurns,
        ],
        baseConfig.freshTailTokens,
      ),
      maxFreshTailTurns: this.resolveNumberConfig(
        [pluginConfig.maxFreshTailTurns],
        baseConfig.maxFreshTailTurns,
      ),
      compactionBatchTurns: this.resolveNumberConfig(
        [pluginConfig.compactionBatchTurns],
        baseConfig.compactionBatchTurns,
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
      summaryMaxOutputTokens: this.resolveNumberConfig(
        [pluginConfig.summaryMaxOutputTokens],
        baseConfig.summaryMaxOutputTokens,
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
      knowledgePromotionManualReviewEnabled,
      knowledgeIntakeMode,
      knowledgeIntakeAllowProjectState,
      knowledgeIntakeAllowBranchSummaries,
      knowledgeIntakeUserOverrideEnabled,
      knowledgeIntakeUserOverridePatterns,
      semanticCandidateExpansionEnabled: emergencyBrake
        ? false
        : this.resolveBooleanFlag(
            [
              pluginConfig.semanticCandidateExpansionEnabled,
              pluginConfig.enableSemanticCandidateExpansion,
              pluginConfig.semanticCandidatesEnabled,
            ],
            presetDefaults.semanticCandidateExpansionEnabled,
          ),
      semanticCandidateLimit: this.resolveNumberConfig(
        [
          pluginConfig.semanticCandidateLimit,
          pluginConfig.maxSemanticCandidates,
        ],
        presetDefaults.semanticCandidateLimit,
      ),
      emergencyBrake,
      sqliteJournalMode,
    });
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
    const api = this.getApi();
    const configCandidates = [
      api?.config,
      api?.context?.config,
      api?.runtime?.config,
    ].filter((config): config is NonNullable<typeof config> => isHostRecord(config));
    const modelRefs = [
      this.resolveModelRefCandidate(payload?.model),
      this.resolveModelRefCandidate(api?.context?.model),
      this.resolveModelRefCandidate(api?.runtime?.model),
      ...configCandidates.map((config) => {
        const primary = config?.agents?.defaults?.model?.primary;
        return typeof primary === "string" && primary.trim().length > 0
          ? primary.trim()
          : undefined;
      }),
    ].filter((value, index, list): value is string =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      list.indexOf(value) === index,
    );

    for (const modelRef of modelRefs) {
      for (const config of configCandidates) {
        const fromDeclaredModel = this.resolveDeclaredModelContextWindow(config, modelRef);
        if (fromDeclaredModel !== null) {
          return fromDeclaredModel;
        }

        const fromProviderModel = this.resolveProviderModelContextWindow(config, modelRef);
        if (fromProviderModel !== null) {
          return fromProviderModel;
        }
      }
    }

    return null;
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
    if (typeof config.summaryModel === "string" && config.summaryModel.trim()) {
      return config.summaryModel;
    }

    const payloadModel = this.resolveModelRefCandidate(payload?.model);
    if (payloadModel) {
      return payloadModel;
    }

    const contextModel = this.getApi()?.context?.model;
    const contextModelRef = this.resolveModelRefCandidate(contextModel);
    if (contextModelRef) {
      return contextModelRef;
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
      "dataDir" | "workspaceDir" | "sharedDataDir" | "knowledgeBaseDir" | "memoryVaultDir"
    >> = [
      "dataDir",
      "workspaceDir",
      "sharedDataDir",
      "knowledgeBaseDir",
      "memoryVaultDir",
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

  private readEnableToolsFromOpenClawConfig(): unknown {
    try {
      const configPath = getOpenClawConfigPath();
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      return parsed?.plugins?.entries?.chaunyoms?.config?.enableTools;
    } catch (error) {
      this.getLogger().warn("tool_config_file_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
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

