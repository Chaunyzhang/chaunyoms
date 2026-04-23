import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KnowledgeMarkdownStore } from "../stores/KnowledgeMarkdownStore";
import { SummaryEntry } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function buildSummary(): SummaryEntry {
  return {
    id: "summary-1",
    sessionId: "session-1",
    agentId: "agent-1",
    summary: "Retry policy was standardized for worker jobs.",
    keywords: ["retry", "worker", "policy"],
    toneTag: "neutral",
    constraints: ["avoid duplicate side effects"],
    decisions: ["use capped exponential backoff"],
    blockers: [],
    exactFacts: ["max retry attempts is 5"],
    startTurn: 1,
    endTurn: 4,
    tokenCount: 32,
    createdAt: new Date().toISOString(),
    sourceHash: "hash-1",
    sourceMessageCount: 4,
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-knowledge-store-"));
  const store = new KnowledgeMarkdownStore(dir);
  await store.init();

  const summary = buildSummary();
  const result = await store.writePromotion(
    summary,
    {
      shouldWrite: true,
      reason: "durable_retry_policy",
      bucket: "patterns",
      slug: "worker-retry-policy",
      title: "Worker Retry Policy",
      summary: "Standard retry behavior for worker jobs.",
      tags: ["retry", "workers"],
      canonicalKey: "worker-retry-policy",
      body: "# Worker Retry Policy\n\n## Canonical knowledge\n\nUse capped exponential backoff with five attempts.\n",
      status: "active",
    },
    {
      sessionId: summary.sessionId,
      sourceHash: summary.sourceHash,
      sourceMessageCount: summary.sourceMessageCount,
      promptVersion: "test-v1",
      modelName: "test-model",
    },
  );

  assert(result.status === "promoted", "expected knowledge promotion to write a document");
  assert(result.docId, "expected promoted document to have a doc id");
  const record = await store.getById(result.docId as string);
  assert(record, "expected getById to return the promoted document");
  assert(record?.entry.origin === "synthesized", "expected promoted knowledge to record synthesized origin");
  assert(record?.entry.linkedSummaryIds.includes(summary.id), "expected promoted document to link back to the source summary");
  assert(record?.entry.sourceRefs.some((value) => value.includes("session:session-1:turns:1-4")), "expected promoted document to keep a source reference");

  const versions = store.listVersions("worker-retry-policy");
  assert(versions.length === 1, "expected exactly one document version");

  await store.linkToSummary(result.docId as string, "summary-2");
  await store.linkToSource(result.docId as string, "external:retry-guidelines");
  const reconciled = await store.reconcile("worker-retry-policy");
  assert(reconciled?.linkedSummaryIds.includes("summary-2"), "expected reconcile to retain linked summary ids");
  assert(reconciled?.sourceRefs.includes("external:retry-guidelines"), "expected reconcile to retain linked source refs");

  await store.markSuperseded(result.docId as string, "worker-retry-policy-v2");
  const superseded = await store.getById(result.docId as string);
  assert(superseded?.entry.status === "superseded", "expected markSuperseded to update document status");
  assert(superseded?.entry.supersededById === "worker-retry-policy-v2", "expected superseded link to be recorded");

  const trustModel = store.describeTrustModel();
  assert(trustModel.layer === "managed_knowledge", "expected trust model to describe the managed knowledge layer");
  assert(trustModel.requiresProvenance === true, "expected trust model to require provenance");

  await rm(dir, { recursive: true, force: true });
  console.log("test-internal-formal-knowledge-store passed");
}

void main();
