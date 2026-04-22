import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ObservationEntry } from "../types";

export class ObservationStore {
  private readonly filePath: string;
  private readonly observations: ObservationEntry[] = [];

  constructor(private readonly baseDir: string, private readonly sessionId: string) {
    this.filePath = path.join(baseDir, `${sessionId}.observations.jsonl`);
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    try {
      const content = await readFile(this.filePath, "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      this.observations.length = 0;
      for (const line of lines) {
        this.observations.push(JSON.parse(line) as ObservationEntry);
      }
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async append(entry: ObservationEntry): Promise<void> {
    if (this.observations.some((item) => item.id === entry.id || item.sourceKey === entry.sourceKey)) {
      return;
    }

    this.observations.push(entry);
    await this.flush();
  }

  getAll(): ObservationEntry[] {
    return [...this.observations];
  }

  count(): number {
    return this.observations.length;
  }

  private async flush(): Promise<void> {
    const serialized = this.observations.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(this.filePath, serialized.length > 0 ? `${serialized}\n` : "", "utf8");
  }
}
