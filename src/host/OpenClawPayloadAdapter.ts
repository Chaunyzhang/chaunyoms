import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { BridgeConfig, ConfigPreset, LoggerLike, RawMessage } from "../types";
import { DEFAULT_BRIDGE_CONFIG } from "./OpenClawHostServices";
import { getOpenClawConfigPath, getOpenClawHomeDir } from "./HostPathResolver";
import { HostRecord, isHostRecord, OpenClawApiLike } from "./OpenClawHostTypes";
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
    const warnings: string[] = [];
    if (config.emergencyBrake) {
      warnings.push("Emergency brake is enabled; runtime capture, MemoryItem writes, auto recall, and knowledge promotion are forced off.");
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
    if (config.knowledgePromotionEnabled && !config.memoryItemEnabled) {
      warnings.push("Knowledge promotion is enabled while MemoryItem extraction is disabled; promotion inputs will be thinner than expected.");
    }
    if (config.knowledgePromotionEnabled && !config.knowledgePromotionManualReviewEnabled) {
      warnings.push("Knowledge promotion is automatic. Set knowledgePromotionManualReviewEnabled=true if you want a scored manual approval queue before Markdown writes.");
    }
    if ((config.retrievalStrength === "high" || config.retrievalStrength === "xhigh") && !config.autoRecallEnabled) {
      warnings.push(`${config.retrievalStrength} retrieval requires source recall, but autoRecallEnabled=false; exact evidence recall will be limited.`);
    }
    if (config.kbWriteEnabled && !config.kbExportEnabled) {
      warnings.push("kbWriteEnabled=true but kbExportEnabled=false; knowledge candidates can be written only after export is enabled.");
    }
    if (config.kbPromotionMode === "aggressive_auto") {
      warnings.push("kbPromotionMode=aggressive_auto is research-only; manual, assisted, or conservative_auto is safer for production knowledge-vault writes.");
    }
    if (config.openClawNativeMode !== "disabled") {
      warnings.push(`openClawNativeMode=${config.openClawNativeMode}; native OpenClaw outputs are non-authoritative unless they pass OMS validation/promotion.`);
    }
    if (config.graphEnabled && config.graphProvider === "none") {
      warnings.push("graphEnabled=true but graphProvider=none; graph enhancement will stay inactive.");
    }
    if (config.ragEnabled && config.ragProvider === "none") {
      warnings.push("ragEnabled=true but ragProvider=none; RAG enhancement will stay inactive.");
    }
    if (config.ragEnabled && config.ragProvider === "sqlite_vec" && !config.ragFallbackToBruteForce && !config.vectorExtensionPath) {
      warnings.push("ragProvider=sqlite_vec has no vectorExtensionPath and ragFallbackToBruteForce=false; vector search will be unavailable on hosts without a bundled extension.");
    }
    if (config.ragEnabled && !config.embeddingEnabled) {
      warnings.push("ragEnabled=true while embeddingEnabled=false; vector/RAG search will stay inactive because query embeddings are unavailable.");
    }
    if (config.graphEnabled && !config.graphBuilderEnabled) {
      warnings.push("graphEnabled=true while graphBuilderEnabled=false; existing graph edges can be read, but new associative edges will not be built.");
    }
    if (config.rerankEnabled && config.rerankProvider === "none") {
      warnings.push("rerankEnabled=true but rerankProvider=none; rerank enhancement will stay inactive.");
    }
    if (config.rerankEnabled && ["llm", "specialist", "model", "external"].includes(config.rerankProvider)) {
      warnings.push("rerankProvider is model/external; rerank will stay inactive unless a concrete runtime provider is wired. Deterministic fallback is never implicit.");
    }
    if (config.evidenceAnswerResolverEnabled && config.evidenceAnswerResolverProvider === "none") {
      warnings.push("evidenceAnswerResolverEnabled=true but evidenceAnswerResolverProvider=none; final evidence-to-answer resolution will stay inactive.");
    }
    if (config.evidenceAnswerResolverEnabled && ["llm", "external"].includes(config.evidenceAnswerResolverProvider) && !config.evidenceAnswerResolverModel) {
      warnings.push("EvidenceAnswerResolver uses an LLM/external provider without evidenceAnswerResolverModel; it will fail closed because model configuration is required.");
    }
    if (config.dagExpansionMode === "planner_decides" && config.dagExpansionAgentProvider === "none") {
      warnings.push("dagExpansionMode=planner_decides but dagExpansionAgentProvider=none; LLMPlanner can only choose deterministic DAG expansion.");
    }
    if (config.dagExpansionMode === "delegated_agent" && config.dagExpansionAgentProvider === "llm" && !config.dagExpansionAgentModel) {
      warnings.push("delegated DAG expansion uses llm provider without dagExpansionAgentModel; it will fail closed unless the host supplies a default model.");
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
        this.getApi()?.config?.plugins?.entries?.oms?.config ??
        this.getApi()?.context?.config?.plugins?.entries?.oms?.config ??
        this.getApi()?.runtime?.config?.plugins?.entries?.oms?.config ??
        this.getApi()?.config,
    ) ?? {};
    const baseConfig = currentConfig ?? DEFAULT_BRIDGE_CONFIG;
    const identityBaseConfig: BridgeConfig = {
      ...baseConfig,
      sessionId: this.resolveStringValue(pluginConfig.sessionId, baseConfig.sessionId),
      agentId: this.resolveStringValue(pluginConfig.agentId, baseConfig.agentId),
    };
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

    const memoryItemEnabled = emergencyBrake
      ? false
      : this.resolveBooleanFlag(
          [
            pluginConfig.memoryItemEnabled,
            this.inverseBoolean(pluginConfig.stopMemoryItemWrites),
            this.inverseBoolean(pluginConfig.pauseMemoryItems),
          ],
          baseConfig.memoryItemEnabled,
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

    const agentVaultMirrorEnabled = this.resolveBooleanFlag(
      [
        pluginConfig.agentVaultMirrorEnabled,
        pluginConfig.enableAgentVaultMirror,
        this.inverseBoolean(pluginConfig.disableAgentVaultMirror),
      ],
      baseConfig.agentVaultMirrorEnabled,
    );

    const summaryMarkdownMirrorEnabled = this.resolveBooleanFlag(
      [
        pluginConfig.summaryMarkdownMirrorEnabled,
        pluginConfig.enableSummaryMarkdownMirror,
        this.inverseBoolean(pluginConfig.disableSummaryMarkdownMirror),
      ],
      baseConfig.summaryMarkdownMirrorEnabled,
    );

    const memoryItemMarkdownMirrorEnabled = this.resolveBooleanFlag(
      [
        pluginConfig.memoryItemMarkdownMirrorEnabled,
        pluginConfig.enableMemoryItemMarkdownMirror,
        this.inverseBoolean(pluginConfig.disableMemoryItemMarkdownMirror),
      ],
      baseConfig.memoryItemMarkdownMirrorEnabled,
    );

    const transcriptMirrorEnabled = this.resolveBooleanFlag(
      [
        pluginConfig.transcriptMirrorEnabled,
        pluginConfig.enableTranscriptMirror,
        this.inverseBoolean(pluginConfig.disableTranscriptMirror),
      ],
      baseConfig.transcriptMirrorEnabled,
    );

    const knowledgeMarkdownEnabled = this.resolveBooleanFlag(
      [
        pluginConfig.knowledgeMarkdownEnabled,
        pluginConfig.enableKnowledgeMarkdown,
        this.inverseBoolean(pluginConfig.disableKnowledgeMarkdown),
      ],
      baseConfig.knowledgeMarkdownEnabled,
    );

    const retrievalStrength = this.resolveRetrievalStrengthValue(
      [
        pluginConfig.retrievalStrength,
        pluginConfig.retrievalMode,
        pluginConfig.recallStrength,
      ],
      baseConfig.retrievalStrength,
    );

    const llmPlannerMode = this.resolveStringEnum(
      [
        pluginConfig.llmPlannerMode,
        pluginConfig.plannerMode,
        pluginConfig.retrievalPlannerMode,
      ],
      ["off", "shadow", "auto"],
      baseConfig.llmPlannerMode,
    ) as BridgeConfig["llmPlannerMode"];

    const plannerDebugEnabled = this.resolveBooleanFlag(
      [
        pluginConfig.plannerDebugEnabled,
        pluginConfig.llmPlannerDebugEnabled,
        pluginConfig.enablePlannerDebug,
      ],
      baseConfig.plannerDebugEnabled,
    );

    const kbPromotionMode = this.resolveStringEnum(
      [
        pluginConfig.kbPromotionMode,
        pluginConfig.knowledgePromotionMode,
      ],
      ["manual", "assisted", "conservative_auto", "balanced_auto", "aggressive_auto"],
      baseConfig.kbPromotionMode,
    ) as BridgeConfig["kbPromotionMode"];

    const kbPromotionStrictness = this.resolveStringEnum(
      [
        pluginConfig.kbPromotionStrictness,
        pluginConfig.knowledgePromotionStrictness,
      ],
      ["low", "medium", "high"],
      baseConfig.kbPromotionStrictness,
    ) as BridgeConfig["kbPromotionStrictness"];

    const sqliteJournalMode = this.resolveStringEnum(
      [
        pluginConfig.sqliteJournalMode,
        pluginConfig.runtimeSqliteJournalMode,
      ],
      ["delete", "wal"],
      baseConfig.sqliteJournalMode,
    ) as BridgeConfig["sqliteJournalMode"];

    const usageFeedbackEnabled = emergencyBrake
      ? false
      : this.resolveBooleanFlag(
          [
            pluginConfig.usageFeedbackEnabled,
            pluginConfig.recallUsageFeedbackEnabled,
            this.inverseBoolean(pluginConfig.disableUsageFeedback),
          ],
          baseConfig.usageFeedbackEnabled,
        );

    const brainPackEnabled = this.resolveBooleanFlag(
      [
        pluginConfig.brainPackEnabled,
        pluginConfig.agentBrainPackEnabled,
        this.inverseBoolean(pluginConfig.disableBrainPack),
      ],
      baseConfig.brainPackEnabled,
    );
    const brainPackMode = this.resolveStringEnum(
      [pluginConfig.brainPackMode, pluginConfig.agentBrainPackMode],
      ["manual", "scheduled"],
      baseConfig.brainPackMode,
    ) as BridgeConfig["brainPackMode"];
    const brainPackOutputDir = this.resolveDirectoryValue(
      pluginConfig.brainPackOutputDir,
      pluginConfig.agentBrainPackDir,
      pluginConfig.brainpackOutputDir,
      baseConfig.brainPackOutputDir || path.join(workspaceDir, "agent-brainpack"),
    );
    const brainPackRedactionMode = this.resolveStringEnum(
      [pluginConfig.brainPackRedactionMode, pluginConfig.redactionMode],
      ["strict", "redact", "report_only"],
      baseConfig.brainPackRedactionMode,
    ) as BridgeConfig["brainPackRedactionMode"];
    const brainPackIncludeRawTranscript = this.resolveStringEnum(
      [pluginConfig.brainPackIncludeRawTranscript, pluginConfig.includeRawTranscript],
      ["never", "redacted_excerpt", "private_archive_only"],
      baseConfig.brainPackIncludeRawTranscript,
    ) as BridgeConfig["brainPackIncludeRawTranscript"];
    const brainPackIncludeToolOutputs = this.resolveStringEnum(
      [pluginConfig.brainPackIncludeToolOutputs, pluginConfig.includeToolOutputs],
      ["never", "redacted_excerpt", "private_archive_only"],
      baseConfig.brainPackIncludeToolOutputs,
    ) as BridgeConfig["brainPackIncludeToolOutputs"];

    const openClawNativeMode = this.resolveStringEnum(
      [pluginConfig.openClawNativeMode, pluginConfig.nativeMemoryMode, pluginConfig.openclawNativeMode],
      ["disabled", "coexist", "absorbed"],
      baseConfig.openClawNativeMode,
    ) as BridgeConfig["openClawNativeMode"];
    const graphEnabled = this.resolveBooleanFlag(
      [pluginConfig.graphEnabled, pluginConfig.retrievalGraphEnabled, this.inverseBoolean(pluginConfig.disableGraph)],
      baseConfig.graphEnabled,
    );
    const ragEnabled = this.resolveBooleanFlag(
      [pluginConfig.ragEnabled, pluginConfig.retrievalRagEnabled, this.inverseBoolean(pluginConfig.disableRag)],
      baseConfig.ragEnabled,
    );
    const rerankEnabled = this.resolveBooleanFlag(
      [pluginConfig.rerankEnabled, pluginConfig.retrievalRerankEnabled, this.inverseBoolean(pluginConfig.disableRerank)],
      baseConfig.rerankEnabled,
    );
    const heavyRetrievalPolicy = this.resolveStringEnum(
      [pluginConfig.heavyRetrievalPolicy],
      ["disabled", "planner_only"],
      baseConfig.heavyRetrievalPolicy,
    ) as BridgeConfig["heavyRetrievalPolicy"];
    const ragPlannerPolicy = this.resolveStringEnum(
      [pluginConfig.ragPlannerPolicy, pluginConfig.ragRetrievalPolicy],
      ["disabled", "planner_only"],
      baseConfig.ragPlannerPolicy,
    ) as BridgeConfig["ragPlannerPolicy"];
    const graphPlannerPolicy = this.resolveStringEnum(
      [pluginConfig.graphPlannerPolicy, pluginConfig.graphRetrievalPolicy],
      ["disabled", "planner_only"],
      baseConfig.graphPlannerPolicy,
    ) as BridgeConfig["graphPlannerPolicy"];
    const rerankPlannerPolicy = this.resolveStringEnum(
      [pluginConfig.rerankPlannerPolicy, pluginConfig.rerankRetrievalPolicy],
      ["disabled", "planner_only", "candidate_overload_required"],
      baseConfig.rerankPlannerPolicy,
    ) as BridgeConfig["rerankPlannerPolicy"];
    const embeddingEnabled = emergencyBrake
      ? false
      : this.resolveBooleanFlag(
          [
            pluginConfig.embeddingEnabled,
            pluginConfig.retrievalEmbeddingEnabled,
            this.inverseBoolean(pluginConfig.disableEmbedding),
          ],
          baseConfig.embeddingEnabled,
        );
    const graphBuilderEnabled = emergencyBrake
      ? false
      : this.resolveBooleanFlag(
          [
            pluginConfig.graphBuilderEnabled,
            pluginConfig.retrievalGraphBuilderEnabled,
            this.inverseBoolean(pluginConfig.disableGraphBuilder),
          ],
          baseConfig.graphBuilderEnabled,
        );
    const evidenceAnswerResolverEnabled = emergencyBrake
      ? false
      : this.resolveBooleanFlag(
          [
            pluginConfig.evidenceAnswerResolverEnabled,
            pluginConfig.answerResolverEnabled,
            this.inverseBoolean(pluginConfig.disableEvidenceAnswerResolver),
          ],
          baseConfig.evidenceAnswerResolverEnabled,
        );
    const dagExpansionMode = emergencyBrake
      ? "deterministic"
      : this.resolveStringEnum(
          [pluginConfig.dagExpansionMode, pluginConfig.sourceExpansionMode, pluginConfig.summaryExpansionMode],
          ["deterministic", "planner_decides", "delegated_agent"],
          baseConfig.dagExpansionMode,
        ) as BridgeConfig["dagExpansionMode"];
    const dagExpansionAgentProvider = emergencyBrake
      ? "none"
      : this.resolveStringEnum(
          [pluginConfig.dagExpansionAgentProvider, pluginConfig.sourceExpansionAgentProvider],
          ["none", "host_subagent", "llm"],
          baseConfig.dagExpansionAgentProvider,
        ) as BridgeConfig["dagExpansionAgentProvider"];

    return this.validateConfig(this.applyRetrievalStrengthPreset({
      dataDir,
      sessionId: this.resolveSessionId(payload, identityBaseConfig),
      agentId: this.resolveAgentId(payload, identityBaseConfig),
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
      memoryItemEnabled,
      autoRecallEnabled,
      agentVaultMirrorEnabled,
      summaryMarkdownMirrorEnabled,
      memoryItemMarkdownMirrorEnabled,
      transcriptMirrorEnabled,
      knowledgeMarkdownEnabled,
      retrievalStrength,
      llmPlannerMode,
      plannerDebugEnabled,
      llmPlannerModel:
        typeof pluginConfig.llmPlannerModel === "string" &&
        pluginConfig.llmPlannerModel.trim().length > 0
          ? pluginConfig.llmPlannerModel
          : typeof pluginConfig.plannerModel === "string" &&
              pluginConfig.plannerModel.trim().length > 0
            ? pluginConfig.plannerModel
            : baseConfig.llmPlannerModel,
      knowledgePromotionEnabled,
      knowledgePromotionManualReviewEnabled,
      knowledgeIntakeMode,
      kbCandidateEnabled: this.resolveBooleanFlag(
        [
          pluginConfig.kbCandidateEnabled,
          pluginConfig.knowledgeCandidateEnabled,
          this.inverseBoolean(pluginConfig.disableKbCandidates),
        ],
        baseConfig.kbCandidateEnabled,
      ),
      kbWriteEnabled: this.resolveBooleanFlag(
        [
          pluginConfig.kbWriteEnabled,
          pluginConfig.knowledgeWriteEnabled,
          pluginConfig.knowledgePromotionEnabled,
          this.inverseBoolean(pluginConfig.disableKbWrites),
        ],
        baseConfig.kbWriteEnabled,
      ),
      kbPromotionMode,
      kbPromotionStrictness,
      kbExportEnabled: this.resolveBooleanFlag(
        [
          pluginConfig.kbExportEnabled,
          pluginConfig.knowledgeExportEnabled,
          this.inverseBoolean(pluginConfig.disableKbExport),
        ],
        baseConfig.kbExportEnabled,
      ),
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
      usageFeedbackEnabled,
      brainPackEnabled,
      brainPackMode,
      brainPackTurnInterval: this.resolveNumberConfig(
        [pluginConfig.brainPackTurnInterval, pluginConfig.brainPackConversationTurnInterval],
        baseConfig.brainPackTurnInterval,
      ),
      brainPackIntervalHours: this.resolveNumberConfig(
        [pluginConfig.brainPackIntervalHours, pluginConfig.brainPackSnapshotIntervalHours],
        baseConfig.brainPackIntervalHours,
      ),
      brainPackOutputDir,
      brainPackGitEnabled: this.resolveBooleanFlag(
        [pluginConfig.brainPackGitEnabled, pluginConfig.brainPackAutoGitEnabled],
        baseConfig.brainPackGitEnabled,
      ),
      brainPackGitRemote: this.resolveOptionalString(pluginConfig.brainPackGitRemote, baseConfig.brainPackGitRemote),
      brainPackGitBranch: this.resolveOptionalString(pluginConfig.brainPackGitBranch, baseConfig.brainPackGitBranch),
      brainPackCommitMessageTemplate: this.resolveOptionalString(
        pluginConfig.brainPackCommitMessageTemplate,
        baseConfig.brainPackCommitMessageTemplate,
      ),
      brainPackRedactionMode,
      brainPackIncludeRawTranscript,
      brainPackIncludeToolOutputs,
      brainPackDeterministicOrdering: this.resolveBooleanFlag(
        [pluginConfig.brainPackDeterministicOrdering, pluginConfig.deterministicBrainPackOrdering],
        baseConfig.brainPackDeterministicOrdering,
      ),
      openClawNativeMode,
      openClawNativeMemoryCoreMode: this.resolveOptionalStringEnum(
        [pluginConfig.openClawNativeMemoryCoreMode, pluginConfig.memoryCoreNativeMode],
        ["disabled", "coexist", "absorbed"],
        baseConfig.openClawNativeMemoryCoreMode,
      ) as BridgeConfig["openClawNativeMemoryCoreMode"],
      openClawNativeActiveMemoryMode: this.resolveOptionalStringEnum(
        [pluginConfig.openClawNativeActiveMemoryMode, pluginConfig.activeMemoryNativeMode],
        ["disabled", "coexist", "absorbed"],
        baseConfig.openClawNativeActiveMemoryMode,
      ) as BridgeConfig["openClawNativeActiveMemoryMode"],
      openClawNativeMemoryWikiMode: this.resolveOptionalStringEnum(
        [pluginConfig.openClawNativeMemoryWikiMode, pluginConfig.memoryWikiNativeMode],
        ["disabled", "coexist", "absorbed"],
        baseConfig.openClawNativeMemoryWikiMode,
      ) as BridgeConfig["openClawNativeMemoryWikiMode"],
      openClawNativeDreamingMode: this.resolveOptionalStringEnum(
        [pluginConfig.openClawNativeDreamingMode, pluginConfig.dreamingNativeMode],
        ["disabled", "coexist", "absorbed"],
        baseConfig.openClawNativeDreamingMode,
      ) as BridgeConfig["openClawNativeDreamingMode"],
      graphEnabled,
      ragEnabled,
      rerankEnabled,
      graphProvider: this.resolveStringEnum(
        [pluginConfig.graphProvider, pluginConfig.retrievalGraphProvider],
        ["none", "sqlite_graph", "sqlite_edges", "external"],
        baseConfig.graphProvider,
      ) as BridgeConfig["graphProvider"],
      ragProvider: this.resolveStringEnum(
        [pluginConfig.ragProvider, pluginConfig.retrievalRagProvider],
        ["none", "sqlite_vec", "brute_force", "embedding", "external"],
        baseConfig.ragProvider,
      ) as BridgeConfig["ragProvider"],
      rerankProvider: this.resolveStringEnum(
        [pluginConfig.rerankProvider, pluginConfig.retrievalRerankProvider],
        ["none", "deterministic", "llm", "specialist", "model", "external"],
        baseConfig.rerankProvider,
      ) as BridgeConfig["rerankProvider"],
      embeddingEnabled,
      embeddingProvider: this.resolveStringEnum(
        [pluginConfig.embeddingProvider, pluginConfig.retrievalEmbeddingProvider],
        ["none", "local_hash", "external"],
        baseConfig.embeddingProvider,
      ) as BridgeConfig["embeddingProvider"],
      embeddingModel: this.resolveOptionalString(
        pluginConfig.embeddingModel,
        baseConfig.embeddingModel,
      ) ?? baseConfig.embeddingModel,
      embeddingDimensions: this.resolveNumberConfig(
        [pluginConfig.embeddingDimensions, pluginConfig.vectorDimensions],
        baseConfig.embeddingDimensions,
      ),
      embeddingAsync: this.resolveBooleanFlag(
        [pluginConfig.embeddingAsync, pluginConfig.embeddingJobsAsync],
        baseConfig.embeddingAsync,
      ),
      embeddingJobMaxBatch: this.resolveNumberConfig(
        [pluginConfig.embeddingJobMaxBatch, pluginConfig.embeddingBatchSize],
        baseConfig.embeddingJobMaxBatch,
      ),
      embeddingJobMaxRetries: this.resolveNumberConfig(
        [pluginConfig.embeddingJobMaxRetries, pluginConfig.embeddingMaxRetries],
        baseConfig.embeddingJobMaxRetries,
      ),
      vectorExtensionPath: this.resolveOptionalString(
        pluginConfig.vectorExtensionPath,
        baseConfig.vectorExtensionPath,
      ),
      vectorExtensionEntryPoint: this.resolveOptionalString(
        pluginConfig.vectorExtensionEntryPoint,
        baseConfig.vectorExtensionEntryPoint,
      ),
      vectorSearchMaxCandidates: this.resolveNumberConfig(
        [pluginConfig.vectorSearchMaxCandidates, pluginConfig.ragVectorCandidateLimit],
        baseConfig.vectorSearchMaxCandidates,
      ),
      bruteForceVectorMaxRows: this.resolveNumberConfig(
        [pluginConfig.bruteForceVectorMaxRows, pluginConfig.ragBruteForceMaxRows],
        baseConfig.bruteForceVectorMaxRows,
      ),
      ragFallbackToBruteForce: this.resolveBooleanFlag(
        [pluginConfig.ragFallbackToBruteForce, pluginConfig.vectorFallbackToBruteForce],
        baseConfig.ragFallbackToBruteForce,
      ),
      graphBuilderEnabled,
      graphBuilderProvider: this.resolveStringEnum(
        [pluginConfig.graphBuilderProvider, pluginConfig.retrievalGraphBuilderProvider],
        ["none", "deterministic", "llm", "external"],
        baseConfig.graphBuilderProvider,
      ) as BridgeConfig["graphBuilderProvider"],
      graphMaxDepth: this.resolveNumberConfig(
        [pluginConfig.graphMaxDepth],
        baseConfig.graphMaxDepth,
      ),
      graphMaxFanout: this.resolveNumberConfig(
        [pluginConfig.graphMaxFanout],
        baseConfig.graphMaxFanout,
      ),
      graphMinConfidence: this.resolveNumberConfig(
        [pluginConfig.graphMinConfidence],
        baseConfig.graphMinConfidence,
      ),
      graphAllowedRelations: this.resolveStringList(
        pluginConfig.graphAllowedRelations,
        baseConfig.graphAllowedRelations,
      ),
      graphCandidateLimit: this.resolveNumberConfig(
        [pluginConfig.graphCandidateLimit, pluginConfig.graphMaxCandidates],
        baseConfig.graphCandidateLimit,
      ),
      rerankModel: this.resolveOptionalString(pluginConfig.rerankModel, baseConfig.rerankModel),
      rerankTimeoutMs: this.resolveNumberConfig(
        [pluginConfig.rerankTimeoutMs, pluginConfig.rerankMaxLatencyMs],
        baseConfig.rerankTimeoutMs,
      ),
      rerankFallbackToDeterministic: this.resolveBooleanFlag(
        [pluginConfig.rerankFallbackToDeterministic],
        baseConfig.rerankFallbackToDeterministic,
      ),
      evidenceAnswerResolverEnabled,
      evidenceAnswerResolverProvider: this.resolveStringEnum(
        [pluginConfig.evidenceAnswerResolverProvider, pluginConfig.answerResolverProvider],
        ["none", "deterministic", "llm", "external"],
        baseConfig.evidenceAnswerResolverProvider,
      ) as BridgeConfig["evidenceAnswerResolverProvider"],
      evidenceAnswerResolverModel: this.resolveOptionalString(
        pluginConfig.evidenceAnswerResolverModel,
        baseConfig.evidenceAnswerResolverModel,
      ),
      evidenceAnswerResolverTimeoutMs: this.resolveNumberConfig(
        [pluginConfig.evidenceAnswerResolverTimeoutMs, pluginConfig.answerResolverTimeoutMs],
        baseConfig.evidenceAnswerResolverTimeoutMs,
      ),
      evidenceAnswerResolverFallbackToDeterministic: this.resolveBooleanFlag(
        [pluginConfig.evidenceAnswerResolverFallbackToDeterministic],
        baseConfig.evidenceAnswerResolverFallbackToDeterministic,
      ),
      dagExpansionMode,
      dagExpansionAgentProvider,
      dagExpansionAgentModel: this.resolveOptionalString(
        pluginConfig.dagExpansionAgentModel,
        baseConfig.dagExpansionAgentModel,
      ),
      dagExpansionAgentTimeoutMs: this.resolveNumberConfig(
        [pluginConfig.dagExpansionAgentTimeoutMs, pluginConfig.sourceExpansionAgentTimeoutMs],
        baseConfig.dagExpansionAgentTimeoutMs,
      ),
      featureIsolationMode: this.resolveStringEnum(
        [pluginConfig.featureIsolationMode, pluginConfig.optionalFeatureIsolationMode],
        ["fail_closed", "isolate_optional"],
        baseConfig.featureIsolationMode,
      ) as BridgeConfig["featureIsolationMode"],
      heavyRetrievalPolicy,
      ragPlannerPolicy,
      graphPlannerPolicy,
      rerankPlannerPolicy,
      candidateRerankThreshold: this.resolveNumberConfig(
        [pluginConfig.candidateRerankThreshold, pluginConfig.rerankCandidateThreshold],
        baseConfig.candidateRerankThreshold,
      ),
      laneCandidateRerankThreshold: this.resolveNumberConfig(
        [pluginConfig.laneCandidateRerankThreshold, pluginConfig.rerankLaneCandidateThreshold],
        baseConfig.laneCandidateRerankThreshold,
      ),
      candidateAmbiguityMargin: this.resolveNumberConfig(
        [pluginConfig.candidateAmbiguityMargin, pluginConfig.rerankAmbiguityMargin],
        baseConfig.candidateAmbiguityMargin,
      ),
      strictModeRequiresRerankOnConflict: this.resolveBooleanFlag(
        [pluginConfig.strictModeRequiresRerankOnConflict, pluginConfig.strictRerankOnConflict],
        baseConfig.strictModeRequiresRerankOnConflict,
      ),
      maxEnhancementLatencyMs: this.resolveNumberConfig(
        [pluginConfig.maxEnhancementLatencyMs, pluginConfig.retrievalEnhancementMaxLatencyMs],
        baseConfig.maxEnhancementLatencyMs,
      ),
      maxRerankCandidates: this.resolveNumberConfig(
        [pluginConfig.maxRerankCandidates, pluginConfig.rerankCandidateLimit],
        baseConfig.maxRerankCandidates,
      ),
      emergencyBrake,
      sqliteJournalMode,
    }));
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

  private readEnableToolsFromOpenClawConfig(): unknown {
    try {
      const configPath = getOpenClawConfigPath();
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      return parsed?.plugins?.entries?.oms?.config?.enableTools;
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
