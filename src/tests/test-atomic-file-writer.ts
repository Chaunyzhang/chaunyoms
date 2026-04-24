import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { atomicWriteFile } from "../utils/atomicFile";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-atomic-write-"));
  try {
    const filePath = path.join(dir, "state.json");
    await Promise.all([
      atomicWriteFile(filePath, JSON.stringify({ value: 1 })),
      atomicWriteFile(filePath, JSON.stringify({ value: 2 })),
      atomicWriteFile(filePath, JSON.stringify({ value: 3 })),
    ]);

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { value?: number };
    assert(typeof parsed.value === "number", "expected a complete JSON payload after queued atomic writes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-atomic-file-writer passed");
}

void main();
