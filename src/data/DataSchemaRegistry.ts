import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface DataSchemaRegistryFileV1 {
  schemaVersion: 1;
  stores: Record<string, number>;
}

const CURRENT_STORE_VERSIONS: Record<string, number> = {
  raw_messages: 2,
  summaries: 2,
  observations: 1,
  durable_memory: 2,
  knowledge_raw: 1,
  knowledge_markdown: 1,
};

export class DataSchemaRegistry {
  private readonly filePath: string;
  private registry: DataSchemaRegistryFileV1 = {
    schemaVersion: 1,
    stores: {},
  };

  constructor(private readonly baseDir: string) {
    this.filePath = path.join(baseDir, "_schema-registry.json");
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as DataSchemaRegistryFileV1;
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.schemaVersion === 1 &&
        parsed.stores &&
        typeof parsed.stores === "object"
      ) {
        this.registry = parsed;
        return;
      }
    } catch {}

    await this.flush();
  }

  async ensureCurrentVersions(): Promise<Array<{ storeKey: string; from: number; to: number }>> {
    const upgraded: Array<{ storeKey: string; from: number; to: number }> = [];

    for (const pending of this.getPendingUpgrades()) {
      this.registry.stores[pending.storeKey] = pending.to;
      upgraded.push(pending);
    }

    if (upgraded.length > 0) {
      await this.flush();
    }

    return upgraded;
  }

  getPendingUpgrades(): Array<{ storeKey: string; from: number; to: number }> {
    const upgraded: Array<{ storeKey: string; from: number; to: number }> = [];

    for (const [storeKey, to] of Object.entries(CURRENT_STORE_VERSIONS)) {
      const from = Number(this.registry.stores[storeKey] ?? 0);
      if (from === to) {
        continue;
      }
      upgraded.push({ storeKey, from, to });
    }

    return upgraded;
  }

  getFilePath(): string {
    return this.filePath;
  }

  private async flush(): Promise<void> {
    await writeFile(this.filePath, JSON.stringify(this.registry, null, 2), "utf8");
  }
}
