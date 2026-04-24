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

  const guidance = adapter.describeConfigGuidance(enhancedContext.config);
  assert(
    guidance.warnings.some((warning) => /strict compaction is off/i.test(warning)),
    "expected guidance to warn about weak knowledge promotion inputs",
  );

  console.log("test-config-presets-and-guidance passed");
}

void main();
