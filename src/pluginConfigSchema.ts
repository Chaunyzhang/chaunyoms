export const pluginConfigSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    dataDir: {
      type: "string",
      description: "Directory for ChaunyOMS runtime data. Defaults to sharedDataDir/data/chaunyoms.",
    },
    agentId: {
      type: "string",
      description: "Canonical agent identity used for long-term memory boundaries.",
    },
    configPreset: {
      type: "string",
      enum: ["safe", "balanced", "enhanced_recall"],
      description: "Named config preset. Safe reduces automation, balanced keeps current defaults, enhanced_recall enables stronger retrieval helpers.",
    },
    workspaceDir: {
      type: "string",
      description: "OpenClaw workspace directory used for navigation snapshots and project-local runtime state.",
    },
    sharedDataDir: {
      type: "string",
      description: "Shared data root for unified knowledge indexes, shared cognition, and plugin support files.",
    },
    memoryVaultDir: {
      type: "string",
      description: "Git-friendly Markdown memory vault root. Defaults to sharedDataDir/vaults/chaunyoms.",
    },
    knowledgeBaseDir: {
      type: "string",
      description: "Unified markdown knowledge directory. AI promotions and user-provided raw/ files are indexed as one corpus with provenance metadata only.",
    },
    enableTools: {
      type: "boolean",
      description: "Register the standard ChaunyOMS tool surface: memory_retrieve plus raw/source trace utilities.",
    },
    contextWindow: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Maximum context budget seen by the plugin.",
    },
    contextThreshold: {
      type: "number",
      exclusiveMinimum: 0,
      exclusiveMaximum: 1,
      description: "Compaction trigger ratio. Default 0.70.",
    },
    strictCompaction: {
      type: "boolean",
      description: "Require the host LLM for summary generation. When true, summary, rollup, and knowledge-promotion writes stop instead of degrading to non-LLM output.",
    },
    compactionBarrierEnabled: {
      type: "boolean",
      description: "When true, compaction runs before assemble continues whenever pressure crosses the trigger threshold.",
    },
    freshTailTokens: {
      type: "number",
      minimum: 0,
      description: "Token budget reserved for fresh uncompressed tail messages.",
    },
    maxFreshTailTurns: {
      type: "number",
      minimum: 0,
      description: "Maximum number of recent turns protected from compaction.",
    },
    compactionBatchTurns: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Maximum number of turn ranges considered in one compaction pass.",
    },
    summaryModel: {
      type: "string",
      description: "Preferred model for summary generation.",
    },
    summaryMaxOutputTokens: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 8192,
      description: "Maximum output tokens for summary generation.",
    },
    runtimeCaptureEnabled: {
      type: "boolean",
      description: "Enable runtime message capture from host payloads.",
    },
    durableMemoryEnabled: {
      type: "boolean",
      description: "Enable durable memory extraction and persistence.",
    },
    autoRecallEnabled: {
      type: "boolean",
      description: "Allow automatic source recall when the route requires historical detail.",
    },
    knowledgePromotionEnabled: {
      type: "boolean",
      description: "Enable promotion from accepted knowledge raw into the unified knowledge store. Disabled by default.",
    },
    knowledgeIntakeMode: {
      type: "string",
      enum: ["conservative", "balanced", "aggressive"],
      description: "Knowledge intake strictness before accepted summaries enter knowledge raw.",
    },
    knowledgeIntakeAllowProjectState: {
      type: "boolean",
      description: "Allow project_state summaries to enter knowledge raw more easily.",
    },
    knowledgeIntakeAllowBranchSummaries: {
      type: "boolean",
      description: "Allow branch/rollup summaries to enter knowledge raw.",
    },
    knowledgeIntakeUserOverrideEnabled: {
      type: "boolean",
      description: "Allow explicit user 'remember/store this' intent to bypass the normal knowledge intake gate.",
    },
    knowledgeIntakeUserOverridePatterns: {
      type: "array",
      items: {
        type: "string",
      },
      description: "Additional literal phrases that should count as explicit user knowledge-intake override signals.",
    },
    semanticCandidateExpansionEnabled: {
      type: "boolean",
      description: "Allow heuristic/semantic candidate expansion to propose authoritative follow-up retrieval paths.",
    },
    semanticCandidateLimit: {
      type: "number",
      minimum: 0,
      description: "Maximum number of semantic candidates to surface in retrieval diagnostics.",
    },
    emergencyBrake: {
      type: "boolean",
      description: "Emergency stop: disables runtime capture, durable writes, auto recall, and knowledge promotion.",
    },
  },
} as const;
