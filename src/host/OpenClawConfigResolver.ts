import path from "node:path";

import type { BridgeConfig, ConfigPreset } from "../types";
import type { OpenClawPayloadLike } from "./OpenClawPayloadContracts";

export interface OpenClawConfigResolverDeps {
  applyRetrievalStrengthPreset: (config: BridgeConfig) => BridgeConfig;
  buildDataDir: (sharedDataDir: string) => string;
  buildKnowledgeBaseDir: (sharedDataDir: string) => string;
  buildMemoryVaultDir: (sharedDataDir: string) => string;
  firstRecordCandidate: (...candidates: unknown[]) => Record<string, unknown> | null;
  hasDirectoryValue: (value: unknown) => value is string;
  inverseBoolean: (value: unknown) => boolean | undefined;
  resolveAgentId: (payload: OpenClawPayloadLike, currentConfig: BridgeConfig) => string;
  resolveBooleanFlag: (candidates: unknown[], fallback: boolean) => boolean;
  resolveConfiguredContextWindow: (
    pluginConfig: Record<string, unknown>,
    payload: OpenClawPayloadLike,
    baseConfig: BridgeConfig,
  ) => number;
  resolveDirectoryValue: (...values: unknown[]) => string;
  resolveNumberConfig: (candidates: unknown[], fallback: number) => number;
  resolveOptionalString: (value: unknown, fallback?: string) => string | undefined;
  resolveOptionalStringEnum: (
    candidates: unknown[],
    allowed: string[],
    fallback?: string,
  ) => string | undefined;
  resolvePresetDefaults: (
    configPreset: ConfigPreset,
    baseConfig: BridgeConfig,
  ) => Pick<
    BridgeConfig,
    "autoRecallEnabled" | "semanticCandidateExpansionEnabled" | "semanticCandidateLimit"
  >;
  resolveRetrievalStrengthValue: (
    candidates: unknown[],
    fallback: BridgeConfig["retrievalStrength"],
  ) => BridgeConfig["retrievalStrength"];
  resolvePluginConfig: (payload: OpenClawPayloadLike) => Record<string, unknown>;
  resolveSessionId: (payload: OpenClawPayloadLike, currentConfig: BridgeConfig) => string;
  resolveStringEnum: (candidates: unknown[], allowed: string[], fallback: string) => string;
  resolveStringList: (value: unknown, fallback: string[]) => string[];
  resolveStringValue: (value: unknown, fallback: string) => string;
  validateConfig: (config: BridgeConfig) => BridgeConfig;
}

export class OpenClawConfigResolver {
  constructor(private readonly deps: OpenClawConfigResolverDeps) {}

