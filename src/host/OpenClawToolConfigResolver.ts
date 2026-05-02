import { readFileSync } from "node:fs";

import type { LoggerLike } from "../types";
import { getOpenClawConfigPath } from "./HostPathResolver";
import { HostRecord, OpenClawApiLike, isHostRecord } from "./OpenClawHostTypes";
import type { ToolConfigResult } from "./OpenClawPayloadContracts";

export class OpenClawToolConfigResolver {
  constructor(
    private readonly getApi: () => OpenClawApiLike | undefined,
    private readonly getLogger: () => LoggerLike,
  ) {}

  resolveToolConfig(): ToolConfigResult {
    const api = this.getApi();
    const runtimeConfig =
      api?.config ??
      api?.pluginConfig ??
      api?.runtime?.config ??
      api?.context?.config ??
      {};
    const runtimeEnableTools = isHostRecord(runtimeConfig)
      ? runtimeConfig.enableTools
      : undefined;
    if (runtimeEnableTools === true) {
      return {
        enabled: true,
        source: "runtime",
        runtimeEnableTools,
        fileEnableTools: undefined,
      };
    }

    const fileEnableTools = this.readEnableToolsFromOpenClawConfig();
    if (fileEnableTools === true) {
      return {
        enabled: true,
        source: "openclaw_json",
        runtimeEnableTools,
        fileEnableTools,
      };
    }

    return {
      enabled: false,
      source: "disabled",
      runtimeEnableTools,
      fileEnableTools,
    };
  }

  private readEnableToolsFromOpenClawConfig(): unknown {
    try {
      const configPath = getOpenClawConfigPath();
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as HostRecord & {
        plugins?: {
          entries?: {
            oms?: {
              config?: {
                enableTools?: unknown;
              };
            };
          };
        };
      };
      return parsed?.plugins?.entries?.oms?.config?.enableTools;
    } catch (error) {
      this.getLogger().warn("tool_config_file_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
