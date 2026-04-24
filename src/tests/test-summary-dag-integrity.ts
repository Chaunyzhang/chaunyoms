import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SummaryDagIntegrityInspector } from "../resolvers/SummaryDagIntegrityInspector";
import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import { RawMessage, SummaryEntry } from "../types";
import { hashRawMessages } from "../utils/integrity";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function raw(id: string, turnNumber: number, content: string): RawMessage {
  return {
    id,
    sessionId: "dag-integrity-session",
    agentId: "agent-integrity",
    role: "user",
    content,
    turnNumber,
    createdAt: new Date().toISOString(),
    tokenCount: 5,
    compacted: false,
  };
}

function summary(id: string, messages: RawMessage[], overrides: Partial<SummaryEntry> = {}): SummaryEntry {
  const sourceHash = hashRawMessages(messages);
  return {
    id,
    sessionId: "dag-integrity-session",
    agentId: "agent-integrity",
    summary: id,
    keywords: [id],
    toneTag: "fixture",
    constraints: [],
    decisions: [],
    blockers: [],
    exactFacts: [],
    startTurn: messages[0]?.turnNumber ?? 1,
    endTurn: messages.at(-1)?.turnNumber ?? 1,
    sourceMessageIds: messages.map((message) => message.id),
    sourceSequenceMin: messages[0]?.sequence,
    sourceSequenceMax: messages.at(-1)?.sequence,
    summaryLevel: 1,
    nodeKind: "leaf",
    tokenCount: 5,
    createdAt: new Date().toISOString(),
    sourceHash,
    sourceMessageCount: messages.length,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-dag-integrity-"));
  try {
    const rawStore = new RawMessageStore(dir, "agent-integrity");
    const summaryStore = new SummaryIndexStore(dir, "agent-integrity");
    await rawStore.init();
    await summaryStore.init();

    await rawStore.append(raw("m-1", 1, "The gateway port is 15432."));
    await rawStore.append(raw("m-2", 2, "The cache port is 19090."));
    const m1 = rawStore.getByIds(["m-1"], { sessionId: "dag-integrity-session" });
    const m2 = rawStore.getByIds(["m-2"], { sessionId: "dag-integrity-session" });

    const leaf1 = summary("leaf-1", m1, { exactFacts: ["15432"] });
    const leaf2 = summary("leaf-2", m2, { exactFacts: ["19090"] });
    await summaryStore.addSummary(leaf1);
    await summaryStore.addSummary(leaf2);
    const branch = summary("branch-1", [...m1, ...m2], {
      summaryLevel: 2,
      nodeKind: "branch",
      sourceHash: undefined,
      sourceSummaryIds: [leaf1.id, leaf2.id],
      childSummaryIds: [leaf1.id, leaf2.id],
      sourceMessageIds: [...new Set([...m1, ...m2].map((message) => message.id))],
      sourceMessageCount: 2,
    });
    await summaryStore.addSummary(branch);
    await summaryStore.attachParent(branch.id, [leaf1.id, leaf2.id]);

    const okReport = new SummaryDagIntegrityInspector().inspect(summaryStore, rawStore, {
      sessionId: "dag-integrity-session",
    });
    assert(okReport.ok, `expected valid DAG, got ${JSON.stringify(okReport.issues)}`);
    assert(okReport.branchCount === 1, "expected one branch");
    assert(okReport.leafCount === 2, "expected two leaves");

    const broken = summary("broken-leaf", m1, {
      sourceMessageIds: ["missing-message"],
      sourceHash: "not-real",
    });
    await summaryStore.addSummary(broken);
    const brokenReport = new SummaryDagIntegrityInspector().inspect(summaryStore, rawStore, {
      sessionId: "dag-integrity-session",
    });
    assert(!brokenReport.ok, "expected broken DAG report");
    assert(
      brokenReport.issues.some((issue) => issue.code === "source_integrity_mismatch"),
      "expected source integrity issue",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-summary-dag-integrity passed");
}

void main();
