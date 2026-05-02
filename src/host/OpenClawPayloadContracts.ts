import type { BridgeConfig, RawMessage } from "../types";

export interface ToolConfigResult {
  enabled: boolean;
  source: string;
  runtimeEnableTools: unknown;
  fileEnableTools: unknown;
}

export interface RuntimeMessageSnapshot {
  id?: string;
  sourceKey: string;
  role: RawMessage["role"];
  content: unknown;
  text: string;
  timestamp?: number | string;
  metadata?: Record<string, unknown>;
}

export interface LifecycleContext {
  sessionId: string;
  config: BridgeConfig;
  totalBudget: number;
  systemPromptTokens: number;
  summaryModel?: string;
  runtimeMessages: RuntimeMessageSnapshot[];
}

export interface IngestPayload {
  sessionId: string;
  config: BridgeConfig;
  id: string;
  role: RawMessage["role"];
  content: string;
  turnNumber?: number;
  metadata?: Record<string, unknown>;
}

export interface PayloadMessage extends Record<string, unknown> {
  content?: unknown;
  id?: unknown;
  metadata?: unknown;
  role?: unknown;
  turnNumber?: unknown;
}

export interface OpenClawPayloadLike extends Record<string, unknown> {
  agent?: Record<string, unknown>;
  agentId?: unknown;
  config?: Record<string, unknown>;
  content?: unknown;
  context?: Record<string, unknown>;
  contextWindow?: unknown;
  conversation?: Record<string, unknown>;
  cwd?: unknown;
  id?: unknown;
  input?: Record<string, unknown>;
  message?: PayloadMessage;
  messages?: unknown;
  metadata?: unknown;
  model?: unknown;
  role?: unknown;
  session?: Record<string, unknown>;
  sessionId?: unknown;
  systemPrompt?: unknown;
  systemPromptTokens?: unknown;
  tokenBudget?: unknown;
  turn?: Record<string, unknown>;
  turnNumber?: unknown;
  workspaceDir?: unknown;
}
