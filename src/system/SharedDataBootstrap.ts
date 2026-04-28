import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { LoggerLike } from "../types";

const STRUCTURE_DOC = `# ChaunyOMS Shared Data Structure

This directory stores runtime-managed shared data for ChaunyOMS.

- knowledge-base/: human-readable export corpus; it is mirrored into SQLite for runtime lookup and is not scanned on the hot path
- global-principles/: shared principles that may be injected at runtime; do not put project knowledge or private preferences here
- plugin-cache/: runtime cache for plugin-local generated support files
`;

export class SharedDataBootstrap {
  constructor(private readonly logger: LoggerLike) {}

  async ensure(sharedDataDir: string): Promise<void> {
    await mkdir(sharedDataDir, { recursive: true });

    await Promise.all([
      this.ensureDir(path.join(sharedDataDir, "knowledge-base")),
      this.ensureDir(path.join(sharedDataDir, "global-principles")),
      this.ensureDir(path.join(sharedDataDir, "plugin-cache")),
    ]);

    await Promise.all([
      this.ensureFile(path.join(sharedDataDir, "STRUCTURE.md"), STRUCTURE_DOC),
      this.ensureFile(path.join(sharedDataDir, "global-principles", "PRINCIPLES.md"), "# Global Principles\n\n"),
      this.ensureFile(path.join(sharedDataDir, "knowledge-base", "topic-index.json"), "{\n  \"topics\": []\n}\n"),
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
      this.logger.info("shared_data_file_created", { filePath });
    }
  }
}
