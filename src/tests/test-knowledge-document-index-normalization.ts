import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KnowledgeMarkdownStore } from "../stores/KnowledgeMarkdownStore";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-kb-index-normalize-"));
  const indexesDir = path.join(dir, "indexes");
  await mkdir(indexesDir, { recursive: true });
  await mkdir(path.join(dir, "decisions"), { recursive: true });
  await mkdir(path.join(dir, "patterns"), { recursive: true });
  await mkdir(path.join(dir, "facts"), { recursive: true });
  await mkdir(path.join(dir, "incidents"), { recursive: true });

  await writeFile(
    path.join(indexesDir, "document-index.json"),
    JSON.stringify({
      schemaVersion: 1,
      documents: [
        {
          docId: "legacy-doc",
          slug: "legacy-doc",
          bucket: "facts",
          title: "Legacy Doc",
          latestVersion: 1,
          latestFile: "legacy-doc-v1.md",
          summary: "Legacy index entry without array metadata",
          canonicalKey: "legacy-doc",
          origin: "synthesized",
          status: "active",
          updatedAt: "2026-04-24T00:00:00.000Z",
          versions: [
            {
              version: 1,
              docId: "legacy-doc",
              fileName: "legacy-doc-v1.md",
              createdAt: "2026-04-24T00:00:00.000Z",
              contentHash: "abc",
              summaryEntryId: "summary-1",
            },
          ],
        },
      ],
    }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(indexesDir, "promotion-ledger.json"),
    JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2),
    "utf8",
  );

  const store = new KnowledgeMarkdownStore(dir);
  await store.init();
  const hits = store.searchRelatedDocuments("legacy doc", 1);
  assert(hits.length === 1, "expected normalized legacy entry to remain searchable");
  assert(Array.isArray(hits[0]?.tags), "expected tags to be normalized to an array");
  assert(Array.isArray(hits[0]?.sourceRefs), "expected sourceRefs to be normalized to an array");

  await rm(dir, { recursive: true, force: true });
  console.log("test-knowledge-document-index-normalization passed");
}

void main();
