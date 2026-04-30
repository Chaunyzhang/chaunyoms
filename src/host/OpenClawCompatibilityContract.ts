import {
  HostConfigLike,
  HostRecord,
  isHostRecord,
  OpenClawApiLike,
} from "./OpenClawHostTypes";

export const OPENCLAW_COMPATIBILITY_PLUGIN_ID = "oms";
export const OPENCLAW_COMPATIBILITY_PLUGIN_IDS = [
  OPENCLAW_COMPATIBILITY_PLUGIN_ID,
] as const;

export type OpenClawCompatibilityMode = "advisory" | "authoritative";
export type OpenClawNativeMode = "disabled" | "coexist" | "absorbed";

export interface OpenClawNativePluginStatus {
  id: "memory-core" | "active-memory" | "memory-wiki" | "dreaming";
  present: boolean;
  enabled: boolean | null;
  mode: OpenClawNativeMode;
  dreamingEnabled?: boolean | null;
}

export interface OpenClawCompatibilityReport {
  ok: boolean;
  mode: OpenClawCompatibilityMode;
  nativeMode: OpenClawNativeMode;
  enforcement: "warn_only" | "fail_fast";
  expectedPluginIds: string[];
  selectedSlots: {
    memory?: string;
    contextEngine?: string;
  };
  nativePlugins: OpenClawNativePluginStatus[];
  capabilities: {
    registerContextEngine: boolean;
    registerMemoryCapability: boolean;
    registerMemoryPromptSection: boolean;
    registerMemoryFlushPlan: boolean;
    registerMemoryRuntime: boolean;
    memorySlotProvider: boolean;
    registerTool: boolean;
  };
  warnings: string[];
  errors: string[];
}

