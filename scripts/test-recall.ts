import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RecallResolver } from "../src/resolvers/RecallResolver";
import { RawMessageStore } from "../src/stores/RawMessageStore";
import { SummaryIndexStore } from "../src/stores/SummaryIndexStore";

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lossless-lite-recall-"));
  const rawStore = new RawMessageStore(dir, "test-session");
  const summaryStore = new SummaryIndexStore(dir, "test-session");
  const resolver = new RecallResolver();

  await rawStore.init();
  await summaryStore.init();

  for (let turn = 1; turn <= 6; turn += 1) {
    await rawStore.append({
      id: `msg-${turn}`,
      sessionId: "test-session",
      role: turn % 2 === 0 ? "assistant" : "user",
      content: turn === 3 ? "We agreed on PostgreSQL migration details." : `Message ${turn}`,
      turnNumber: turn,
      createdAt: new Date().toISOString(),
      tokenCount: 12,
      compacted: turn <= 4,
    });
  }

  await summaryStore.addSummary({
    id: "summary-1",
    sessionId: "test-session",
    summary: "Discussed PostgreSQL migration details.",
    keywords: ["postgresql", "migration"],
    toneTag: "focused",
    startTurn: 1,
    endTurn: 4,
    tokenCount: 12,
    createdAt: new Date().toISOString(),
  });

  const result = resolver.resolve("migration", summaryStore, rawStore, 30);
  if (result.items.length === 0) {
    throw new Error("Recall search failed");
  }

  if (result.consumedTokens > 30) {
    throw new Error("Recall budget control failed");
  }

  await rm(dir, { recursive: true, force: true });
  console.log("test-recall passed");
}

void main();
