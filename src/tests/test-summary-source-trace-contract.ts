import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import { RawMessage, SummaryEntry } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const logger = { info(): void {}, warn(): void {}, error(): void {} };

function message(id: string, turnNumber: number, content: string): RawMessage {
  return {
    id,
    sessionId: "summary-trace-session",
    agentId: "agent-summary-trace",
    role: "user",
    content,
    turnNumber,
    sequence: turnNumber,
    createdAt: "2026-04-29T00:00:00.000Z",
    tokenCount: 8,
    compacted: false,
  };
}

function summary(id: string, overrides: Partial<SummaryEntry> = {}): SummaryEntry {
  return {
    id,
    sessionId: "summary-trace-session",
    agentId: "agent-summary-trace",
    summary: id,
    keywords: [id],
    toneTag: "fixture",
    constraints: [],
    decisions: [],
    blockers: [],
    exactFacts: [],
    startTurn: 1,
    endTurn: 1,
    summaryLevel: 1,
    nodeKind: "leaf",
    tokenCount: 8,
    createdAt: "2026-04-29T00:00:01.000Z",
    ...overrides,
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-summary-trace-"));
  try {
    const store = new SQLiteRuntimeStore({
      dbPath: path.join(dir, "runtime.sqlite"),
      agentId: "agent-summary-trace",
      knowledgeBaseDir: path.join(dir, "knowledge"),
      logger,
    });
    const raw = [message("trace-m-1", 1, "The source-backed summary has raw provenance.")];
    const leaf = summary("trace-leaf-1", {
      sourceMessageIds: ["trace-m-1"],
      sourceBinding: {
        scope: "session",
        sessionId: "summary-trace-session",
        agentId: "agent-summary-trace",
        messageIds: ["trace-m-1"],
      },
      sourceHash: "trace-hash",
      sourceMessageCount: 1,
    });
    const branch = summary("trace-branch-1", {
      summaryLevel: 2,
      nodeKind: "branch",
      childSummaryIds: ["trace-leaf-1"],
      sourceSummaryIds: ["trace-leaf-1"],
      sourceMessageCount: 1,
    });
    const navigationOnly = summary("trace-nav-only", {
      summary: "This summary intentionally lacks source trace and is only a navigation hint.",
    });
    await store.mirror({ messages: raw, summaries: [leaf, branch, navigationOnly], memories: [], atoms: [] });

    const report = store.inspectSummarySourceTrace({ sessionId: "summary-trace-session" });
    assert(!report.ok, "source-less summary should make summarySourceTrace.ok false");
    assert(report.baseSummaries.total === 2, "expected two BaseSummary records");
    assert(report.baseSummaries.traceable === 1, "source-backed BaseSummary should trace to raw");
    assert(report.baseSummaries.missing.includes("trace-nav-only"), "source-less BaseSummary should be navigation-only");
    assert(report.branchSummaries.total === 1, "expected one BranchSummary");
    assert(report.branchSummaries.traceable === 1, "BranchSummary should trace through child to raw");
    assert(report.navigationOnlySummaryIds.includes("trace-nav-only"), "navigation-only id should be reported");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-summary-source-trace-contract passed");
}

void main();