  resolve(
    payload: OpenClawPayloadLike,
    currentConfig: BridgeConfig,
  ): BridgeConfig {
    const pluginConfig = this.deps.resolvePluginConfig(payload);
    const baseConfig = currentConfig;
    const identityBaseConfig: BridgeConfig = {
      ...baseConfig,
      sessionId: this.deps.resolveStringValue(pluginConfig.sessionId, baseConfig.sessionId),
      agentId: this.deps.resolveStringValue(pluginConfig.agentId, baseConfig.agentId),
    };
    const configPreset = this.deps.resolveStringEnum(
      [pluginConfig.configPreset, pluginConfig.preset],
      ["safe", "balanced", "enhanced_recall"],
      baseConfig.configPreset,
    ) as ConfigPreset;
    const presetDefaults = this.deps.resolvePresetDefaults(configPreset, baseConfig);
    const sharedDataDir = this.deps.resolveDirectoryValue(
      pluginConfig.sharedDataDir,
      baseConfig.sharedDataDir,
    );
    const workspaceDir = this.deps.resolveDirectoryValue(
      pluginConfig.workspaceDir,
      baseConfig.workspaceDir,
    );
    const hasExplicitSharedDataDir = this.deps.hasDirectoryValue(pluginConfig.sharedDataDir);
    const dataDir = this.deps.resolveDirectoryValue(
      pluginConfig.dataDir,
      hasExplicitSharedDataDir
        ? this.deps.buildDataDir(sharedDataDir)
        : baseConfig.dataDir,
    );
    const knowledgeBaseDir = this.deps.resolveDirectoryValue(
      pluginConfig.knowledgeBaseDir,
      pluginConfig.knowledgeDir,
      hasExplicitSharedDataDir
        ? this.deps.buildKnowledgeBaseDir(sharedDataDir)
        : baseConfig.knowledgeBaseDir,
    );
    const memoryVaultDir = this.deps.resolveDirectoryValue(
      pluginConfig.memoryVaultDir,
      hasExplicitSharedDataDir
        ? this.deps.buildMemoryVaultDir(sharedDataDir)
        : baseConfig.memoryVaultDir,
    );

    const emergencyBrake = this.deps.resolveBooleanFlag(
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
      : this.deps.resolveBooleanFlag(
          [
            pluginConfig.runtimeCaptureEnabled,
            this.deps.inverseBoolean(pluginConfig.pauseRuntimeCapture),
            this.deps.inverseBoolean(pluginConfig.stopRuntimeCapture),
          ],
          baseConfig.runtimeCaptureEnabled,
        );

    const memoryItemEnabled = emergencyBrake
      ? false
      : this.deps.resolveBooleanFlag(
          [
            pluginConfig.memoryItemEnabled,
            this.deps.inverseBoolean(pluginConfig.stopMemoryItemWrites),
            this.deps.inverseBoolean(pluginConfig.pauseMemoryItems),
          ],
          baseConfig.memoryItemEnabled,
        );

    const autoRecallEnabled = emergencyBrake
      ? false
      : this.deps.resolveBooleanFlag(
          [
            pluginConfig.autoRecallEnabled,
            this.deps.inverseBoolean(pluginConfig.disableAutoRecall),
            this.deps.inverseBoolean(pluginConfig.stopAutoRecall),
          ],
          presetDefaults.autoRecallEnabled,
        );

    const knowledgePromotionEnabled = emergencyBrake
      ? false
      : this.deps.resolveBooleanFlag(
          [
            pluginConfig.knowledgePromotionEnabled,
            this.deps.inverseBoolean(pluginConfig.disableKnowledgePromotion),
            this.deps.inverseBoolean(pluginConfig.stopKnowledgePromotion),
          ],
          baseConfig.knowledgePromotionEnabled,
        );

    const knowledgePromotionManualReviewEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.knowledgePromotionManualReviewEnabled,
        pluginConfig.knowledgeManualReviewEnabled,
        pluginConfig.manualKnowledgeReview,
      ],
      baseConfig.knowledgePromotionManualReviewEnabled,
    );

    const knowledgeIntakeMode = this.deps.resolveStringEnum(
      [pluginConfig.knowledgeIntakeMode, pluginConfig.knowledgeIntakePolicy],
      ["conservative", "balanced", "aggressive"],
      baseConfig.knowledgeIntakeMode,
    ) as BridgeConfig["knowledgeIntakeMode"];

    const knowledgeIntakeAllowProjectState = this.deps.resolveBooleanFlag(
      [
        pluginConfig.knowledgeIntakeAllowProjectState,
        pluginConfig.allowProjectStateKnowledge,
      ],
      baseConfig.knowledgeIntakeAllowProjectState,
    );

    const knowledgeIntakeAllowBranchSummaries = this.deps.resolveBooleanFlag(
      [
        pluginConfig.knowledgeIntakeAllowBranchSummaries,
        pluginConfig.allowBranchSummaryKnowledge,
      ],
      baseConfig.knowledgeIntakeAllowBranchSummaries,
    );

    const knowledgeIntakeUserOverrideEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.knowledgeIntakeUserOverrideEnabled,
        pluginConfig.knowledgeUserOverrideEnabled,
      ],
      baseConfig.knowledgeIntakeUserOverrideEnabled,
    );

    const knowledgeIntakeUserOverridePatterns = this.deps.resolveStringList(
      pluginConfig.knowledgeIntakeUserOverridePatterns,
      baseConfig.knowledgeIntakeUserOverridePatterns,
    );

    const agentVaultMirrorEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.agentVaultMirrorEnabled,
        pluginConfig.enableAgentVaultMirror,
        this.deps.inverseBoolean(pluginConfig.disableAgentVaultMirror),
      ],
      baseConfig.agentVaultMirrorEnabled,
    );

    const summaryMarkdownMirrorEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.summaryMarkdownMirrorEnabled,
        pluginConfig.enableSummaryMarkdownMirror,
        this.deps.inverseBoolean(pluginConfig.disableSummaryMarkdownMirror),
      ],
      baseConfig.summaryMarkdownMirrorEnabled,
    );

    const memoryItemMarkdownMirrorEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.memoryItemMarkdownMirrorEnabled,
        pluginConfig.enableMemoryItemMarkdownMirror,
        this.deps.inverseBoolean(pluginConfig.disableMemoryItemMarkdownMirror),
      ],
      baseConfig.memoryItemMarkdownMirrorEnabled,
    );

    const transcriptMirrorEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.transcriptMirrorEnabled,
        pluginConfig.enableTranscriptMirror,
        this.deps.inverseBoolean(pluginConfig.disableTranscriptMirror),
      ],
      baseConfig.transcriptMirrorEnabled,
    );

    const knowledgeMarkdownEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.knowledgeMarkdownEnabled,
        pluginConfig.enableKnowledgeMarkdown,
        this.deps.inverseBoolean(pluginConfig.disableKnowledgeMarkdown),
      ],
      baseConfig.knowledgeMarkdownEnabled,
    );

    const retrievalStrength = this.deps.resolveRetrievalStrengthValue(
      [
        pluginConfig.retrievalStrength,
        pluginConfig.retrievalMode,
        pluginConfig.recallStrength,
      ],
      baseConfig.retrievalStrength,
    );

    const llmPlannerMode = this.deps.resolveStringEnum(
      [
        pluginConfig.llmPlannerMode,
        pluginConfig.plannerMode,
        pluginConfig.retrievalPlannerMode,
      ],
      ["off", "shadow", "auto"],
      baseConfig.llmPlannerMode,
    ) as BridgeConfig["llmPlannerMode"];

    const plannerDebugEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.plannerDebugEnabled,
        pluginConfig.llmPlannerDebugEnabled,
        pluginConfig.enablePlannerDebug,
      ],
      baseConfig.plannerDebugEnabled,
    );

    const kbPromotionMode = this.deps.resolveStringEnum(
      [pluginConfig.kbPromotionMode, pluginConfig.knowledgePromotionMode],
      ["manual", "assisted", "conservative_auto", "balanced_auto", "aggressive_auto"],
      baseConfig.kbPromotionMode,
    ) as BridgeConfig["kbPromotionMode"];

    const kbPromotionStrictness = this.deps.resolveStringEnum(
      [pluginConfig.kbPromotionStrictness, pluginConfig.knowledgePromotionStrictness],
      ["low", "medium", "high"],
      baseConfig.kbPromotionStrictness,
    ) as BridgeConfig["kbPromotionStrictness"];

    const sqliteJournalMode = this.deps.resolveStringEnum(
      [pluginConfig.sqliteJournalMode, pluginConfig.runtimeSqliteJournalMode],
      ["delete", "wal"],
      baseConfig.sqliteJournalMode,
    ) as BridgeConfig["sqliteJournalMode"];

    const openClawRuntimeProfile = this.deps.resolveStringEnum(
      [pluginConfig.openClawRuntimeProfile, pluginConfig.runtimeProfile],
      ["standard", "lightweight"],
      baseConfig.openClawRuntimeProfile,
    ) as BridgeConfig["openClawRuntimeProfile"];

    const usageFeedbackEnabled = emergencyBrake
      ? false
      : this.deps.resolveBooleanFlag(
          [
            pluginConfig.usageFeedbackEnabled,
            pluginConfig.recallUsageFeedbackEnabled,
            this.deps.inverseBoolean(pluginConfig.disableUsageFeedback),
          ],
          baseConfig.usageFeedbackEnabled,
        );

    const brainPackEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.brainPackEnabled,
        pluginConfig.agentBrainPackEnabled,
        this.deps.inverseBoolean(pluginConfig.disableBrainPack),
      ],
      baseConfig.brainPackEnabled,
    );
    const brainPackMode = this.deps.resolveStringEnum(
      [pluginConfig.brainPackMode, pluginConfig.agentBrainPackMode],
      ["manual", "scheduled"],
      baseConfig.brainPackMode,
    ) as BridgeConfig["brainPackMode"];
    const brainPackOutputDir = this.deps.resolveDirectoryValue(
      pluginConfig.brainPackOutputDir,
      pluginConfig.agentBrainPackDir,
      pluginConfig.brainpackOutputDir,
      baseConfig.brainPackOutputDir || path.join(workspaceDir, "agent-brainpack"),
    );
    const brainPackRedactionMode = this.deps.resolveStringEnum(
      [pluginConfig.brainPackRedactionMode, pluginConfig.redactionMode],
      ["strict", "redact", "report_only"],
      baseConfig.brainPackRedactionMode,
    ) as BridgeConfig["brainPackRedactionMode"];
    const brainPackIncludeRawTranscript = this.deps.resolveStringEnum(
      [pluginConfig.brainPackIncludeRawTranscript, pluginConfig.includeRawTranscript],
      ["never", "redacted_excerpt", "private_archive_only"],
      baseConfig.brainPackIncludeRawTranscript,
    ) as BridgeConfig["brainPackIncludeRawTranscript"];
    const brainPackIncludeToolOutputs = this.deps.resolveStringEnum(
      [pluginConfig.brainPackIncludeToolOutputs, pluginConfig.includeToolOutputs],
      ["never", "redacted_excerpt", "private_archive_only"],
      baseConfig.brainPackIncludeToolOutputs,
    ) as BridgeConfig["brainPackIncludeToolOutputs"];

    const openClawNativeMode = this.deps.resolveStringEnum(
      [
        pluginConfig.openClawNativeMode,
        pluginConfig.nativeMemoryMode,
        pluginConfig.openclawNativeMode,
      ],
      ["disabled", "coexist", "absorbed"],
      baseConfig.openClawNativeMode,
    ) as BridgeConfig["openClawNativeMode"];
    const graphEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.graphEnabled,
        pluginConfig.retrievalGraphEnabled,
        this.deps.inverseBoolean(pluginConfig.disableGraph),
      ],
      baseConfig.graphEnabled,
    );
    const ragEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.ragEnabled,
        pluginConfig.retrievalRagEnabled,
        this.deps.inverseBoolean(pluginConfig.disableRag),
      ],
      baseConfig.ragEnabled,
    );
    const rerankEnabled = this.deps.resolveBooleanFlag(
      [
        pluginConfig.rerankEnabled,
        pluginConfig.retrievalRerankEnabled,
        this.deps.inverseBoolean(pluginConfig.disableRerank),
      ],
      baseConfig.rerankEnabled,
    );
    const heavyRetrievalPolicy = this.deps.resolveStringEnum(
      [pluginConfig.heavyRetrievalPolicy],
      ["disabled", "planner_only"],
      baseConfig.heavyRetrievalPolicy,
    ) as BridgeConfig["heavyRetrievalPolicy"];
    const ragPlannerPolicy = this.deps.resolveStringEnum(
      [pluginConfig.ragPlannerPolicy, pluginConfig.ragRetrievalPolicy],
      ["disabled", "planner_only"],
      baseConfig.ragPlannerPolicy,
    ) as BridgeConfig["ragPlannerPolicy"];
    const graphPlannerPolicy = this.deps.resolveStringEnum(
      [pluginConfig.graphPlannerPolicy, pluginConfig.graphRetrievalPolicy],
      ["disabled", "planner_only"],
      baseConfig.graphPlannerPolicy,
    ) as BridgeConfig["graphPlannerPolicy"];
    const rerankPlannerPolicy = this.deps.resolveStringEnum(
      [pluginConfig.rerankPlannerPolicy, pluginConfig.rerankRetrievalPolicy],
      ["disabled", "planner_only", "candidate_overload_required"],
      baseConfig.rerankPlannerPolicy,
    ) as BridgeConfig["rerankPlannerPolicy"];
    const embeddingEnabled = emergencyBrake
      ? false
      : this.deps.resolveBooleanFlag(
          [
            pluginConfig.embeddingEnabled,
            pluginConfig.retrievalEmbeddingEnabled,
            this.deps.inverseBoolean(pluginConfig.disableEmbedding),
          ],
          baseConfig.embeddingEnabled,
        );
    const graphBuilderEnabled = emergencyBrake
      ? false
      : this.deps.resolveBooleanFlag(
          [
            pluginConfig.graphBuilderEnabled,
            pluginConfig.retrievalGraphBuilderEnabled,
            this.deps.inverseBoolean(pluginConfig.disableGraphBuilder),
          ],
          baseConfig.graphBuilderEnabled,
        );
    const evidenceAnswerResolverEnabled = emergencyBrake
      ? false
      : this.deps.resolveBooleanFlag(
          [
            pluginConfig.evidenceAnswerResolverEnabled,
            pluginConfig.answerResolverEnabled,
            this.deps.inverseBoolean(pluginConfig.disableEvidenceAnswerResolver),
          ],
          baseConfig.evidenceAnswerResolverEnabled,
        );
    const dagExpansionMode = emergencyBrake
      ? "deterministic"
      : this.deps.resolveStringEnum(
          [
            pluginConfig.dagExpansionMode,
            pluginConfig.sourceExpansionMode,
            pluginConfig.summaryExpansionMode,
          ],
          ["deterministic", "planner_decides", "delegated_agent"],
          baseConfig.dagExpansionMode,
        ) as BridgeConfig["dagExpansionMode"];
    const dagExpansionAgentProvider = emergencyBrake
      ? "none"
      : this.deps.resolveStringEnum(
          [pluginConfig.dagExpansionAgentProvider, pluginConfig.sourceExpansionAgentProvider],
          ["none", "host_subagent", "llm"],
          baseConfig.dagExpansionAgentProvider,
        ) as BridgeConfig["dagExpansionAgentProvider"];

    return this.deps.validateConfig(this.deps.applyRetrievalStrengthPreset({
      dataDir,
      sessionId: this.deps.resolveSessionId(payload, identityBaseConfig),
      agentId: this.deps.resolveAgentId(payload, identityBaseConfig),
      configPreset,
      workspaceDir,
      sharedDataDir,
      memoryVaultDir,
      knowledgeBaseDir,
      contextWindow: this.deps.resolveConfiguredContextWindow(
        pluginConfig,
        payload,
        baseConfig,
      ),
      contextThreshold: this.deps.resolveNumberConfig(
        [pluginConfig.contextThreshold, pluginConfig.compactionTriggerRatio],
        baseConfig.contextThreshold,
      ),
      freshTailTokens: this.deps.resolveNumberConfig(
        [pluginConfig.freshTailTokens, pluginConfig.recentTailTurns],
        baseConfig.freshTailTokens,
      ),
      maxFreshTailTurns: this.deps.resolveNumberConfig(
        [pluginConfig.maxFreshTailTurns],
        baseConfig.maxFreshTailTurns,
      ),
      compactionBatchTurns: this.deps.resolveNumberConfig(
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
      summaryMaxOutputTokens: this.deps.resolveNumberConfig(
        [pluginConfig.summaryMaxOutputTokens],
        baseConfig.summaryMaxOutputTokens,
      ),
      strictCompaction: this.deps.resolveBooleanFlag(
        [
          pluginConfig.strictCompaction,
          pluginConfig.requireLlmSummary,
          this.deps.inverseBoolean(pluginConfig.allowFallbackSummary),
          this.deps.inverseBoolean(pluginConfig.enableFallbackSummary),
        ],
        baseConfig.strictCompaction,
      ),
      compactionBarrierEnabled: this.deps.resolveBooleanFlag(
        [
          pluginConfig.compactionBarrierEnabled,
          pluginConfig.compressBeforeAssemble,
          this.deps.inverseBoolean(pluginConfig.disableCompactionBarrier),
        ],
        baseConfig.compactionBarrierEnabled,
      ),
      runtimeCaptureEnabled,
      memoryItemEnabled,
      autoRecallEnabled,
      forceDagOnlyRecall: this.deps.resolveBooleanFlag(
        [pluginConfig.forceDagOnlyRecall, pluginConfig.disableDirectRawRecall],
        baseConfig.forceDagOnlyRecall,
      ),
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
      kbCandidateEnabled: this.deps.resolveBooleanFlag(
        [
          pluginConfig.kbCandidateEnabled,
          pluginConfig.knowledgeCandidateEnabled,
          this.deps.inverseBoolean(pluginConfig.disableKbCandidates),
        ],
        baseConfig.kbCandidateEnabled,
      ),
      kbWriteEnabled: this.deps.resolveBooleanFlag(
        [
          pluginConfig.kbWriteEnabled,
          pluginConfig.knowledgeWriteEnabled,
          pluginConfig.knowledgePromotionEnabled,
          this.deps.inverseBoolean(pluginConfig.disableKbWrites),
        ],
        baseConfig.kbWriteEnabled,
      ),
      kbPromotionMode,
      kbPromotionStrictness,
      kbExportEnabled: this.deps.resolveBooleanFlag(
        [
          pluginConfig.kbExportEnabled,
          pluginConfig.knowledgeExportEnabled,
          this.deps.inverseBoolean(pluginConfig.disableKbExport),
        ],
        baseConfig.kbExportEnabled,
      ),
      knowledgeIntakeAllowProjectState,
      knowledgeIntakeAllowBranchSummaries,
      knowledgeIntakeUserOverrideEnabled,
      knowledgeIntakeUserOverridePatterns,
      semanticCandidateExpansionEnabled: emergencyBrake
        ? false
        : this.deps.resolveBooleanFlag(
            [
              pluginConfig.semanticCandidateExpansionEnabled,
              pluginConfig.enableSemanticCandidateExpansion,
              pluginConfig.semanticCandidatesEnabled,
            ],
            presetDefaults.semanticCandidateExpansionEnabled,
          ),
      semanticCandidateLimit: this.deps.resolveNumberConfig(
        [pluginConfig.semanticCandidateLimit, pluginConfig.maxSemanticCandidates],
        presetDefaults.semanticCandidateLimit,
      ),
      usageFeedbackEnabled,
      brainPackEnabled,
      brainPackMode,
      brainPackTurnInterval: this.deps.resolveNumberConfig(
        [
          pluginConfig.brainPackTurnInterval,
          pluginConfig.brainPackConversationTurnInterval,
        ],
        baseConfig.brainPackTurnInterval,
      ),
      brainPackIntervalHours: this.deps.resolveNumberConfig(
        [pluginConfig.brainPackIntervalHours, pluginConfig.brainPackSnapshotIntervalHours],
        baseConfig.brainPackIntervalHours,
      ),
      brainPackOutputDir,
      brainPackGitEnabled: this.deps.resolveBooleanFlag(
        [pluginConfig.brainPackGitEnabled, pluginConfig.brainPackAutoGitEnabled],
        baseConfig.brainPackGitEnabled,
      ),
      brainPackGitRemote: this.deps.resolveOptionalString(
        pluginConfig.brainPackGitRemote,
        baseConfig.brainPackGitRemote,
      ),
      brainPackGitBranch: this.deps.resolveOptionalString(
        pluginConfig.brainPackGitBranch,
        baseConfig.brainPackGitBranch,
      ),
      brainPackCommitMessageTemplate: this.deps.resolveOptionalString(
        pluginConfig.brainPackCommitMessageTemplate,
        baseConfig.brainPackCommitMessageTemplate,
      ),
      brainPackRedactionMode,
      brainPackIncludeRawTranscript,
      brainPackIncludeToolOutputs,
      brainPackDeterministicOrdering: this.deps.resolveBooleanFlag(
        [
          pluginConfig.brainPackDeterministicOrdering,
          pluginConfig.deterministicBrainPackOrdering,
        ],
        baseConfig.brainPackDeterministicOrdering,
      ),
      openClawNativeMode,
      openClawNativeMemoryCoreMode: this.deps.resolveOptionalStringEnum(
        [
          pluginConfig.openClawNativeMemoryCoreMode,
          pluginConfig.memoryCoreNativeMode,
        ],
        ["disabled", "coexist", "absorbed"],
        baseConfig.openClawNativeMemoryCoreMode,
      ) as BridgeConfig["openClawNativeMemoryCoreMode"],
      openClawNativeActiveMemoryMode: this.deps.resolveOptionalStringEnum(
        [
          pluginConfig.openClawNativeActiveMemoryMode,
          pluginConfig.activeMemoryNativeMode,
        ],
        ["disabled", "coexist", "absorbed"],
        baseConfig.openClawNativeActiveMemoryMode,
      ) as BridgeConfig["openClawNativeActiveMemoryMode"],
      openClawNativeMemoryWikiMode: this.deps.resolveOptionalStringEnum(
        [
          pluginConfig.openClawNativeMemoryWikiMode,
          pluginConfig.memoryWikiNativeMode,
        ],
        ["disabled", "coexist", "absorbed"],
        baseConfig.openClawNativeMemoryWikiMode,
      ) as BridgeConfig["openClawNativeMemoryWikiMode"],
      openClawNativeDreamingMode: this.deps.resolveOptionalStringEnum(
        [pluginConfig.openClawNativeDreamingMode, pluginConfig.dreamingNativeMode],
        ["disabled", "coexist", "absorbed"],
        baseConfig.openClawNativeDreamingMode,
      ) as BridgeConfig["openClawNativeDreamingMode"],
      graphEnabled,
      ragEnabled,
      rerankEnabled,
      graphProvider: this.deps.resolveStringEnum(
        [pluginConfig.graphProvider, pluginConfig.retrievalGraphProvider],
        ["none", "sqlite_graph", "sqlite_edges", "external"],
        baseConfig.graphProvider,
      ) as BridgeConfig["graphProvider"],
      ragProvider: this.deps.resolveStringEnum(
        [pluginConfig.ragProvider, pluginConfig.retrievalRagProvider],
        ["none", "sqlite_vec", "brute_force", "embedding", "external"],
        baseConfig.ragProvider,
      ) as BridgeConfig["ragProvider"],
      rerankProvider: this.deps.resolveStringEnum(
        [pluginConfig.rerankProvider, pluginConfig.retrievalRerankProvider],
        ["none", "deterministic", "llm", "specialist", "model", "external"],
        baseConfig.rerankProvider,
      ) as BridgeConfig["rerankProvider"],
      embeddingEnabled,
      embeddingProvider: this.deps.resolveStringEnum(
        [pluginConfig.embeddingProvider, pluginConfig.retrievalEmbeddingProvider],
        ["none", "local_hash", "external"],
        baseConfig.embeddingProvider,
      ) as BridgeConfig["embeddingProvider"],
      embeddingModel: this.deps.resolveOptionalString(
        pluginConfig.embeddingModel,
        baseConfig.embeddingModel,
      ) ?? baseConfig.embeddingModel,
      embeddingDimensions: this.deps.resolveNumberConfig(
        [pluginConfig.embeddingDimensions, pluginConfig.vectorDimensions],
        baseConfig.embeddingDimensions,
      ),
      embeddingAsync: this.deps.resolveBooleanFlag(
        [pluginConfig.embeddingAsync, pluginConfig.embeddingJobsAsync],
        baseConfig.embeddingAsync,
      ),
      embeddingJobMaxBatch: this.deps.resolveNumberConfig(
        [pluginConfig.embeddingJobMaxBatch, pluginConfig.embeddingBatchSize],
        baseConfig.embeddingJobMaxBatch,
      ),
      embeddingJobMaxRetries: this.deps.resolveNumberConfig(
        [pluginConfig.embeddingJobMaxRetries, pluginConfig.embeddingMaxRetries],
        baseConfig.embeddingJobMaxRetries,
      ),
      vectorExtensionPath: this.deps.resolveOptionalString(
        pluginConfig.vectorExtensionPath,
        baseConfig.vectorExtensionPath,
      ),
      vectorExtensionEntryPoint: this.deps.resolveOptionalString(
        pluginConfig.vectorExtensionEntryPoint,
        baseConfig.vectorExtensionEntryPoint,
      ),
      vectorSearchMaxCandidates: this.deps.resolveNumberConfig(
        [pluginConfig.vectorSearchMaxCandidates, pluginConfig.ragVectorCandidateLimit],
        baseConfig.vectorSearchMaxCandidates,
      ),
      bruteForceVectorMaxRows: this.deps.resolveNumberConfig(
        [pluginConfig.bruteForceVectorMaxRows, pluginConfig.ragBruteForceMaxRows],
        baseConfig.bruteForceVectorMaxRows,
      ),
      ragFallbackToBruteForce: this.deps.resolveBooleanFlag(
        [pluginConfig.ragFallbackToBruteForce, pluginConfig.vectorFallbackToBruteForce],
        baseConfig.ragFallbackToBruteForce,
      ),
      graphBuilderEnabled,
      graphBuilderProvider: this.deps.resolveStringEnum(
        [pluginConfig.graphBuilderProvider, pluginConfig.retrievalGraphBuilderProvider],
        ["none", "deterministic", "llm", "external"],
        baseConfig.graphBuilderProvider,
      ) as BridgeConfig["graphBuilderProvider"],
      graphMaxDepth: this.deps.resolveNumberConfig(
        [pluginConfig.graphMaxDepth],
        baseConfig.graphMaxDepth,
      ),
      graphMaxFanout: this.deps.resolveNumberConfig(
        [pluginConfig.graphMaxFanout],
        baseConfig.graphMaxFanout,
      ),
      graphMinConfidence: this.deps.resolveNumberConfig(
        [pluginConfig.graphMinConfidence],
        baseConfig.graphMinConfidence,
      ),
      graphAllowedRelations: this.deps.resolveStringList(
        pluginConfig.graphAllowedRelations,
        baseConfig.graphAllowedRelations,
      ),
      graphCandidateLimit: this.deps.resolveNumberConfig(
        [pluginConfig.graphCandidateLimit, pluginConfig.graphMaxCandidates],
        baseConfig.graphCandidateLimit,
      ),
      rerankModel: this.deps.resolveOptionalString(
        pluginConfig.rerankModel,
        baseConfig.rerankModel,
      ),
      rerankTimeoutMs: this.deps.resolveNumberConfig(
        [pluginConfig.rerankTimeoutMs, pluginConfig.rerankMaxLatencyMs],
        baseConfig.rerankTimeoutMs,
      ),
      rerankFallbackToDeterministic: this.deps.resolveBooleanFlag(
        [pluginConfig.rerankFallbackToDeterministic],
        baseConfig.rerankFallbackToDeterministic,
      ),
      evidenceAnswerResolverEnabled,
      evidenceAnswerResolverProvider: this.deps.resolveStringEnum(
        [pluginConfig.evidenceAnswerResolverProvider, pluginConfig.answerResolverProvider],
        ["none", "deterministic", "llm", "external"],
        baseConfig.evidenceAnswerResolverProvider,
      ) as BridgeConfig["evidenceAnswerResolverProvider"],
      evidenceAnswerResolverModel: this.deps.resolveOptionalString(
        pluginConfig.evidenceAnswerResolverModel,
        baseConfig.evidenceAnswerResolverModel,
      ),
      evidenceAnswerResolverTimeoutMs: this.deps.resolveNumberConfig(
        [pluginConfig.evidenceAnswerResolverTimeoutMs, pluginConfig.answerResolverTimeoutMs],
        baseConfig.evidenceAnswerResolverTimeoutMs,
      ),
      evidenceAnswerResolverFallbackToDeterministic: this.deps.resolveBooleanFlag(
        [pluginConfig.evidenceAnswerResolverFallbackToDeterministic],
        baseConfig.evidenceAnswerResolverFallbackToDeterministic,
      ),
      dagExpansionMode,
      dagExpansionAgentProvider,
      dagExpansionAgentModel: this.deps.resolveOptionalString(
        pluginConfig.dagExpansionAgentModel,
        baseConfig.dagExpansionAgentModel,
      ),
      dagExpansionAgentTimeoutMs: this.deps.resolveNumberConfig(
        [
          pluginConfig.dagExpansionAgentTimeoutMs,
          pluginConfig.sourceExpansionAgentTimeoutMs,
        ],
        baseConfig.dagExpansionAgentTimeoutMs,
      ),
      featureIsolationMode: this.deps.resolveStringEnum(
        [pluginConfig.featureIsolationMode, pluginConfig.optionalFeatureIsolationMode],
        ["fail_closed", "isolate_optional"],
        baseConfig.featureIsolationMode,
      ) as BridgeConfig["featureIsolationMode"],
      heavyRetrievalPolicy,
      ragPlannerPolicy,
      graphPlannerPolicy,
      rerankPlannerPolicy,
      candidateRerankThreshold: this.deps.resolveNumberConfig(
        [pluginConfig.candidateRerankThreshold, pluginConfig.rerankCandidateThreshold],
        baseConfig.candidateRerankThreshold,
      ),
      laneCandidateRerankThreshold: this.deps.resolveNumberConfig(
        [
          pluginConfig.laneCandidateRerankThreshold,
          pluginConfig.rerankLaneCandidateThreshold,
        ],
        baseConfig.laneCandidateRerankThreshold,
      ),
      candidateAmbiguityMargin: this.deps.resolveNumberConfig(
        [pluginConfig.candidateAmbiguityMargin, pluginConfig.rerankAmbiguityMargin],
        baseConfig.candidateAmbiguityMargin,
      ),
      strictModeRequiresRerankOnConflict: this.deps.resolveBooleanFlag(
        [
          pluginConfig.strictModeRequiresRerankOnConflict,
          pluginConfig.strictRerankOnConflict,
        ],
        baseConfig.strictModeRequiresRerankOnConflict,
      ),
      maxEnhancementLatencyMs: this.deps.resolveNumberConfig(
        [
          pluginConfig.maxEnhancementLatencyMs,
          pluginConfig.retrievalEnhancementMaxLatencyMs,
        ],
        baseConfig.maxEnhancementLatencyMs,
      ),
      maxRerankCandidates: this.deps.resolveNumberConfig(
        [pluginConfig.maxRerankCandidates, pluginConfig.rerankCandidateLimit],
        baseConfig.maxRerankCandidates,
      ),
      openClawRuntimeProfile,
      emergencyBrake,
      sqliteJournalMode,
    }));
  }
}
