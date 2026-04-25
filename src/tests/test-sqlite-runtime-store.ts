import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import { ContextPlanner } from "../engines/ContextPlanner";
import { DurableMemoryEntry, RawMessage, SummaryEntry } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const logger = {
  info(): void {},
  warn(): void {},
  error(): void {},
};

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-sqlite-runtime-"));
  try {
    const store = new SQLiteRuntimeStore({
      dbPath: path.join(dir, "runtime.sqlite"),
      agentId: "agent-1",
      knowledgeBaseDir: path.join(dir, "knowledge"),
      logger,
    });
    const messages: RawMessage[] = [
      {
        id: "m-1",
        sessionId: "s-1",
        agentId: "agent-1",
        role: "user",
        content: "The deployment port is 15432.",
        turnNumber: 1,
        sequence: 1,
        createdAt: "2026-04-24T00:00:00.000Z",
        tokenCount: 8,
        compacted: true,
      },
      {
        id: "m-2",
        sessionId: "s-1",
        agentId: "agent-1",
        role: "assistant",
        content: "Recorded the deployment port.",
        turnNumber: 1,
        sequence: 2,
        createdAt: "2026-04-24T00:00:01.000Z",
        tokenCount: 6,
        compacted: true,
      },
    ];
    const summaries: SummaryEntry[] = [{
      id: "summary-1",
      sessionId: "s-1",
      agentId: "agent-1",
      summary: "Deployment port is 15432.",
      keywords: ["deployment", "port"],
      toneTag: "neutral",
      constraints: [],
      decisions: [],
      blockers: [],
      exactFacts: ["15432"],
      startTurn: 1,
      endTurn: 1,
      sourceMessageIds: ["m-1", "m-2"],
      sourceBinding: {
        scope: "agent",
        sessionId: "s-1",
        agentId: "agent-1",
        messageIds: ["m-1", "m-2"],
      },
      tokenCount: 6,
      createdAt: "2026-04-24T00:00:02.000Z",
    }];
    const memories: DurableMemoryEntry[] = [{
      id: "memory-1",
      sessionId: "s-1",
      agentId: "agent-1",
      kind: "constraint",
      recordStatus: "active",
      text: "Use deployment port 15432.",
      fingerprint: "fp-1",
      tags: ["deployment"],
      createdAt: "2026-04-24T00:00:03.000Z",
      sourceType: "raw_message",
      sourceIds: ["m-1"],
    }];

    await store.mirror({ messages, summaries, memories });
    assert(store.isEnabled(), "SQLite runtime store should be enabled under Node 24");
    const initialStatus = store.getStatus();
    assert(initialStatus.ftsStatus === "lazy_not_initialized", "FTS should be reported as lazy before first FTS-backed query");
    assert(store.grepMessages("15432", { sessionId: "s-1" }).length === 1, "grep should find raw source message");
    const ftsStatus = store.getStatus();
    assert(ftsStatus.ftsReady === true && ftsStatus.ftsStatus === "ready", "FTS should report ready after grep initializes it");
    assert(store.expand("summary", "summary-1").messages.length === 2, "expand should follow summary source edges to raw messages");
    assert(store.trace("memory", "memory-1").some((edge) => edge.targetId === "m-1"), "trace should expose memory source edge");
    assert(store.replay({ sessionId: "s-1", startTurn: 1, endTurn: 1 }).length === 2, "replay should return turn messages");

    const planner = new ContextPlanner();
    const plan = planner.plan([
      planner.buildCandidate({ kind: "message", tokenCount: 5, role: "user", content: "A" }, "recent_tail", 0),
      planner.buildCandidate({ kind: "message", tokenCount: 5, role: "user", content: "A" }, "recent_tail", 1),
    ], { budget: 20, runId: "run-1", createdAt: "2026-04-24T00:00:04.000Z" });
    store.recordContextPlan({
      sessionId: "s-1",
      agentId: "agent-1",
      totalBudget: 20,
      intent: "test",
      plan,
    });
    assert(store.getLatestContextRuns(1)[0]?.id === "run-1", "context run should be recorded in SQLite");
    const verify = store.verifyIntegrity();
    assert(verify.selectedCandidatesWithoutTarget === 0, "selected runtime context candidates should have synthetic target ids for why/trace");
    const inspect = store.inspectContextRun("run-1");
    assert(inspect.selected.every((candidate) => typeof candidate.targetId === "string" && candidate.targetId.length > 0), "selected candidates should expose target ids");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-sqlite-runtime-store passed");
}

void main();
