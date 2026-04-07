import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RawMessageStore } from "../src/stores/RawMessageStore";

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-raw-"));
  const store = new RawMessageStore(dir, "test-session");
  await store.init();

  for (let index = 1; index <= 20; index += 1) {
    await store.append({
      id: `msg-${index}`,
      sessionId: "test-session",
      role: index % 2 === 0 ? "assistant" : "user",
      content: `Message ${index}`,
      turnNumber: Math.ceil(index / 2),
      createdAt: new Date().toISOString(),
      tokenCount: 5,
      compacted: false,
    });
  }

  await store.markCompacted(1, 5);

  if (store.getByRange(1, 3).length !== 6) {
    throw new Error("Range read failed");
  }

  if (store.getRecentTail(2).length !== 4) {
    throw new Error("Recent tail read failed");
  }

  if (store.getRecentTailByTokens(20, 2).length !== 4) {
    throw new Error("Token-based recent tail read failed");
  }

  if (store.totalUncompactedTokens() !== 50) {
    throw new Error("Uncompacted token accounting failed");
  }

  await rm(dir, { recursive: true, force: true });
  console.log("test-raw-store passed");
}

void main();
