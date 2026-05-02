import { BridgeConfig } from "../types";
import { HostRecord, OpenClawApiLike, isHostRecord } from "./OpenClawHostTypes";

export class OpenClawModelResolver {
  constructor(private readonly getApi: () => OpenClawApiLike | undefined) {}

  resolveHostModelContextWindow(payloadModel: unknown): number | null {
    const api = this.getApi();
    const configCandidates = [
      api?.config,
      api?.context?.config,
      api?.runtime?.config,
    ].filter((config): config is NonNullable<typeof config> => isHostRecord(config));
    const modelRefs = [
      this.resolveModelRefCandidate(payloadModel),
      this.resolveModelRefCandidate(api?.context?.model),
      this.resolveModelRefCandidate(api?.runtime?.model),
      ...configCandidates.map((config) => {
        const primary = config?.agents?.defaults?.model?.primary;
        return typeof primary === "string" && primary.trim().length > 0
          ? primary.trim()
          : undefined;
      }),
    ].filter((value, index, list): value is string =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      list.indexOf(value) === index,
    );

    for (const modelRef of modelRefs) {
      for (const config of configCandidates) {
        const fromDeclaredModel = this.resolveDeclaredModelContextWindow(config, modelRef);
        if (fromDeclaredModel !== null) {
          return fromDeclaredModel;
        }

        const fromProviderModel = this.resolveProviderModelContextWindow(config, modelRef);
        if (fromProviderModel !== null) {
          return fromProviderModel;
        }
      }
    }

    return null;
  }

  resolveSummaryModel(payloadModel: unknown, config: BridgeConfig): string | undefined {
    const payloadModelRef = this.resolveModelRefCandidate(payloadModel);
    if (payloadModelRef) {
      return payloadModelRef;
    }

    const contextModel = this.getApi()?.context?.model;
    const contextModelRef = this.resolveModelRefCandidate(contextModel);
    if (contextModelRef) {
      return contextModelRef;
    }

    const runtimeModel = this.getApi()?.runtime?.model;
    const runtimeModelRef = this.resolveModelRefCandidate(runtimeModel);
    if (runtimeModelRef) {
      return runtimeModelRef;
    }

    const configuredPrimaryModel = this.resolveConfiguredPrimaryModelRef();
    if (configuredPrimaryModel) {
      return configuredPrimaryModel;
    }

    if (typeof config.summaryModel === "string" && config.summaryModel.trim()) {
      return config.summaryModel;
    }

    return undefined;
  }

  resolveConfiguredPrimaryModelRef(): string | undefined {
    const configCandidates = [
      this.getApi()?.config,
      this.getApi()?.context?.config,
      this.getApi()?.runtime?.config,
    ].filter((candidate): candidate is NonNullable<typeof candidate> => isHostRecord(candidate));

    for (const candidate of configCandidates) {
      const primary = candidate?.agents?.defaults?.model?.primary;
      if (typeof primary === "string" && primary.trim().length > 0) {
        return primary.trim();
      }
    }

    return undefined;
  }

  resolveModelRefCandidate(value: unknown): string | undefined {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const directRefCandidates = [
      candidate.ref,
      candidate.modelRef,
      candidate.fullRef,
      candidate.name,
    ];
    for (const directRef of directRefCandidates) {
      if (
        typeof directRef === "string" &&
        directRef.trim().length > 0 &&
        directRef.includes("/")
      ) {
        return directRef.trim();
      }
    }

    const provider =
      typeof candidate.provider === "string" && candidate.provider.trim().length > 0
        ? candidate.provider.trim()
        : typeof candidate.providerId === "string" && candidate.providerId.trim().length > 0
          ? candidate.providerId.trim()
          : undefined;
    const modelId =
      typeof candidate.id === "string" && candidate.id.trim().length > 0
        ? candidate.id.trim()
        : typeof candidate.model === "string" && candidate.model.trim().length > 0
          ? candidate.model.trim()
          : typeof candidate.name === "string" && candidate.name.trim().length > 0
            ? candidate.name.trim()
            : undefined;

    if (provider && modelId) {
      return `${provider}/${modelId}`;
    }

    return modelId;
  }

  private resolveDeclaredModelContextWindow(
    config: HostRecord,
    modelRef: string,
  ): number | null {
    const defaults = config.agents;
    if (!isHostRecord(defaults)) {
      return null;
    }
    const agentsDefaults = defaults.defaults;
    if (!isHostRecord(agentsDefaults)) {
      return null;
    }
    const models = agentsDefaults.models;
    if (!isHostRecord(models)) {
      return null;
    }

    const modelConfig = models[modelRef] ?? models[this.stripProviderId(modelRef)];
    return this.resolveContextWindowFromRecord(modelConfig);
  }

  private resolveProviderModelContextWindow(
    config: HostRecord,
    modelRef: string,
  ): number | null {
    const providerId = this.resolveProviderId(modelRef);
    if (!providerId) {
      return null;
    }
    const modelId = this.stripProviderId(modelRef);
    const modelsConfig = config.models;
    if (!isHostRecord(modelsConfig)) {
      return null;
    }
    const providers = modelsConfig.providers;
    if (!isHostRecord(providers)) {
      return null;
    }
    const providerConfig = providers[providerId];
    if (!isHostRecord(providerConfig)) {
      return null;
    }
    const providerModels = providerConfig.models;
    if (!Array.isArray(providerModels)) {
      return this.resolveContextWindowFromRecord(providerConfig);
    }

    const matched = providerModels.find((entry) => {
      if (!isHostRecord(entry)) {
        return false;
      }
      const ids = [
        entry.id,
        entry.name,
        entry.model,
        entry.ref,
        entry.modelRef,
        entry.fullRef,
      ].filter((value): value is string => typeof value === "string");
      return ids.some((id) =>
        id.trim() === modelId ||
        id.trim() === modelRef ||
        `${providerId}/${id.trim()}` === modelRef,
      );
    });

    return this.resolveContextWindowFromRecord(matched);
  }

  private resolveContextWindowFromRecord(value: unknown): number | null {
    if (!isHostRecord(value)) {
      return null;
    }
    return this.resolvePositiveNumber([
      value.contextWindow,
      value.context_window,
      value.maxContextWindow,
      value.maxContextTokens,
      value.contextLength,
      value.maxInputTokens,
    ]);
  }

  private resolvePositiveNumber(candidates: unknown[]): number | null {
    for (const candidate of candidates) {
      const value = typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && candidate.trim().length > 0
          ? Number(candidate)
          : Number.NaN;
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return null;
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
}
