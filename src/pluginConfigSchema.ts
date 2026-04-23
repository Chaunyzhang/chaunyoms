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
    workspaceDir: {
      type: "string",
      description: "OpenClaw workspace directory used for navigation snapshots and local knowledge paths.",
    },
    sharedDataDir: {
      type: "string",
      description: "Shared data root for insights, indexes, and stable external plugin storage.",
    },
    memoryVaultDir: {
      type: "string",
      description: "Git-friendly Markdown memory vault root. Defaults to sharedDataDir/vaults/chaunyoms.",
    },
    knowledgeBaseDir: {
      type: "string",
      description: "Optional git-friendly markdown knowledge directory. Defaults to sharedDataDir/knowledge-base.",
    },
    enableTools: {
      type: "boolean",
      description: "Register retrieval tools such as memory_route and memory_retrieve.",
    },
    contextWindow: {
      type: "number",
      description: "Maximum context budget seen by the plugin.",
    },
    contextThreshold: {
      type: "number",
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
      description: "Token budget reserved for fresh uncompressed tail messages.",
    },
    maxFreshTailTurns: {
      type: "number",
      description: "Maximum number of recent turns protected from compaction.",
    },
    compactionBatchTurns: {
      type: "number",
      description: "Maximum number of turn ranges considered in one compaction pass.",
    },
    summaryModel: {
      type: "string",
      description: "Preferred model for summary generation.",
    },
    summaryMaxOutputTokens: {
      type: "number",
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
      description: "Enable knowledge markdown promotion. Disabled by default.",
    },
    emergencyBrake: {
      type: "boolean",
      description: "Emergency stop: disables runtime capture, durable writes, auto recall, and knowledge promotion.",
    },
  },
} as const;
