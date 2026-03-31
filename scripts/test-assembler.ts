import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ContextAssembler } from "../src/engines/ContextAssembler";
import { ContextViewStore } from "../src/stores/ContextViewStore";
import { RawMessageStore } from "../src/stores/RawMessageStore";
import { SummaryIndexStore } from "../src/stores/SummaryIndexStore";

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lossless-lite-assemble-"));
  const rawStore = new RawMessageStore(dir, "test-session");
  const summaryStore = new SummaryIndexStore(dir, "test-session");
  const contextViewStore = new ContextViewStore();
  const assembler = new ContextAssembler(contextViewStore);
  const workspaceDir = dir;
  const sharedDataDir = path.join(dir, "openclaw-data");

  await rawStore.init();
  await summaryStore.init();

  for (let turn = 1; turn <= 50; turn += 1) {
    await rawStore.append({
      id: `u-${turn}`,
      sessionId: "test-session",
      role: "user",
      content: `User turn ${turn}`,
      turnNumber: turn,
      createdAt: new Date().toISOString(),
      tokenCount: 10,
      compacted: turn <= 30,
    });
    await rawStore.append({
      id: `a-${turn}`,
      sessionId: "test-session",
      role: "assistant",
      content: `Assistant turn ${turn}`,
      turnNumber: turn,
      createdAt: new Date().toISOString(),
      tokenCount: 10,
      compacted: turn <= 30,
    });
  }

  for (let index = 1; index <= 3; index += 1) {
    await summaryStore.addSummary({
      id: `summary-${index}`,
      sessionId: "test-session",
      summary: `Summary ${index}`,
      keywords: [`k${index}`],
      toneTag: "neutral",
      startTurn: (index - 1) * 10 + 1,
      endTurn: index * 10,
      tokenCount: 20,
      createdAt: new Date().toISOString(),
    });
  }

  const result = await assembler.assemble(rawStore, summaryStore, 400, 50, 8, sharedDataDir, workspaceDir);
  const used = result.items.reduce((sum, item) => sum + item.tokenCount, 0);

  if (used > result.budget.availableBudget) {
    throw new Error("Budget overflow");
  }

  if (result.items[result.items.length - 1]?.kind !== "message") {
    throw new Error("Recent tail ordering failed");
  }

  await rm(dir, { recursive: true, force: true });
  console.log("test-assembler passed");
}

void main();