export function inspectOpenClawCompatibility(
  api?: OpenClawApiLike,
): OpenClawCompatibilityReport {
  const config = resolveHostConfig(api);
  const slots = asRecord(config?.plugins?.slots);
  const entries = asRecord(config?.plugins?.entries);
  const pluginConfig = resolveOmsPluginConfig(api, entries);
  const mode = resolveCompatibilityMode(pluginConfig);
  const nativeMode = resolveNativeMode(pluginConfig);
  const errors: string[] = [];
  const warnings: string[] = [];

  const selectedSlots = {
    memory: stringOrUndefined(slots?.memory),
    contextEngine: stringOrUndefined(slots?.contextEngine),
  };

  validateSlot("memory", selectedSlots.memory, mode, errors, warnings);
  validateSlot("contextEngine", selectedSlots.contextEngine, mode, errors, warnings);

  const nativePlugins = inspectNativePlugins(entries, pluginConfig, nativeMode);
  for (const plugin of nativePlugins) {
    if (plugin.enabled === true || plugin.dreamingEnabled === true) {
      if (plugin.mode === "disabled") {
        if (plugin.enabled === true) {
          errors.push(
            `plugins.entries["${plugin.id}"].enabled must be false when ChaunyOMS native policy is disabled.`,
          );
        }
        if (plugin.dreamingEnabled === true) {
          errors.push(
            `plugins.entries["${plugin.id}"].config.dreaming.enabled must be false when native policy is disabled; Dreaming must not write MEMORY.md/DREAMS.md in the hot path.`,
          );
        }
      } else if (plugin.mode === "coexist") {
        warnings.push(
          `plugins.entries["${plugin.id}"] is enabled under coexist; ChaunyOMS will treat native output only as external advisory signal, never SQLite authoritative fact.`,
        );
      } else {
        warnings.push(
          `plugins.entries["${plugin.id}"] is enabled under absorbed; native output must enter OMS observation/candidate/validation/promotion before becoming MemoryItem or knowledge_raw.`,
        );
      }
    }
  }

  const capabilities = {
    registerContextEngine: typeof api?.registerContextEngine === "function",
    registerMemoryCapability: typeof api?.registerMemoryCapability === "function",
    registerMemoryPromptSection: typeof api?.registerMemoryPromptSection === "function",
    registerMemoryFlushPlan: typeof api?.registerMemoryFlushPlan === "function",
    registerMemoryRuntime: typeof api?.registerMemoryRuntime === "function",
    registerTool: typeof api?.registerTool === "function",
  };
  const hasLegacyMemorySlotProvider =
    capabilities.registerMemoryPromptSection &&
    capabilities.registerMemoryFlushPlan &&
    capabilities.registerMemoryRuntime;
  const memorySlotProvider =
    capabilities.registerMemoryCapability || hasLegacyMemorySlotProvider;

  if (!capabilities.registerContextEngine) {
    const message = "OpenClaw registerContextEngine API is unavailable; ChaunyOMS cannot bind the contextEngine slot in this host.";
    if (mode === "authoritative") {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  }
  if (!memorySlotProvider) {
    const message =
      "OpenClaw memory plugin registration API is unavailable; ChaunyOMS cannot bind the memory slot authoritatively.";
    if (mode === "authoritative") {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  } else if (
    !capabilities.registerMemoryCapability &&
    (capabilities.registerMemoryPromptSection ||
      capabilities.registerMemoryFlushPlan ||
      capabilities.registerMemoryRuntime)
  ) {
    warnings.push(
      "OpenClaw host exposes only legacy memory registration APIs; ChaunyOMS registered prompt/flush/runtime surfaces but registerMemoryCapability is preferred.",
    );
  }
  if (!capabilities.registerTool) {
    warnings.push("OpenClaw registerTool API is unavailable; memory_search/memory_get compatibility tools cannot be registered.");
  }

  return {
    ok: errors.length === 0,
    mode,
    nativeMode,
    enforcement: mode === "authoritative" ? "fail_fast" : "warn_only",
    expectedPluginIds: [...OPENCLAW_COMPATIBILITY_PLUGIN_IDS],
    selectedSlots,
    nativePlugins,
    capabilities: {
      ...capabilities,
      memorySlotProvider,
    },
    warnings,
    errors,
  };
}

export function formatOpenClawCompatibilityFailure(
  report: OpenClawCompatibilityReport,
): string {
  return [
    "Invalid ChaunyOMS authoritative OpenClaw compatibility contract.",
    ...report.errors.map((error) => `- ${error}`),
  ].join("\n");
}

function validateSlot(
  slot: "memory" | "contextEngine",
  value: string | undefined,
  mode: OpenClawCompatibilityMode,
  errors: string[],
  warnings: string[],
): void {
  if (!value) {
    const message =
      `plugins.slots.${slot} must be bound to "${OPENCLAW_COMPATIBILITY_PLUGIN_ID}" for the final dual-slot authoritative shape.`;
    if (mode === "authoritative") {
      errors.push(message);
    } else {
      warnings.push(message);
    }
    return;
  }

  if (!OPENCLAW_COMPATIBILITY_PLUGIN_IDS.includes(value as typeof OPENCLAW_COMPATIBILITY_PLUGIN_IDS[number])) {
    errors.push(
      `plugins.slots.${slot} is bound to "${value}", but ChaunyOMS authoritative mode requires "${OPENCLAW_COMPATIBILITY_PLUGIN_ID}".`,
    );
  }
}

function inspectNativePlugins(
  entries: HostRecord | undefined,
  pluginConfig: HostRecord | undefined,
  defaultMode: OpenClawNativeMode,
): OpenClawNativePluginStatus[] {
  return (["memory-core", "active-memory", "memory-wiki", "dreaming"] as const)
    .map((id) => {
      const entry = asRecord(entries?.[id]);
      const config = asRecord(entry?.config);
      return {
        id,
        present: Boolean(entry),
        enabled: entry ? entryEnabled(entry) : null,
        mode: resolveNativeFeatureMode(pluginConfig, id, defaultMode),
        dreamingEnabled: resolveDreamingEnabled(config),
      };
    });
}

function entryEnabled(entry: HostRecord): boolean {
  return booleanFlag(entry.enabled, true);
}

function resolveDreamingEnabled(config: HostRecord | undefined): boolean | null {
  if (!config) {
    return null;
  }
  const direct = config.dreaming;
  if (direct === true) {
    return true;
  }
  if (direct === false) {
    return false;
  }
  const dreaming = asRecord(direct);
  if (!dreaming || dreaming.enabled === undefined) {
    return null;
  }
  return booleanFlag(dreaming.enabled, true);
}

function resolveHostConfig(api?: OpenClawApiLike): HostConfigLike | undefined {
  return firstHostRecord(
    api?.config,
    api?.context?.config,
    api?.runtime?.config,
  ) as HostConfigLike | undefined;
}

function resolveOmsPluginConfig(
  api: OpenClawApiLike | undefined,
  entries: HostRecord | undefined,
): HostRecord | undefined {
  return firstHostRecord(
    api?.pluginConfig,
    api?.context?.pluginConfig,
    api?.runtime?.pluginConfig,
    asRecord(entries?.oms)?.config,
  );
}

function resolveCompatibilityMode(
  pluginConfig: HostRecord | undefined,
): OpenClawCompatibilityMode {
  const mode = typeof pluginConfig?.mode === "string"
    ? pluginConfig.mode.trim().toLowerCase()
    : typeof pluginConfig?.openClawCompatibilityMode === "string"
      ? pluginConfig.openClawCompatibilityMode.trim().toLowerCase()
      : "";
  return mode === "authoritative" ? "authoritative" : "advisory";
}

function resolveNativeMode(pluginConfig: HostRecord | undefined): OpenClawNativeMode {
  const value = typeof pluginConfig?.openClawNativeMode === "string"
    ? pluginConfig.openClawNativeMode
    : typeof pluginConfig?.nativeMemoryMode === "string"
      ? pluginConfig.nativeMemoryMode
      : "disabled";
  return normalizeNativeMode(value, "disabled");
}

function resolveNativeFeatureMode(
  pluginConfig: HostRecord | undefined,
  id: OpenClawNativePluginStatus["id"],
  fallback: OpenClawNativeMode,
): OpenClawNativeMode {
  const key = id === "memory-core"
    ? "openClawNativeMemoryCoreMode"
    : id === "active-memory"
      ? "openClawNativeActiveMemoryMode"
      : id === "memory-wiki"
        ? "openClawNativeMemoryWikiMode"
        : "openClawNativeDreamingMode";
  const value = pluginConfig?.[key];
  return typeof value === "string" ? normalizeNativeMode(value, fallback) : fallback;
}

function normalizeNativeMode(value: string, fallback: OpenClawNativeMode): OpenClawNativeMode {
  const normalized = value.trim().toLowerCase();
  return normalized === "disabled" || normalized === "coexist" || normalized === "absorbed"
    ? normalized
    : fallback;
}

function firstHostRecord(...values: unknown[]): HostRecord | undefined {
  return values.find(isHostRecord);
}

function asRecord(value: unknown): HostRecord | undefined {
  return isHostRecord(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function booleanFlag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "no", "off", "disabled"].includes(normalized)) {
      return false;
    }
    if (["true", "1", "yes", "on", "enabled"].includes(normalized)) {
      return true;
    }
  }
  return fallback;
}
