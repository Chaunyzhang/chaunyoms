import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StablePrefixStore } from "../src/stores/StablePrefixStore";

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-stable-prefix-"));
  const workspaceDir = path.join(dir, "workspace");
  const memoryDir = path.join(workspaceDir, "memory");
  const sharedDataDir = path.join(dir, "openclaw-data");
  const kbDir = path.join(sharedDataDir, "knowledge-base");
  const insightsDir = path.join(sharedDataDir, "shared-insights");
  const cognitionDir = path.join(sharedDataDir, "shared-cognition");

  await mkdir(memoryDir, { recursive: true });
  await mkdir(kbDir, { recursive: true });
  await mkdir(insightsDir, { recursive: true });
  await mkdir(cognitionDir, { recursive: true });

  const navigationFiles: string[] = [];
  for (let i = 1; i <= 35; i += 1) {
    const fileName = `2026-03-${String(i).padStart(2, "0")}.md`;
    navigationFiles.push(fileName);
    await writeFile(path.join(memoryDir, fileName), `- nav ${i}\n`, "utf8");
  }

  await writeFile(path.join(cognitionDir, "COGNITION.md"), "Shared cognition", "utf8");
  await writeFile(path.join(insightsDir, "insight-index.json"), "{\n  \"topics\": []\n}\n", "utf8");
  await writeFile(path.join(kbDir, "topic-index.json"), "{\n  \"topics\": []\n}\n", "utf8");
  await writeFile(path.join(kbDir, "memory-architecture-v3.md"), "chaunyoms architecture details", "utf8");

  const store = new StablePrefixStore();
  await store.load(sharedDataDir, workspaceDir, 4096);

  const filesAfterCleanup = await readdir(memoryDir);
  const navAfterCleanup = filesAfterCleanup.filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file));
  if (navAfterCleanup.length !== 30) {
    throw new Error(`Navigation retention cleanup failed: expected 30 files, got ${navAfterCleanup.length}`);
  }
  if (navAfterCleanup.includes("2026-03-01.md")) {
    throw new Error("Navigation retention cleanup failed: oldest file should be removed");
  }

  const kbHit = await store.getKnowledgeBaseHit(sharedDataDir, "architecture details");
  if (!kbHit || !kbHit.filePath?.endsWith("memory-architecture-v3.md")) {
    throw new Error("Knowledge-base source document fallback failed");
  }

  await writeFile(
    path.join(memoryDir, "2026-04-02-12-30.md"),
    [
      "2026-04-02:",
      "- active: shipping the plugin rollout",
      "- decision: keep tools disabled by default",
      "- todo: verify runtime fallback compaction",
      "- next: run the safest smoke test first",
      "- pending: decide when to enable tools",
      "- blocker: none recorded",
      "- recall: summary:test turns 1-4",
    ].join("\n"),
    "utf8",
  );

  const stateHit = await store.getNavigationStateHit(workspaceDir, "what should we do next");
  if (!stateHit || !stateHit.content.includes("- next: run the safest smoke test first")) {
    throw new Error("Navigation state prioritization failed");
  }

  await rm(dir, { recursive: true, force: true });
  console.log("test-stable-prefix passed");
}

void main();
