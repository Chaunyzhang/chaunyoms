import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SummaryIndexStore } from "../src/stores/SummaryIndexStore";

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-summary-"));
  const store = new SummaryIndexStore(dir, "test-session");
  await store.init();

  await store.addSummary({
    id: "summary-1",
    sessionId: "test-session",
    summary: "Discussed API migration and token budget.",
    keywords: ["api", "migration", "budget"],
    toneTag: "focused",
    startTurn: 1,
    endTurn: 10,
    tokenCount: 12,
    createdAt: new Date().toISOString(),
  });

  if (store.search("migration").length !== 1) {
    throw new Error("Keyword search failed");
  }

  if (store.getTotalTokens() !== 12) {
    throw new Error("Summary token accounting failed");
  }

  const persisted = JSON.parse(
    await readFile(path.join(dir, "test-session.summaries.json"), "utf8"),
  ) as { schemaVersion?: number; summaries?: unknown[] };
  if (persisted.schemaVersion !== 1 || !Array.isArray(persisted.summaries)) {
    throw new Error("Summary persistence should write schemaVersion=1 wrapper");
  }

  const legacyDir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-summary-legacy-"));
  await writeFile(
    path.join(legacyDir, "legacy-session.summaries.json"),
    JSON.stringify([
      {
        id: "summary-legacy",
        sessionId: "legacy-session",
        summary: "Legacy format summary",
        keywords: ["legacy"],
        toneTag: "neutral",
        startTurn: 1,
        endTurn: 2,
        tokenCount: 3,
        createdAt: new Date().toISOString(),
      },
    ]),
    "utf8",
  );
  const legacyStore = new SummaryIndexStore(legacyDir, "legacy-session");
  await legacyStore.init();
  if (legacyStore.getAllSummaries().length !== 1) {
    throw new Error("Legacy summary persistence should remain readable");
  }

  await rm(dir, { recursive: true, force: true });
  await rm(legacyDir, { recursive: true, force: true });
  console.log("test-summary-store passed");
}

void main();
