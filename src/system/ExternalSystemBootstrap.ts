import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { LoggerLike } from "../types";

const STRUCTURE_DOC = `# OpenClaw Shared Data Structure

This directory stores shared system data outside the agent workspace.

- knowledge-base/: imported/reference knowledge files (read-only by default)
- shared-insights/: shared insight files and insight index
- shared-cognition/: shared cognition injected at runtime
- vector-store/: retrieval index files
- oms-data/: external data area for oms context data
- chaunym-db/: transcript and summary base files
`;

export class ExternalSystemBootstrap {
  constructor(private readonly logger: LoggerLike) {}

  async ensure(sharedDataDir: string): Promise<void> {
    await mkdir(sharedDataDir, { recursive: true });

    await Promise.all([
      this.ensureDir(path.join(sharedDataDir, "knowledge-base")),
      this.ensureDir(path.join(sharedDataDir, "shared-insights")),
      this.ensureDir(path.join(sharedDataDir, "shared-cognition")),
      this.ensureDir(path.join(sharedDataDir, "vector-store")),
      this.ensureDir(path.join(sharedDataDir, "oms-data")),
      this.ensureDir(path.join(sharedDataDir, "chaunym-db")),
      this.ensureDir(path.join(sharedDataDir, "plugin-cache")),
    ]);

    await Promise.all([
      this.ensureFile(path.join(sharedDataDir, "STRUCTURE.md"), STRUCTURE_DOC),
      this.ensureFile(path.join(sharedDataDir, "shared-cognition", "COGNITION.md"), "# Shared Cognition\n\n"),
      this.ensureFile(path.join(sharedDataDir, "shared-insights", "insight-index.json"), "{\n  \"topics\": []\n}\n"),
      this.ensureFile(path.join(sharedDataDir, "knowledge-base", "topic-index.json"), "{\n  \"topics\": []\n}\n"),
      this.ensureFile(path.join(sharedDataDir, "vector-store", ".keep"), ""),
      this.ensureFile(path.join(sharedDataDir, "oms-data", ".keep"), ""),
      this.ensureFile(path.join(sharedDataDir, "chaunym-db", "lcm.db"), ""),
    ]);
  }

  private async ensureDir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
  }

  private async ensureFile(filePath: string, content: string): Promise<void> {
    try {
      await access(filePath);
    } catch {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      this.logger.info("external_system_file_created", { filePath });
    }
  }
}
