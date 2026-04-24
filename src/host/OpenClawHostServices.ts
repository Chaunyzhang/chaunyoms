import path from "node:path";

import { BridgeConfig, LlmCallParams, LlmCaller, LoggerLike } from "../types";
import {
  HostConfigLike,
  HostFunctionContainer,
  HostProviderConfig,
  OpenClawApiLike,
} from "./OpenClawHostTypes";
import { getDefaultSharedDataDir, getDefaultWorkspaceDir } from "./HostPathResolver";

const DEFAULT_SHARED_DATA_DIR = getDefaultSharedDataDir();
const DEFAULT_WORKSPACE_DIR = getDefaultWorkspaceDir();

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  dataDir: path.join(DEFAULT_SHARED_DATA_DIR, "data", "chaunyoms"),
  sessionId: "default-session",
  agentId: "main",
  configPreset: "balanced",
  workspaceDir: DEFAULT_WORKSPACE_DIR,
  sharedDataDir: DEFAULT_SHARED_DATA_DIR,
  memoryVaultDir: path.join(
    DEFAULT_SHARED_DATA_DIR,
    "vaults",
    "chaunyoms",
  ),
  knowledgeBaseDir: path.join(
    DEFAULT_SHARED_DATA_DIR,
    "knowledge-base",
  ),
  contextWindow: 32000,
  contextThreshold: 0.7,
  freshTailTokens: 6000,
  maxFreshTailTurns: 8,
  compactionBatchTurns: 12,
  summaryMaxOutputTokens: 300,
  strictCompaction: true,
  compactionBarrierEnabled: true,
  runtimeCaptureEnabled: true,
  durableMemoryEnabled: true,
  autoRecallEnabled: true,
  knowledgePromotionEnabled: false,
  knowledgeIntakeMode: "balanced",
  knowledgeIntakeAllowProjectState: false,
  knowledgeIntakeAllowBranchSummaries: false,
  knowledgeIntakeUserOverrideEnabled: true,
  knowledgeIntakeUserOverridePatterns: [],
  semanticCandidateExpansionEnabled: true,
  semanticCandidateLimit: 5,
  emergencyBrake: false,
};

export class ConsoleLogger implements LoggerLike {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(`[chaunyoms] ${message}`, meta ?? {});
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(`[chaunyoms] ${message}`, meta ?? {});
  }

  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`[chaunyoms] ${message}`, meta ?? {});
  }
}

export class OpenClawLlmCaller implements LlmCaller {
  private readonly provider: {
    name: string;
    invoke: (params: LlmCallParams) => Promise<unknown>;
  } | null;

  constructor(
    private readonly api?: OpenClawApiLike,
    private readonly logger?: LoggerLike,
  ) {
    this.provider = this.resolveProvider();
    if (!this.provider) {
      this.logger?.warn("llm_provider_unavailable", {
        checkedProviders: [
          "context.llm.call",
          "context.llm.complete",
          "llm.call",
          "llm.complete",
          "runtime.llm.call",
          "runtime.llm.complete",
          "context.model.call",
          "context.model.complete",
        ],
      });
    }
  }

