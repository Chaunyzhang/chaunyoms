import { BridgeConfig, ConfigPreset } from "../types";

export interface ConfigGuidanceResult {
  preset: ConfigPreset;
  warnings: string[];
}

export class OpenClawConfigGuidanceAdvisor {
  describe(config: BridgeConfig): ConfigGuidanceResult {
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
}
