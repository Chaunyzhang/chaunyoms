import { OpenClawBridge } from "../OpenClawBridge";
import plugin from "../../index";
import { inspectOpenClawCompatibility } from "../host/OpenClawCompatibilityContract";
import manifest from "../../openclaw.plugin.json";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const manifestRecord = manifest as Record<string, unknown>;
  const pluginRecord = plugin as Record<string, unknown>;
  assert(manifestRecord.id === "oms", "plugin manifest should use the docs-exact oms plugin id");
  assert(pluginRecord.id === manifestRecord.id, "runtime plugin export id should match openclaw.plugin.json");
  assert(pluginRecord.kind === manifestRecord.kind, "runtime plugin export kind should match openclaw.plugin.json");
  assert(manifestRecord.kind === "memory", "plugin manifest should advertise the memory slot as the primary OpenClaw slot");
  assert(!("aliases" in manifestRecord), "plugin manifest should not keep legacy slot aliases in the final shape");
  const manifestCapabilities = manifestRecord.capabilities as unknown[];
  assert(manifestCapabilities.includes("memory"), "plugin manifest should advertise memory capability");
  assert(manifestCapabilities.includes("context-engine"), "plugin manifest should advertise context-engine capability");
  const manifestProvides = manifestRecord.provides as Record<string, unknown>;
  assert((manifestProvides.memory as Record<string, unknown>).markdownHotPath === false, "plugin manifest should declare Markdown hot path disabled");
  const manifestSchema = manifestRecord.configSchema as Record<string, unknown>;
  const manifestProperties = manifestSchema.properties as Record<string, Record<string, unknown>>;
  assert(String(manifestProperties.knowledgeMarkdownEnabled.description ?? "").includes("Disabled by default"), "manifest config schema should match final Markdown export-only default");

  const valid = inspectOpenClawCompatibility({
    config: {
      plugins: {
        slots: {
          memory: "oms",
          contextEngine: "oms",
        },
        entries: {
          oms: {
            enabled: true,
            config: { mode: "authoritative" },
          },
          "memory-core": { enabled: false },
          "active-memory": { enabled: false },
          "memory-wiki": { enabled: false },
          dreaming: { enabled: false },
        },
      },
    },
    registerContextEngine(): void {},
    registerMemoryCapability(): void {},
    registerTool(): void {},
  });
  assert(valid.ok, "authoritative dual-slot config with native memory disabled should pass");
  assert(valid.enforcement === "fail_fast", "authoritative mode should use fail-fast enforcement");
  assert(valid.capabilities.memorySlotProvider, "authoritative mode should require a real memory slot provider registration API");

  const legacyPackageAlias = inspectOpenClawCompatibility({
    config: {
      plugins: {
        slots: {
          memory: "chaunyoms",
          contextEngine: "chaunyoms",
        },
        entries: {
          oms: {
            enabled: true,
            config: { mode: "authoritative" },
          },
          "memory-core": { enabled: false },
          "active-memory": { enabled: false },
          "memory-wiki": { enabled: false },
          dreaming: { enabled: false },
        },
      },
    },
    registerContextEngine(): void {},
    registerMemoryCapability(): void {},
  });
  assert(!legacyPackageAlias.ok, "authoritative final shape should reject legacy chaunyoms slot aliases");
  assert(legacyPackageAlias.errors.some((error) => error.includes('plugins.slots.memory is bound to "chaunyoms"')), "legacy memory slot alias should be reported");

  const invalid = inspectOpenClawCompatibility({
    config: {
      plugins: {
        slots: {
          memory: "memory-core",
          contextEngine: "legacy",
        },
        entries: {
          oms: {
            enabled: true,
            config: { mode: "authoritative" },
          },
          "memory-core": { enabled: true },
          "active-memory": { enabled: true },
          "memory-wiki": { enabled: true },
          dreaming: { enabled: true },
        },
      },
    },
  });
  assert(!invalid.ok, "authoritative config must reject non-OMS slots and enabled native memory plugins");
  assert(invalid.errors.some((error) => error.includes("plugins.slots.memory")), "invalid memory slot should be reported");
  assert(invalid.errors.some((error) => error.includes("memory-core")), "enabled memory-core should be reported");
  assert(invalid.errors.some((error) => error.includes("memory plugin registration API")), "missing memory slot provider should be reported");

  const legacyMemoryApis = inspectOpenClawCompatibility({
    config: {
      plugins: {
        slots: {
          memory: "oms",
          contextEngine: "oms",
        },
        entries: {
          oms: {
            enabled: true,
            config: { mode: "authoritative" },
          },
          "memory-core": { enabled: false },
          "active-memory": { enabled: false },
          "memory-wiki": { enabled: false },
          dreaming: { enabled: false },
        },
      },
    },
    registerContextEngine(): void {},
    registerMemoryPromptSection(): void {},
    registerMemoryFlushPlan(): void {},
    registerMemoryRuntime(): void {},
  });
  assert(legacyMemoryApis.ok, "legacy prompt/flush/runtime APIs together should still provide an authoritative memory slot");
  assert(legacyMemoryApis.warnings.some((warning) => warning.includes("legacy memory registration APIs")), "legacy memory APIs should warn that registerMemoryCapability is preferred");

  let threw = false;
  try {
    new OpenClawBridge().register({
      config: {
        plugins: {
          slots: {
            memory: "memory-core",
            contextEngine: "legacy",
          },
          entries: {
            oms: {
              enabled: true,
              config: { mode: "authoritative", enableTools: true },
            },
            "memory-core": { enabled: true },
          },
        },
      },
      logger: { info(): void {}, warn(): void {}, error(): void {} },
      registerContextEngine(): void {},
      registerMemoryCapability(): void {},
      registerTool(): void {},
    });
  } catch (error) {
    threw = /Invalid ChaunyOMS authoritative OpenClaw compatibility contract/.test(String(error));
  }
  assert(threw, "bridge registration should fail fast when authoritative compatibility contract is broken");

  const advisory = inspectOpenClawCompatibility({
    config: {
      plugins: {
        entries: {
          oms: {
            enabled: true,
            config: { mode: "advisory" },
          },
        },
      },
    },
  });
  assert(advisory.ok, "advisory mode should not fail when slots are absent");
  assert(advisory.warnings.some((warning) => warning.includes("plugins.slots.memory")), "advisory mode should still warn on missing memory slot");

  console.log("test-openclaw-compatibility-contract passed");
}

void main();
