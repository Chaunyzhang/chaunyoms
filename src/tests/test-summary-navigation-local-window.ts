import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RecallResolver } from "../resolvers/RecallResolver";
import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import { RawMessage, SummaryEntry } from "../types";
import { hashRawMessages } from "../utils/integrity";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function rawMessage(args: {
  id: string;
  turnNumber: number;
  sequence: number;
  role: RawMessage["role"];
  content: string;
}): RawMessage {
  return {
    id: args.id,
    sessionId: "local-window-session",
    agentId: "agent-local-window",
    role: args.role,
    content: args.content,
    turnNumber: args.turnNumber,
    sequence: args.sequence,
    createdAt: "2026-05-01T00:00:00.000Z",
    tokenCount: 12,
    compacted: false,
  };
}

function summaryEntry(message: RawMessage): SummaryEntry {
  const boundMessages = [message];
  return {
    id: "summary-anchor",
    sessionId: "local-window-session",
    agentId: "agent-local-window",
    summary: "Deployment timeout discussion and retry policy notes.",
    keywords: ["deployment", "timeout", "retry"],
    toneTag: "fixture",
    constraints: [],
    decisions: ["Retry policy still under discussion."],
    blockers: [],
    exactFacts: ["Retry timeout was discussed."],
    startTurn: message.turnNumber,
    endTurn: message.turnNumber,
    sourceMessageIds: boundMessages.map((item) => item.id),
    sourceSequenceMin: message.sequence,
    sourceSequenceMax: message.sequence,
    sourceHash: hashRawMessages(boundMessages),
    sourceMessageCount: boundMessages.length,
    summaryLevel: 1,
    nodeKind: "leaf",
    tokenCount: 24,
    createdAt: "2026-05-01T00:00:01.000Z",
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-local-window-"));
  try {
    const rawStore = new RawMessageStore(dir, "agent");
    const summaryStore = new SummaryIndexStore(dir, "agent");
    await rawStore.init();
    await summaryStore.init();

    const anchor = rawMessage({
      id: "turn-10-user",
      turnNumber: 10,
      sequence: 10,
      role: "user",
      content: "Let's capture the deployment timeout discussion so we can find it later.",
    });
    const answer = rawMessage({
      id: "turn-11-user",
      turnNumber: 11,
      sequence: 11,
      role: "user",
      content: "The retry timeout should be 45 seconds before the next attempt starts.",
    });
    const nearbyNoise = rawMessage({
      id: "turn-12-user",
      turnNumber: 12,
      sequence: 12,
      role: "user",
      content: "We also talked about lunch plans, which should not win the local recall ranking.",
    });

    await rawStore.appendMany?.([anchor, answer, nearbyNoise]);
    await summaryStore.addSummary(summaryEntry(anchor));

    const result = new RecallResolver().resolve(
      "retry timeout 45 seconds",
      summaryStore,
      rawStore,
      200,
      {
        allowRawFirst: false,
        allowWideFallback: false,
        includeSummaryItems: false,
        requireRawSource: true,
      },
    );

    const recalledContents = result.items.map((item) => item.content);
    assert(
      recalledContents.some((content) => content.includes("45 seconds")),
      "expected local raw expansion to include the nearby exact answer message",
    );
    assert(result.sourceTrace.length === 1, "expected one source trace entry");
    assert(
      result.sourceTrace[0].resolvedMessageCount === 1,
      "expected source trace to remain anchored to the original bound message",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-summary-navigation-local-window passed");
}

void main();
