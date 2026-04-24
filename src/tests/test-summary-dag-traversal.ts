import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RecallResolver } from "../resolvers/RecallResolver";
import { SummaryDagResolver } from "../resolvers/SummaryDagResolver";
import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import { RawMessage, SummaryEntry } from "../types";
import { hashRawMessages } from "../utils/integrity";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function raw(id: string, sessionId: string, turnNumber: number, content: string): RawMessage {
  return {
    id,
    sessionId,
    agentId: "agent-dag",
    role: "user",
    content,
    turnNumber,
    createdAt: new Date().toISOString(),
    tokenCount: 6,
    compacted: false,
  };
}

function leaf(id: string, messages: RawMessage[], overrides: Partial<SummaryEntry>): SummaryEntry {
  const sourceHash = hashRawMessages(messages);
  return {
    id,
    sessionId: messages[0].sessionId,
    agentId: "agent-dag",
    summary: "leaf summary",
    keywords: [],
    toneTag: "fixture",
    constraints: [],
    decisions: [],
    blockers: [],
    exactFacts: [],
    startTurn: messages[0].turnNumber,
    endTurn: messages[messages.length - 1].turnNumber,
    sourceMessageIds: messages.map((message) => message.id),
    sourceSequenceMin: messages[0].sequence,
    sourceSequenceMax: messages[messages.length - 1].sequence,
    summaryLevel: 1,
    nodeKind: "leaf",
    tokenCount: 8,
    createdAt: new Date().toISOString(),
    sourceHash,
    sourceMessageCount: messages.length,
    ...overrides,
  };
}

function branch(id: string, children: SummaryEntry[], summary: string): SummaryEntry {
  return {
    id,
    sessionId: children[0].sessionId,
    agentId: "agent-dag",
    summary,
    keywords: ["gateway", "migration"],
    toneTag: "fixture",
    constraints: [],
    decisions: [],
    blockers: [],
    exactFacts: [],
    startTurn: children[0].startTurn,
    endTurn: children[children.length - 1].endTurn,
    sourceMessageIds: [...new Set(children.flatMap((child) => child.sourceMessageIds ?? []))],
    sourceSummaryIds: children.map((child) => child.id),
    childSummaryIds: children.map((child) => child.id),
    summaryLevel: 2,
    nodeKind: "branch",
    tokenCount: 10,
    createdAt: new Date().toISOString(),
    sourceMessageCount: children.reduce((sum, child) => sum + (child.sourceMessageCount ?? 0), 0),
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-summary-dag-"));
  try {
    const rawStore = new RawMessageStore(dir, "agent-dag");
    const summaryStore = new SummaryIndexStore(dir, "agent-dag");
    await rawStore.init();
    await summaryStore.init();

    const message1 = raw("m-1", "session-dag", 1, "Gateway exact port is 15432.");
    const message2 = raw("m-2", "session-dag", 2, "Cache exact port is 19090.");
    await rawStore.append(message1);
    await rawStore.append(message2);
    const persisted1 = rawStore.getByIds(["m-1"], { sessionId: "session-dag" });
    const persisted2 = rawStore.getByIds(["m-2"], { sessionId: "session-dag" });

    const leafGateway = leaf("leaf-gateway", persisted1, {
      summary: "Gateway port decision.",
      keywords: ["gateway", "port"],
      exactFacts: ["15432"],
      constraints: ["Gateway exact port is 15432."],
    });
    const leafCache = leaf("leaf-cache", persisted2, {
      summary: "Cache port decision.",
      keywords: ["cache", "port"],
      exactFacts: ["19090"],
      constraints: ["Cache exact port is 19090."],
    });
    await summaryStore.addSummary(leafGateway);
    await summaryStore.addSummary(leafCache);

    const branchA = branch("branch-gateway-migration", [leafGateway, leafCache], "Gateway migration branch covering port decisions.");
    const branchB = branch("branch-release-audit", [leafGateway], "Release audit branch also references gateway port evidence.");
    await summaryStore.addSummary(branchA);
    await summaryStore.addSummary(branchB);
    await summaryStore.attachParent(branchA.id, [leafGateway.id, leafCache.id]);
    await summaryStore.attachParent(branchB.id, [leafGateway.id]);

    const storedGateway = summaryStore.getAllSummaries({ sessionId: "session-dag" }).find((summary) => summary.id === leafGateway.id);
    assert(storedGateway?.parentSummaryId === branchA.id, "expected legacy first parent to remain stable");
    assert(storedGateway?.parentSummaryIds?.includes(branchA.id), "expected first parent in parentSummaryIds");
    assert(storedGateway?.parentSummaryIds?.includes(branchB.id), "expected second parent in parentSummaryIds");

    const traversal = new SummaryDagResolver().resolve("gateway exact port 15432", summaryStore, { sessionId: "session-dag" });
    assert(traversal.summaries[0]?.id === leafGateway.id, "expected DAG traversal to drill down to gateway leaf");
    assert(
      traversal.trace.some((step) => step.action === "root_candidate" && step.summaryId === branchA.id),
      "expected traversal trace to start from matching branch",
    );
    assert(
      traversal.trace.some((step) => step.action === "leaf_selected" && step.summaryId === leafGateway.id),
      "expected traversal trace to select matching leaf",
    );

    const recall = new RecallResolver().resolve("gateway exact port 15432", summaryStore, rawStore, 100);
    assert(recall.items.length === 1, "expected recall to return precise gateway source only");
    assert(recall.items[0].content.includes("15432"), "expected gateway raw message");
    assert(!recall.items[0].content.includes("19090"), "expected recall not to include sibling leaf source");
    assert(recall.dagTrace.some((step) => step.summaryId === leafGateway.id), "expected recall to expose DAG trace");
    assert(recall.sourceTrace[0]?.verified === true, "expected source trace verification");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-summary-dag-traversal passed");
}

void main();
