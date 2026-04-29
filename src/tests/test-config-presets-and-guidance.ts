import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const adapter = new OpenClawPayloadAdapter(
    () => ({ config: {} }),
    () => ({ info(): void {}, warn(): void {}, error(): void {} }),
  );

  const safeContext = adapter.resolveLifecycleContext({
    config: {
      configPreset: "safe",
    },
  }, DEFAULT_BRIDGE_CONFIG);
  assert(safeContext.config.configPreset === "safe", "expected safe preset to resolve");
  assert(safeContext.config.autoRecallEnabled === false, "expected safe preset to disable auto recall by default");
  assert(safeContext.config.semanticCandidateExpansionEnabled === false, "expected safe preset to disable semantic candidate expansion");
  assert(safeContext.config.agentVaultMirrorEnabled === false, "expected AgentVault mirrors to be disabled by default");
  assert(safeContext.config.summaryMarkdownMirrorEnabled === false, "expected summary Markdown mirrors to be disabled by default");
  assert(safeContext.config.memoryItemMarkdownMirrorEnabled === false, "expected MemoryItem Markdown mirrors to be disabled by default");
  assert(safeContext.config.transcriptMirrorEnabled === false, "expected transcript mirrors to be disabled by default");
  assert(safeContext.config.knowledgeMarkdownEnabled === false, "expected Knowledge Markdown hot-path assets to be disabled by default");
  assert(safeContext.config.usageFeedbackEnabled === true, "expected usage feedback to stay enabled even in safe preset because it is bounded audit metadata");
  assert(safeContext.config.brainPackEnabled === true, "expected BrainPack projection support to be available by default");
  assert(safeContext.config.brainPackGitEnabled === false, "expected BrainPack git automation to remain opt-in");
  assert(safeContext.config.openClawNativeMode === "disabled", "expected OpenClaw native capabilities to be disabled by default");
  assert(safeContext.config.graphEnabled === false && safeContext.config.ragEnabled === false && safeContext.config.rerankEnabled === false, "expected RAG/graph/rerank enhancements to be off by default");

  const mirrorContext = adapter.resolveLifecycleContext({
    config: {
      agentVaultMirrorEnabled: true,
      summaryMarkdownMirrorEnabled: true,
      memoryItemMarkdownMirrorEnabled: true,
      transcriptMirrorEnabled: true,
      knowledgeMarkdownEnabled: true,
    },
  }, DEFAULT_BRIDGE_CONFIG);
  assert(mirrorContext.config.agentVaultMirrorEnabled === true, "expected explicit AgentVault mirror opt-in");
  assert(mirrorContext.config.summaryMarkdownMirrorEnabled === true, "expected explicit summary mirror opt-in");
  assert(mirrorContext.config.memoryItemMarkdownMirrorEnabled === true, "expected explicit MemoryItem mirror opt-in");
  assert(mirrorContext.config.transcriptMirrorEnabled === true, "expected explicit transcript mirror opt-in");
  assert(mirrorContext.config.knowledgeMarkdownEnabled === true, "expected explicit Knowledge Markdown export opt-in to parse");

  const enhancedContext = adapter.resolveLifecycleContext({
    config: {
      configPreset: "enhanced_recall",
      knowledgePromotionEnabled: true,
      strictCompaction: false,
    },
  }, DEFAULT_BRIDGE_CONFIG);
  assert(enhancedContext.config.configPreset === "enhanced_recall", "expected enhanced recall preset to resolve");
  assert(enhancedContext.config.semanticCandidateExpansionEnabled === true, "expected enhanced recall preset to enable semantic candidates");
  assert(enhancedContext.config.semanticCandidateLimit >= 8, "expected enhanced recall preset to raise candidate limit");
  assert(enhancedContext.config.knowledgePromotionManualReviewEnabled === true, "expected knowledge promotion to stay manual-review-first by default");

  const guidance = adapter.describeConfigGuidance(enhancedContext.config);
  assert(
    guidance.warnings.some((warning) => /strict compaction is off/i.test(warning)),
    "expected guidance to warn about weak knowledge promotion inputs",
  );

  console.log("test-config-presets-and-guidance passed");
}

void main();
