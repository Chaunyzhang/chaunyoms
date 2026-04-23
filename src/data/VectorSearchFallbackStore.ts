import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { BridgeConfig, VectorSearchFallbackRepository } from "../types";

export class VectorSearchFallbackStore implements VectorSearchFallbackRepository {
  async search(
    query: string,
    config: Pick<BridgeConfig, "sharedDataDir">,
  ): Promise<{ text: string; source?: string; score?: number } | null> {
    const vectorDir = path.join(config.sharedDataDir, "vector-store");
    let files: string[] = [];
    try {
      files = await readdir(vectorDir);
    } catch {
      return null;
    }

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return null;
    }

    let best: { text: string; source?: string; score?: number } | null = null;
    for (const file of files.filter((item) => /\.(jsonl|json|txt|md)$/i.test(item))) {
      const filePath = path.join(vectorDir, file);
      let body = "";
      try {
        body = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      if (!body.trim()) {
        continue;
      }
      const lower = body.toLowerCase();
      const score = terms.reduce((sum, term) => (lower.includes(term) ? sum + 1 : sum), 0);
      if (score <= 0) {
        continue;
      }
      if (!best || score > (best.score ?? 0)) {
        best = {
          text: body.length > 1200 ? `${body.slice(0, 1200)}...` : body,
          source: filePath,
          score,
        };
      }
    }

    return best;
  }
}
