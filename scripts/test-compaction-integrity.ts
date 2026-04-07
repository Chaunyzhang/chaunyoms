import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CompactionEngine } from "../src/engines/CompactionEngine";
import { RawMessageStore } from "../src/stores/RawMessageStore";
import { SummaryIndexStore } from "../src/stores/SummaryIndexStore";
import { hashRawMessages } from "../src/utils/integrity";

const logger = {
  info(): void {},
  warn(): void {},
  error(): void {},
};

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-compaction-integrity-"));
  const sessionId = "test-session";
  const rawStore = new RawMessageStore(dir, sessionId);
  const summaryStore = new SummaryIndexStore(dir, sessionId);
  const engine = new CompactionEngine(null, logger);

  await rawStore.init();
  await summaryStore.init();

  for (let turn = 1; turn <= 10; turn += 1) {
    await rawStore.append({
      id: `u-${turn}`,
      sessionId,
      role: "user",
      content: `User ${turn}`,
      turnNumber: turn,
      createdAt: new Date().toISOString(),
      tokenCount: 40,
      compacted: false,
    });
    await rawStore.append({
      id: `a-${turn}`,
      sessionId,
      role: "assistant",
      content: `Assistant ${turn}`,
      turnNumber: turn,
      createdAt: new Date().toISOString(),
      tokenCount: 40,
      compacted: false,
    });
  }

  const entry = await engine.runCompaction(
    rawStore,
    summaryStore,
    400,
    0.75,
    120,
    3,
    undefined,
    300,
    sessionId,
    6,
  );

  if (!entry) {
    throw new Error("Expected compaction entry");
  }

  if (!entry.sourceHash || typeof entry.sourceMessageCount !== "number") {
    throw new Error("Missing summary integrity fields");
  }

  const rangeMessages = rawStore.getByRange(entry.startTurn, entry.endTurn);
  const expectedHash = hashRawMessages(rangeMessages);
  if (entry.sourceHash !== expectedHash || entry.sourceMessageCount !== rangeMessages.length) {
    throw new Error("Summary integrity hash mismatch");
  }

  await rm(dir, { recursive: true, force: true });
  console.log("test-compaction-integrity passed");
}

void main();
