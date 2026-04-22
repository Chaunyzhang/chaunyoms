import { readFile } from "node:fs/promises";
import path from "node:path";

import { estimateTokens } from "../utils/tokenizer";

const HOST_BOOTSTRAP_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
  "HEARTBEAT.md",
] as const;

export class HostFixedContextEstimator {
  async estimateWorkspaceBootstrapTokens(workspaceDir: string): Promise<number> {
    let total = 0;

    for (const fileName of HOST_BOOTSTRAP_FILES) {
      const content = await this.readUtf8OrEmpty(path.join(workspaceDir, fileName));
      if (!content.trim()) {
        continue;
      }
      total += estimateTokens(content);
    }

    return total;
  }

  private async readUtf8OrEmpty(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return "";
    }
  }
}
