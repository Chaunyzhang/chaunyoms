import { readFile } from "node:fs/promises";
import path from "node:path";

import { HostFixedContextProvider } from "../types";
import { estimateTokens } from "../utils/tokenizer";

const HOST_BOOTSTRAP_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
] as const;

const MEMORY_STUB_MAX_TOKENS = 96;

export class WorkspaceBootstrapTokenEstimator implements HostFixedContextProvider {
  async estimateWorkspaceBootstrapTokens(workspaceDir: string): Promise<number> {
    let total = 0;

    for (const fileName of HOST_BOOTSTRAP_FILES) {
      const content = await this.readUtf8OrEmpty(path.join(workspaceDir, fileName));
      if (!content.trim()) {
        continue;
      }
      total += estimateTokens(content);
    }

    const memoryContent = await this.readUtf8OrEmpty(path.join(workspaceDir, "MEMORY.md"));
    if (memoryContent.trim() && this.isOmsMemoryStub(memoryContent)) {
      total += Math.min(estimateTokens(memoryContent), MEMORY_STUB_MAX_TOKENS);
    }

    return total;
  }

  private isOmsMemoryStub(content: string): boolean {
    const normalized = content.toLowerCase();
    return normalized.includes("oms") &&
      normalized.includes("memory") &&
      normalized.includes("do not write");
  }

  private async readUtf8OrEmpty(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return "";
    }
  }
}
