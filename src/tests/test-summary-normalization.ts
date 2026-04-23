import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SummaryIndexStore } from "../stores/SummaryIndexStore";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-summary-normalize-"));
  const store = new SummaryIndexStore(dir, "normalize-session");
  await store.init();

  await store.addSummary({
    id: "summary-1",
    sessionId: "normalize-session",
    summary: "Structured node",
    keywords: ["project", "state"],
    toneTag: "focused",
    memoryType: "project_state",
    phase: "Implementation" as never,
    constraints: [],
    decisions: [],
    blockers: [],
    nextSteps: ["ship it"],
    keyEntities: ["app.ts"],
    exactFacts: [],
    promotionIntent: "candidate",
    startTurn: 1,
    endTurn: 2,
    tokenCount: 12,
    createdAt: new Date().toISOString(),
  });

  await store.addSummary({
    id: "summary-2",
    sessionId: "normalize-session",
    summary: "Weird phase node",
    keywords: ["project"],
    toneTag: "focused",
    memoryType: "project_state",
    phase: "phase-unknown" as never,
    constraints: [],
    decisions: [],
    blockers: [],
    nextSteps: [],
    keyEntities: [],
    exactFacts: [],
    promotionIntent: "candidate",
    startTurn: 3,
    endTurn: 4,
    tokenCount: 12,
    createdAt: new Date().toISOString(),
  });

  const summaries = store.getAllSummaries();
  assert(summaries[0]?.phase === "implementation", "expected known phase to normalize to lowercase canonical value");
  assert(typeof summaries[1]?.phase === "undefined", "expected unknown phase to be dropped during normalization");

  await rm(dir, { recursive: true, force: true });
  console.log("test-summary-normalization passed");
}

void main();
