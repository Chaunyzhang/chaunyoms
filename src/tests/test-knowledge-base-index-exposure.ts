import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StablePrefixStore } from "../stores/StablePrefixStore";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function hasKnowledgeBaseIndex(items: Array<{ metadata?: Record<string, unknown> }>): boolean {
  return items.some((item) => item.metadata?.layer === "knowledge_base_index");
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-kb-exposure-"));
  const sharedDataDir = path.join(dir, "shared");
  const workspaceDir = path.join(dir, "workspace");
  const knowledgeBaseDir = path.join(sharedDataDir, "knowledge-base");

  await mkdir(knowledgeBaseDir, { recursive: true });
  await mkdir(path.join(workspaceDir, "memory"), { recursive: true });

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
    activeQuery: "继续修当前 bug，把测试补上。",
  });
  assert(
    !hasKnowledgeBaseIndex(nonDocQuery),
    "expected knowledge base index to stay hidden for non-reference work",
  );

  const explicitDocQuery = await store.load(sharedDataDir, workspaceDir, 200, {
    activeQuery: "看一下知识库里的架构文档",
  });
  assert(
    hasKnowledgeBaseIndex(explicitDocQuery),
    "expected knowledge base index to appear for explicit document queries",
  );

  const topicLookupQuery = await store.load(sharedDataDir, workspaceDir, 200, {
    activeQuery: "找一下 queue retry policy",
  });
  assert(
    hasKnowledgeBaseIndex(topicLookupQuery),
    "expected knowledge base index to appear for topic lookup queries with index hits",
  );

  const topicOnlyQuery = await store.load(sharedDataDir, workspaceDir, 200, {
    activeQuery: "queue retry policy 怎么改",
  });
  assert(
    !hasKnowledgeBaseIndex(topicOnlyQuery),
    "expected knowledge base index to stay hidden when only the topic name is mentioned without doc-seeking intent",
  );

  await rm(dir, { recursive: true, force: true });
  console.log("test-knowledge-base-index-exposure passed");
}

void main();
