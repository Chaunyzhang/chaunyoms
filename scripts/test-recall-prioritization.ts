import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RecallResolver } from "../src/resolvers/RecallResolver";
import { RawMessageStore } from "../src/stores/RawMessageStore";
import { SummaryIndexStore } from "../src/stores/SummaryIndexStore";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-recall-priority-"));
  const sessionId = "test-session";
  const rawStore = new RawMessageStore(dir, sessionId);
  const summaryStore = new SummaryIndexStore(dir, sessionId);
  const resolver = new RecallResolver();

  await mkdir(dir, { recursive: true });
  await rawStore.init();
  await summaryStore.init();

  await rawStore.append({
    id: "u-1",
    sessionId,
    role: "user",
    content: "We should avoid enabling tools until the smoke test passes.",
    turnNumber: 1,
    createdAt: new Date().toISOString(),
    tokenCount: 18,
    compacted: false,
  });
  await rawStore.append({
    id: "a-1",
    sessionId,
    role: "assistant",
    content: "Decision recorded: keep tools disabled for now.",
    turnNumber: 1,
    createdAt: new Date().toISOString(),
    tokenCount: 14,
    compacted: false,
  });
  await rawStore.append({
    id: "u-2",
    sessionId,
    role: "user",
    content: "The isolated gateway port is 19021 and we should stay on the chaunyoms-test profile.",
    turnNumber: 2,
    createdAt: new Date().toISOString(),
    tokenCount: 22,
    compacted: false,
  });

  await summaryStore.addSummary({
    id: "summary-1",
    sessionId,
    summary:
      "Constraints: keep tools disabled until smoke test passes. Facts: isolated gateway port is 19021.",
    keywords: ["tools", "smoke", "gateway", "port", "19021"],
    toneTag: "focused",
    startTurn: 1,
    endTurn: 2,
    tokenCount: 20,
    createdAt: new Date().toISOString(),
  });

  const result = resolver.resolve(
    "what exact gateway port did we choose",
    summaryStore,
    rawStore,
    30,
  );

  assert(result.items.length > 0, "expected prioritized recall results");
  assert(
    result.items[0]?.content.includes("19021"),
    "expected most relevant exact-fact message to be recalled first",
  );

  await rm(dir, { recursive: true, force: true });
  console.log("test-recall-prioritization passed");
}

void main();
