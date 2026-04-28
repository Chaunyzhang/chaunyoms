import { LoggerLike } from "../types";

export type HostRecord = Record<string, unknown>;

export interface HostFunctionContainer extends HostRecord {
  call?: unknown;
  complete?: unknown;
  search?: unknown;
  query?: unknown;
}

export interface HostContextNamespace extends HostRecord {
  agent?: HostRecord;
  config?: HostConfigLike;
  llm?: HostFunctionContainer;
  memorySearch?: HostFunctionContainer;
  model?: HostFunctionContainer;
  pluginConfig?: unknown;
}

export interface HostProviderConfig extends HostRecord {
  api?: unknown;
  apiKey?: unknown;
  apiKeyEnv?: unknown;
  baseUrl?: unknown;
}

export interface HostConfigLike extends HostRecord {
  agents?: {
    defaults?: {
      memorySearch?: HostRecord;
      model?: {
        fallbacks?: unknown;
        primary?: unknown;
      };
      models?: HostRecord;
    };
  };
  enableTools?: unknown;
  models?: {
    providers?: Record<string, HostProviderConfig>;
  };
  plugins?: {
    slots?: Record<string, unknown>;
    entries?: Record<string, { config?: HostRecord; enabled?: unknown }>;
  };
}

export interface OpenClawToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, args: unknown) => Promise<unknown>;
}

export interface OpenClawApiLike extends HostRecord {
  agent?: HostRecord;
  config?: HostConfigLike;
  context?: HostContextNamespace;
  llm?: HostFunctionContainer;
  logger?: LoggerLike;
  memorySearch?: HostFunctionContainer;
  pluginConfig?: unknown;
  registerContextEngine?: (id: string, factory: () => unknown) => void;
  registerMemoryCapability?: (capability: unknown) => void;
  registerMemoryFlushPlan?: (resolver: unknown) => void;
  registerMemoryPromptSection?: (builder: unknown) => void;
  registerMemoryRuntime?: (runtime: unknown) => void;
  registerTool?: (tool: OpenClawToolDefinition) => void;
  runtime?: HostContextNamespace;
  session?: HostRecord;
}

export function isHostRecord(value: unknown): value is HostRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
