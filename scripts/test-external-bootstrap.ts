import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ExternalSystemBootstrap } from "../src/system/ExternalSystemBootstrap";

const logger = {
  info(): void {},
  warn(): void {},
  error(): void {},
};

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lossless-lite-external-"));
  const sharedDataDir = path.join(dir, "openclaw-data");
  const bootstrap = new ExternalSystemBootstrap(logger);

  await bootstrap.ensure(sharedDataDir);

  const requiredFiles = [
    path.join(sharedDataDir, "STRUCTURE.md"),
    path.join(sharedDataDir, "shared-cognition", "COGNITION.md"),
    path.join(sharedDataDir, "shared-insights", "insight-index.json"),
    path.join(sharedDataDir, "knowledge-base", "topic-index.json"),
  ];

  for (const filePath of requiredFiles) {
    const content = await readFile(filePath, "utf8");
    if (typeof content !== "string") {
      throw new Error(`Expected readable file: ${filePath}`);
    }
  }

  await rm(dir, { recursive: true, force: true });
  console.log("test-external-bootstrap passed");
}

void main();
