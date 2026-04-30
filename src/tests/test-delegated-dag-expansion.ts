import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RecallResolver } from "../resolvers/RecallResolver";
import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import { LlmCaller, RawMessage, SummaryEntry } from "../types";
import { hashRawMessages } from "../utils/integrity";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function raw(turnNumber: number, content: string): RawMessage {
  return {
    id: `delegated-m-${turnNumber}`,
    sessionId: "delegated-dag-session",
    agentId: "delegated-agent",
    role: "user",
    content,
    turnNumber,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, turnNumber)).toISOString(),
    tokenCount: 8,
    compacted: true,
  };
}

function leaf(id: string, messages: RawMessage[], exactFact: string): SummaryEntry {
  return {
    id,
    sessionId: "delegated-dag-session",
    agentId: "delegated-agent",
    summary: `Leaf summary containing ${exactFact}`,
    keywords: ["delegated", exactFact],
    toneTag: "fixture",
    constraints: [],
    decisions: [],
    blockers: [],
    exactFacts: [exactFact],
    startTurn: messages[0].turnNumber,
    endTurn: messages.at(-1)?.turnNumber ?? messages[0].turnNumber,
    sourceMessageIds: messages.map((message) => message.id),
    summaryLevel: 1,
    nodeKind: "leaf",
    tokenCount: 8,
    createdAt: new Date().toISOString(),
    sourceHash: hashRawMessages(messages),
    sourceMessageCount: messages.length,
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-delegated-dag-"));
  try {
    const rawStore = new RawMessageStore(dir, "delegated-agent");
    const summaryStore = new SummaryIndexStore(dir, "delegated-agent");
    await rawStore.init();
    await summaryStore.init();

    const targetMessages = [raw(10, "Target source: AGENTIC_DAG_TOKEN=YES")];
    const distractorMessages = [raw(20, "Distractor source: AGENTIC_DAG_TOKEN=NO")];
    for (const message of [...targetMessages, ...distractorMessages]) {
      await rawStore.append(message);
    }
    await summaryStore.addSummary(leaf("leaf-target", targetMessages, "AGENTIC_DAG_TOKEN=YES"));
    await summaryStore.addSummary(leaf("leaf-distractor", distractorMessages, "AGENTIC_DAG_TOKEN=NO"));

    const llmCaller: LlmCaller = {
      async call(params) {
        assert(params.prompt.includes("leaf-target"), "expected delegated prompt to include candidate ids");
        return JSON.stringify({ selectedSummaryIds: ["leaf-target"], reason: "target exact fact" });
      },
    };

    const result = await new RecallResolver().resolveAsync(
      "Where is AGENTIC_DAG_TOKEN YES?",
      summaryStore,
      rawStore,
      100,
      {
        sessionId: "delegated-dag-session",
        allowRawFirst: false,
        requireRawSource: true,
        dagExpansion: {
          mode: "delegated_agent",
          agentProvider: "llm",
          fallbackMode: "deterministic",
          llmCaller,
          timeoutMs: 1000,
        },
      },
    );

    assert(result.dagExpansion?.executedMode === "delegated_agent", "expected delegated execution");
    assert(result.dagExpansion?.selectedSummaryIds.includes("leaf-target"), "expected selected target summary id");
    assert(result.items.some((item) => item.content.includes("AGENTIC_DAG_TOKEN=YES")), "expected raw target source");
    assert(result.items.every((item) => !item.content.includes("AGENTIC_DAG_TOKEN=NO")), "expected no distractor source");
    assert(result.sourceTrace.some((trace) => trace.verified), "expected verified raw source trace");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-delegated-dag-expansion passed");
}

void main();