  async call(params: LlmCallParams): Promise<string> {
    if (!this.provider) {
      throw new Error("No OpenClaw LLM caller available");
    }

    try {
      const result = await this.provider.invoke(params);
      if (typeof result === "string") {
        return result;
      }

      const extractedText = this.extractTextResult(result);
      return extractedText ?? JSON.stringify(result);
    } catch (error) {
      throw new Error(
        `OpenClaw LLM call failed via ${this.provider.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private resolveProvider(): {
    name: string;
    invoke: (params: LlmCallParams) => Promise<unknown>;
  } | null {
    const candidates: Array<{
      name: string;
      target?: HostFunctionContainer;
      method: "call" | "complete";
    }> = [
      {
        name: "context.llm.call",
        target: this.api?.context?.llm,
        method: "call",
      },
      {
        name: "context.llm.complete",
        target: this.api?.context?.llm,
        method: "complete",
      },
      { name: "llm.call", target: this.api?.llm, method: "call" },
      { name: "llm.complete", target: this.api?.llm, method: "complete" },
      {
        name: "runtime.llm.call",
        target: this.api?.runtime?.llm,
        method: "call",
      },
      {
        name: "runtime.llm.complete",
        target: this.api?.runtime?.llm,
        method: "complete",
      },
      {
        name: "context.model.call",
        target: this.api?.context?.model,
        method: "call",
      },
      {
        name: "context.model.complete",
        target: this.api?.context?.model,
        method: "complete",
      },
    ];

    for (const candidate of candidates) {
      const fn = candidate.target?.[candidate.method];
      if (typeof fn === "function") {
        return {
          name: candidate.name,
          invoke: (params: LlmCallParams) =>
            Promise.resolve(fn.call(candidate.target, params)),
        };
      }
    }

    const configuredProvider = this.resolveConfiguredProvider();
    if (configuredProvider) {
      return configuredProvider;
    }

    return null;
  }

  private resolveConfiguredProvider(): {
    name: string;
    invoke: (params: LlmCallParams) => Promise<unknown>;
  } | null {
    const apiConfig = this.api?.config;
    if (!apiConfig || typeof apiConfig !== "object") {
      return null;
    }

    return {
      name: "config.models.providers",
      invoke: async (params: LlmCallParams) => {
        const modelRef =
          this.resolvePreferredConfiguredModelRef(apiConfig, params);
        if (!modelRef) {
          throw new Error("No configured model ref available for summary generation");
        }

        const slashIndex = modelRef.indexOf("/");
        if (slashIndex <= 0 || slashIndex === modelRef.length - 1) {
          throw new Error(`Configured model ref is not provider-scoped: ${modelRef}`);
        }
        const providerId = modelRef.slice(0, slashIndex);
        const modelId = modelRef.slice(slashIndex + 1);
        const providerConfig = apiConfig?.models?.providers?.[providerId];
        if (!providerConfig || typeof providerConfig !== "object") {
          throw new Error(`No provider config found for ${providerId}`);
        }

        const baseUrl = this.resolveConfiguredBaseUrl(providerConfig);
        const apiKey = this.resolveConfiguredApiKey(providerConfig);
        const api = typeof providerConfig.api === "string" ? providerConfig.api : "anthropic-messages";
        if (!baseUrl || !apiKey) {
          throw new Error(`Provider ${providerId} is missing baseUrl or apiKey`);
        }

        if (api !== "anthropic-messages") {
          throw new Error(`Configured summary fallback only supports anthropic-messages, got ${api}`);
        }

        const endpoint = baseUrl.endsWith("/v1/messages")
          ? baseUrl
          : `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: params.maxOutputTokens ?? 256,
            temperature: params.temperature ?? 0,
            thinking: { type: "disabled" },
            messages: [{ role: "user", content: params.prompt }],
          }),
        });
        const json = await response.json();
        if (!response.ok) {
          throw new Error(`Configured provider call failed: ${response.status} ${JSON.stringify(json).slice(0, 400)}`);
        }
        return json;
      },
    };
  }

  private resolvePreferredConfiguredModelRef(
    apiConfig: HostConfigLike,
    params: LlmCallParams,
  ): string | null {
    const requested = this.resolveRequestedModelRef(params);
    const configuredModelRefs = this.collectConfiguredModelRefs(apiConfig);
    const defaultModelRef = this.resolveDefaultModelRef(apiConfig);
    const candidates = [
      requested,
      defaultModelRef,
      ...this.resolveFallbackModelRefs(apiConfig),
      ...configuredModelRefs,
    ].filter((value, index, list): value is string =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      list.indexOf(value) === index,
    );

    const requestedMatch = this.resolveRequestedConfiguredModelRef(
      requested,
      configuredModelRefs,
      defaultModelRef,
      apiConfig,
    );
    if (requestedMatch) {
      return requestedMatch;
    }

    const firstConfigured = candidates.find((candidate) =>
      this.hasConfiguredProvider(apiConfig, candidate),
    );
    return firstConfigured ?? candidates[0] ?? null;
  }

  private resolveRequestedModelRef(params: LlmCallParams): string | null {
    if (typeof params.model === "string" && params.model.trim().length > 0) {
      return params.model.trim();
    }
    return null;
  }

  private resolveDefaultModelRef(apiConfig: HostConfigLike): string | null {
    const primary = apiConfig?.agents?.defaults?.model?.primary;
    return typeof primary === "string" && primary.trim().length > 0
      ? primary.trim()
      : null;
  }

  private resolveFallbackModelRefs(apiConfig: HostConfigLike): string[] {
    const fallbacks = apiConfig?.agents?.defaults?.model?.fallbacks;
    if (!Array.isArray(fallbacks)) {
      return [];
    }
    return fallbacks
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private collectConfiguredModelRefs(apiConfig: HostConfigLike): string[] {
    const declaredRefs = apiConfig?.agents?.defaults?.models;
    const refs = declaredRefs && typeof declaredRefs === "object"
      ? Object.keys(declaredRefs)
      : [];
    return refs
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private resolveProviderId(modelRef: string): string | null {
    const slashIndex = modelRef.indexOf("/");
    if (slashIndex <= 0) {
      return null;
    }
    return modelRef.slice(0, slashIndex);
  }

  private stripProviderId(modelRef: string): string {
    const slashIndex = modelRef.indexOf("/");
    return slashIndex <= 0 ? modelRef.trim() : modelRef.slice(slashIndex + 1).trim();
  }

  private hasConfiguredProvider(apiConfig: HostConfigLike, modelRef: string): boolean {
    const providerId = this.resolveProviderId(modelRef);
    if (!providerId) {
      return false;
    }
    const providerConfig = apiConfig?.models?.providers?.[providerId];
    return Boolean(providerConfig && typeof providerConfig === "object");
  }

  private resolveRequestedConfiguredModelRef(
    requested: string | null,
    configuredModelRefs: string[],
    defaultModelRef: string | null,
    apiConfig: HostConfigLike,
  ): string | null {
    if (!requested) {
      return null;
    }

    if (this.hasConfiguredProvider(apiConfig, requested)) {
      return requested;
    }

    const requestedModelId = this.stripProviderId(requested);
    if (defaultModelRef &&
      this.stripProviderId(defaultModelRef) === requestedModelId &&
      this.hasConfiguredProvider(apiConfig, defaultModelRef)
    ) {
      return defaultModelRef;
    }

    const matchingConfiguredRefs = configuredModelRefs.filter(
      (candidate) =>
        this.stripProviderId(candidate) === requestedModelId &&
        this.hasConfiguredProvider(apiConfig, candidate),
    );
    if (matchingConfiguredRefs.length > 0) {
      return matchingConfiguredRefs[0];
    }

    const configuredProviderIds = Object.keys(apiConfig?.models?.providers ?? {})
      .filter((providerId) => providerId.trim().length > 0);
    const inferredProviderId =
      this.resolveProviderId(defaultModelRef ?? "") ??
      (configuredProviderIds.length === 1 ? configuredProviderIds[0] : null);
    if (inferredProviderId) {
      const inferredRef = `${inferredProviderId}/${requestedModelId}`;
      if (this.hasConfiguredProvider(apiConfig, inferredRef)) {
        return inferredRef;
      }
    }

    return null;
  }

  private resolveConfiguredBaseUrl(providerConfig: HostProviderConfig): string | null {
    return typeof providerConfig?.baseUrl === "string" && providerConfig.baseUrl.trim()
      ? providerConfig.baseUrl.trim()
      : null;
  }

  private resolveConfiguredApiKey(providerConfig: HostProviderConfig): string | null {
    const apiKey = providerConfig?.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      return null;
    }
    return apiKey.trim();
  }

  private extractTextResult(result: unknown): string | null {
    if (!result || typeof result !== "object") {
      return null;
    }

    const resultRecord = result as Record<string, unknown>;
    if (typeof resultRecord.text === "string" && resultRecord.text.trim()) {
      return resultRecord.text;
    }

    if (
      typeof resultRecord.output_text === "string" &&
      resultRecord.output_text.trim()
    ) {
      return resultRecord.output_text;
    }

    if (Array.isArray(resultRecord.content)) {
      const text = resultRecord.content
        .flatMap((part) => {
          if (typeof part === "string") {
            return [part];
          }
          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            return [(part as { text: string }).text];
          }
          return [];
        })
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join("\n");
      return text || null;
    }

    return null;
  }
}
