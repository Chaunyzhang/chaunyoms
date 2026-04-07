import { mkdtemp, rm } from "node:fs/promises";
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

  await rm(dir, { recursive: true, force: true });
  console.log("test-summary-store passed");
}

void main();
