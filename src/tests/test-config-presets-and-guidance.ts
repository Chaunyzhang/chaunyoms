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
  assert(safeContext.config.durableMarkdownMirrorEnabled === false, "expected durable Markdown mirrors to be disabled by default");
  assert(safeContext.config.transcriptMirrorEnabled === false, "expected transcript mirrors to be disabled by default");
  assert(safeContext.config.knowledgeMarkdownEnabled === true, "expected curated Knowledge Markdown to remain enabled by default");
  assert(safeContext.config.sqlitePrimaryEnabled === true, "expected SQLite primary runtime storage by default");
  assert(safeContext.config.jsonPersistenceMode === "off", "expected JSON hot-path persistence to be off by default");

  const mirrorContext = adapter.resolveLifecycleContext({
    config: {
      agentVaultMirrorEnabled: true,
      summaryMarkdownMirrorEnabled: true,
      durableMarkdownMirrorEnabled: true,
      transcriptMirrorEnabled: true,
      knowledgeMarkdownEnabled: false,
      sqlitePrimaryEnabled: false,
      jsonPersistenceMode: "backup",
    },
  }, DEFAULT_BRIDGE_CONFIG);
  assert(mirrorContext.config.agentVaultMirrorEnabled === true, "expected explicit AgentVault mirror opt-in");
  assert(mirrorContext.config.summaryMarkdownMirrorEnabled === true, "expected explicit summary mirror opt-in");
  assert(mirrorContext.config.durableMarkdownMirrorEnabled === true, "expected explicit durable mirror opt-in");
  assert(mirrorContext.config.transcriptMirrorEnabled === true, "expected explicit transcript mirror opt-in");
  assert(mirrorContext.config.knowledgeMarkdownEnabled === false, "expected explicit Knowledge Markdown opt-out to parse");
  assert(mirrorContext.config.sqlitePrimaryEnabled === false, "expected explicit SQLite primary opt-out to parse");
  assert(mirrorContext.config.jsonPersistenceMode === "backup", "expected explicit JSON backup mode to parse");

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
