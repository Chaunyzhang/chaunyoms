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

function buildSummary(id: string, summary: string): SummaryEntry {
  return {
    id,
    sessionId: "session-1",
    agentId: "agent-1",
    summary,
    keywords: ["retry", "worker", "backoff"],
    toneTag: "neutral",
    constraints: ["avoid duplicate side effects"],
    decisions: ["use capped exponential backoff"],
    blockers: [],
    exactFacts: ["five retry attempts"],
    startTurn: 1,
    endTurn: 4,
    tokenCount: 32,
    createdAt: new Date().toISOString(),
    sourceHash: `${id}-hash`,
    sourceMessageCount: 4,
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-knowledge-governance-"));
  const store = new KnowledgeMarkdownStore(dir);
  await store.init();

  const summaryA = buildSummary("summary-a", "Retry policy was standardized for worker jobs.");
  const promoted = await store.writePromotion(
    summaryA,
    {
      shouldWrite: true,
      reason: "durable_retry_policy",
      bucket: "patterns",
      slug: "worker-retry-policy",
      title: "Worker Retry Policy",
      summary: "Standard retry behavior for worker jobs.",
      tags: ["retry", "workers"],
      canonicalKey: "worker-retry-policy",
      body: "# Worker Retry Policy\n\nUse capped exponential backoff with five attempts.\n",
      status: "active",
    },
    {
      sessionId: summaryA.sessionId,
      sourceHash: summaryA.sourceHash,
      sourceMessageCount: summaryA.sourceMessageCount,
      promptVersion: "test-v1",
      modelName: "test-model",
    },
  );
  assert(promoted.status === "promoted", "expected first knowledge write to promote");

  const summaryB = buildSummary("summary-b", "Worker jobs should back off with the same retry pattern after failures.");
  const duplicate = await store.writePromotion(
    summaryB,
    {
      shouldWrite: true,
      reason: "same_retry_policy_rephrased",
      bucket: "patterns",
      slug: "jobs-backoff-guideline",
      title: "Jobs Backoff Guideline",
      summary: "Backoff guidance for worker jobs after failures.",
      tags: ["jobs", "backoff"],
      canonicalKey: "jobs-backoff-guideline",
      body: "# Jobs Backoff Guideline\n\nUse capped exponential backoff with five attempts for worker jobs.\n",
      status: "active",
    },
    {
      sessionId: summaryB.sessionId,
      sourceHash: summaryB.sourceHash,
      sourceMessageCount: summaryB.sourceMessageCount,
      promptVersion: "test-v1",
      modelName: "test-model",
    },
  );
  assert(duplicate.status === "duplicate", "expected semantic duplicate detection to reuse the governed record");
  assert(duplicate.docId === promoted.docId, "expected semantic duplicate to point at the original record");

  const reconciled = await store.reconcile("worker-retry-policy");
  assert(reconciled?.linkedSummaryIds.includes("summary-b"), "expected duplicate evidence to link the second summary onto the original record");
  assert(
    reconciled?.sourceRefs.some((value) => value.includes("summary-b-hash")) ??
      reconciled?.sourceRefs.some((value) => value.includes("turns:1-4")),
    "expected duplicate evidence to preserve source provenance",
  );

  const ranked = store.searchRelatedDocuments("How should worker jobs back off after failures?", 1);
  assert(ranked.length === 1, "expected a top ranked knowledge result");
  assert(ranked[0].docId === promoted.docId, "expected active governed knowledge to rank first");

  await rm(dir, { recursive: true, force: true });
  console.log("test-knowledge-governance passed");
}

void main();
