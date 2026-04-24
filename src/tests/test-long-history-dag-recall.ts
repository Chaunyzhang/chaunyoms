import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RecallResolver } from "../resolvers/RecallResolver";
import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import { RawMessage, SummaryEntry } from "../types";
import { hashRawMessages } from "../utils/integrity";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function raw(turnNumber: number, content: string): RawMessage {
  return {
    id: `m-${turnNumber}`,
    sessionId: "long-history-session",
    agentId: "agent-long-history",
    role: "user",
    content,
    turnNumber,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, turnNumber)).toISOString(),
    tokenCount: 8,
    compacted: false,
  };
}

function leaf(id: string, messages: RawMessage[], exactFact: string): SummaryEntry {
  const sourceHash = hashRawMessages(messages);
  return {
    id,
    sessionId: "long-history-session",
    agentId: "agent-long-history",
    summary: `Summary for ${exactFact}`,
    keywords: ["long-history", exactFact],
    toneTag: "fixture",
    constraints: [`Exact fact ${exactFact}`],
    decisions: [],
    blockers: [],
    exactFacts: [exactFact],
    startTurn: messages[0].turnNumber,
    endTurn: messages.at(-1)?.turnNumber ?? messages[0].turnNumber,
    sourceMessageIds: messages.map((message) => message.id),
    sourceSequenceMin: messages[0].sequence,
    sourceSequenceMax: messages.at(-1)?.sequence,
    summaryLevel: 1,
    nodeKind: "leaf",
    tokenCount: 8,
    createdAt: new Date().toISOString(),
    sourceHash,
    sourceMessageCount: messages.length,
  };
}

function branch(id: string, children: SummaryEntry[], label: string, level = 2): SummaryEntry {
  return {
    id,
    sessionId: "long-history-session",
    agentId: "agent-long-history",
    summary: `${label}: ${children.map((child) => child.summary).join("; ")}`,
    keywords: ["long-history", label],
    toneTag: "fixture",
    constraints: children.flatMap((child) => child.constraints),
    decisions: [],
    blockers: [],
    exactFacts: children.flatMap((child) => child.exactFacts),
    startTurn: children[0].startTurn,
    endTurn: children.at(-1)?.endTurn ?? children[0].endTurn,
    sourceMessageIds: [...new Set(children.flatMap((child) => child.sourceMessageIds ?? []))],
    sourceSummaryIds: children.map((child) => child.id),
    childSummaryIds: children.map((child) => child.id),
    summaryLevel: level,
    nodeKind: "branch",
    tokenCount: 12,
    createdAt: new Date().toISOString(),
    sourceMessageCount: children.reduce((sum, child) => sum + (child.sourceMessageCount ?? 0), 0),
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-long-history-"));
  try {
    const rawStore = new RawMessageStore(dir, "agent-long-history");
    const summaryStore = new SummaryIndexStore(dir, "agent-long-history");
    await rawStore.init();
    await summaryStore.init();

    for (let turn = 1; turn <= 120; turn += 1) {
      const marker = turn === 87
        ? "SPECIAL_GATEWAY_TOKEN=ZX-87"
        : `routine-marker-${turn}`;
      await rawStore.append(raw(turn, `Long history turn ${turn}. ${marker}`));
    }

    const leaves: SummaryEntry[] = [];
    for (let start = 1; start <= 120; start += 10) {
      const messages = rawStore.getByRange(start, start + 9, { sessionId: "long-history-session" });
      const exactFact = start <= 87 && 87 <= start + 9
        ? "SPECIAL_GATEWAY_TOKEN=ZX-87"
        : `routine-marker-${start}`;
      const entry = leaf(`leaf-${start}`, messages, exactFact);
      leaves.push(entry);
      await summaryStore.addSummary(entry);
    }

    const branches: SummaryEntry[] = [];
    for (let index = 0; index < leaves.length; index += 3) {
      const group = leaves.slice(index, index + 3);
      const entry = branch(`branch-${index / 3 + 1}`, group, `branch-${index / 3 + 1}`);
      branches.push(entry);
      await summaryStore.addSummary(entry);
      await summaryStore.attachParent(entry.id, group.map((child) => child.id));
    }

    const root = branch("root-long-history", branches, "root long history", 3);
    await summaryStore.addSummary(root);
    await summaryStore.attachParent(root.id, branches.map((child) => child.id));

    const result = new RecallResolver().resolve("exact SPECIAL_GATEWAY_TOKEN ZX-87", summaryStore, rawStore, 200);
    assert(result.items.length > 0, "expected long-history recall hit");
    assert(result.items.some((item) => item.content.includes("SPECIAL_GATEWAY_TOKEN=ZX-87")), "expected exact raw source");
    assert(
      result.items.every((item) => !item.content.includes("routine-marker-1")),
      "expected recall not to dump unrelated sibling history",
    );
    assert(result.dagTrace.some((step) => step.summaryId === "root-long-history"), "expected root traversal trace");
    assert(result.dagTrace.some((step) => step.summaryId === "leaf-81"), "expected target leaf traversal trace");
    assert(result.sourceTrace.some((trace) => trace.verified), "expected verified source trace");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-long-history-dag-recall passed");
}

void main();
