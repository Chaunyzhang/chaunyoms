import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export class RuntimeStatsLogStore {
  constructor(private readonly dataDir: string) {}

  async append(sessionId: string, stats: Record<string, unknown>): Promise<void> {
    const logDir = path.join(this.dataDir, "logs");
    await mkdir(logDir, { recursive: true });
    await appendFile(
      path.join(logDir, `${sessionId}.after-turn.log`),
      `${JSON.stringify(stats)}\n`,
      "utf8",
    );
  }
}
