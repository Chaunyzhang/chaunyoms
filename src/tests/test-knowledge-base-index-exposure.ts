import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StablePrefixStore } from "../stores/StablePrefixStore";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function hasLayer(items: Array<{ metadata?: Record<string, unknown> }>, layer: string): boolean {
  return items.some((item) => item.metadata?.layer === layer);
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-kb-exposure-"));
  const sharedDataDir = path.join(dir, "shared");
  const workspaceDir = path.join(dir, "workspace");
  const knowledgeBaseDir = path.join(sharedDataDir, "knowledge-base");
  const principlesDir = path.join(sharedDataDir, "global-principles");

  await mkdir(knowledgeBaseDir, { recursive: true });
  await mkdir(principlesDir, { recursive: true });
  await mkdir(path.join(workspaceDir, "memory"), { recursive: true });

  await writeFile(path.join(principlesDir, "PRINCIPLES.md"), "Only shared principles belong here.\n", "utf8");
  await writeFile(
    path.join(knowledgeBaseDir, "topic-index.json"),
    JSON.stringify(
      {
        topics: [
          {
            topicId: "queue retry policy",
            latestVersion: 2,
            latestFile: "queue-retry-policy-v2.md",
          },
          {
            topicId: "architecture overview",
            latestVersion: 3,
            latestFile: "architecture-overview-v3.md",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const store = new StablePrefixStore();

  const nonDocQuery = await store.load(sharedDataDir, workspaceDir, 200, {
    activeQuery: "continue fixing the current bug and add tests",
  });
  assert(hasLayer(nonDocQuery, "global_principles"), "expected global principles to be available as the only shared runtime prefix");
  assert(!hasLayer(nonDocQuery, "shared_cognition"), "expected legacy shared cognition not to be injected as a broad shared memory layer");
  assert(!hasLayer(nonDocQuery, "knowledge_base_index"), "expected knowledge-base index to stay out of the runtime hot path");

  const explicitDocQuery = await store.load(sharedDataDir, workspaceDir, 200, {
    activeQuery: "review the architecture docs in the knowledge base",
  });
  assert(!hasLayer(explicitDocQuery, "knowledge_base_index"), "expected explicit doc queries to use SQLite retrieval/admin paths, not stable-prefix Markdown injection");

  const topicLookupQuery = await store.load(sharedDataDir, workspaceDir, 200, {
    activeQuery: "find queue retry policy",
  });
  assert(!hasLayer(topicLookupQuery, "knowledge_base_index"), "expected topic lookup queries not to inject Markdown index into model context");

  await rm(dir, { recursive: true, force: true });
  console.log("test-knowledge-base-index-exposure passed");
}

void main();
