import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EvidenceAtomEngine } from "../engines/EvidenceAtomEngine";
import { EvidenceAtomStore } from "../stores/EvidenceAtomStore";
import { SummaryEntry } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-evidence-atoms-"));
  try {
    const store = new EvidenceAtomStore(dir, "agent-1");
    await store.init();
    const summary: SummaryEntry = {
      id: "summary-1",
      sessionId: "session-1",
      agentId: "agent-1",
      summary: "Tool outputs are scratch-only and should not become durable memory.",
      keywords: ["tool", "scratch", "durable memory"],
      toneTag: "neutral",
      constraints: ["Tool results are scratch-only and must be dropped during compaction unless promoted into a sourced fact."],
      decisions: ["Level-1 summaries are substrate material and do not enter the model context by default."],
      blockers: [],
      nextSteps: ["Use evidence atoms as the smallest retrieval unit before expanding to source spans."],
      exactFacts: ["Recent tail keeps 5%-10% of the model window, clamped to 1-10 turns."],
      startTurn: 1,
      endTurn: 4,
      sourceMessageIds: ["m-1", "m-2"],
      sourceBinding: {
        scope: "agent",
        sessionId: "session-1",
        agentId: "agent-1",
        messageIds: ["m-1", "m-2"],
      },
      tokenCount: 64,
      createdAt: "2026-04-26T00:00:00.000Z",
      sourceHash: "hash-1",
      sourceMessageCount: 2,
      quality: {
        confidence: 0.91,
        sourceTraceComplete: true,
        unresolvedConflicts: 0,
        needsHumanReview: false,
        generatedBy: "test",
      },
      coverage: {
        sourceTokenEstimate: 100,
        summaryTokenEstimate: 25,
        compressionRatio: 0.25,
      },
    };

    const atoms = new EvidenceAtomEngine().fromSummary(summary);
    await store.upsertMany(atoms);

    const hit = store.search("scratch-only tool results compaction", { sessionId: "session-1", limit: 3 })[0];
    assert(hit?.type === "constraint", "expected constraint atom to be retrieved first");
    assert(hit.atomStatus === "candidate", "expected default candidate atom status");
    assert(hit.sourceTraceComplete === true, "expected atom to inherit complete source trace");
    assert(hit.confidence === 0.91, "expected atom to inherit summary quality confidence");
    assert(hit.stability > 0.8, "expected constraint atom with complete trace to be stable");
    assert(hit.sourceSummaryId === "summary-1", "expected atom to retain parent summary id");
    assert(hit.sourceMessageIds?.length === 2, "expected atom to keep source message ids for traceback");

    const reloaded = new EvidenceAtomStore(dir, "agent-1");
    await reloaded.init();
    assert(reloaded.search("Level-1 summaries substrate", { sessionId: "session-1" }).length > 0, "expected persisted atoms to reload from disk");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-evidence-atom-store passed");
}

void main();
