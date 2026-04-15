import path from "node:path";

import { BridgeConfig, LlmCallParams, LlmCaller, LoggerLike } from "../types";

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  dataDir: path.join(process.cwd(), ".chaunyoms"),
  sessionId: "default-session",
  workspaceDir: path.join(
    process.env.USERPROFILE ?? "C:\\Users\\28227",
    ".openclaw",
    "workspace",
  ),
  sharedDataDir: "C:\\openclaw-data",
  contextWindow: 32000,
  contextThreshold: 0.75,
  freshTailTokens: 6000,
  maxFreshTailTurns: 8,
  compactionBatchTurns: 12,
  summaryMaxOutputTokens: 300,
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
    private readonly api: any,
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
      return typeof result === "string" ? result : JSON.stringify(result);
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
      target: any;
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

    return null;
  }
}
