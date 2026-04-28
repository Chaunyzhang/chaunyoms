import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RecallResolver } from "../resolvers/RecallResolver";
import { MemoryRetrievalRouter, RouteContext } from "../routing/MemoryRetrievalRouter";
import { RawMessageStore } from "../stores/RawMessageStore";
import { SummaryIndexStore } from "../stores/SummaryIndexStore";
import { RawMessage, RetrievalRoute, SummaryEntry } from "../types";
import { hashRawMessages } from "../utils/integrity";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const baseContext: RouteContext = {
  hasCompactedHistory: true,
};

const fixtures: Array<{
  name: string;
  query: string;
  context?: Partial<RouteContext>;
  route: RetrievalRoute;
}> = [
  { name: "empty query", query: "", route: "recent_tail" },
  { name: "exact Chinese source recall", query: "找一下原文参数", route: "summary_tree" },
  { name: "English historical recall", query: "what happened earlier with the gateway?", route: "summary_tree" },
  { name: "generic status no longer implies project registry", query: "当前状态是什么", context: { hasProjectRegistry: true }, route: "recent_tail" },
  { name: "current project next step", query: "this project next step", context: { hasProjectRegistry: true }, route: "project_registry" },
  { name: "MemoryItem constraint", query: "what constraint config must we remember?", context: { hasMemoryItemHits: true }, route: "memory_item" },
  { name: "MemoryItem rule", query: "remember the rule", context: { hasMemoryItemHits: true }, route: "memory_item" },
  { name: "current exact fact prefers MemoryItem", query: "what is the current exact queue_window now", context: { hasMemoryItemHits: true }, route: "memory_item" },
  { name: "knowledge hit", query: "knowledge base architecture docs", context: { hasKnowledgeHits: true }, route: "knowledge" },
  { name: "knowledge advisory hit", query: "从经验和最佳实践角度想想 queue retry", context: { hasKnowledgeHits: true }, route: "knowledge" },
  { name: "exact source recall beats advisory knowledge", query: "想想之前 exact gateway port 是多少", context: { hasKnowledgeHits: true }, route: "summary_tree" },
  { name: "raw knowledge", query: "raw knowledge in knowledge base", route: "knowledge" },
  { name: "knowledge fuzzy stays in unified knowledge", query: "knowledge base something related", context: { hasKnowledgeHits: false }, route: "knowledge" },
  { name: "generic how-to with governed knowledge hit stays local", query: "How should queue workers back off after failures?", context: { hasKnowledgeHits: true }, route: "recent_tail" },
  { name: "knowledge unified miss", query: "知识库里有没有资料", context: { hasKnowledgeHits: false }, route: "knowledge" },
  { name: "navigation no longer owns current work without project registry", query: "current task plan risk", route: "recent_tail" },
  { name: "project registry beats navigation", query: "current task plan risk", context: { hasProjectRegistry: true }, route: "project_registry" },
  { name: "MemoryItem terms without hits", query: "constraint config", context: { hasMemoryItemHits: false }, route: "summary_tree" },
  { name: "plain recent", query: "hello there", context: { hasCompactedHistory: false }, route: "recent_tail" },
  { name: "generic fuzzy stays tail", query: "find something related", context: { hasCompactedHistory: false }, route: "recent_tail" },
  { name: "knowledge raw hint", query: "knowledge base docs", context: { hasKnowledgeRawHint: true, hasKnowledgeHits: false }, route: "knowledge" },
  { name: "project state without registry stays recent", query: "current task plan next action", route: "recent_tail" },
];

function raw(overrides: Partial<RawMessage> & Pick<RawMessage, "id" | "sessionId" | "content" | "turnNumber">): RawMessage {
  return {
    role: "user",
    createdAt: new Date().toISOString(),
    tokenCount: 4,
    compacted: false,
    ...overrides,
  };
}

async function assertRecallSourceTrace(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-recall-fixture-"));
  try {
    const rawStore = new RawMessageStore(dir, "agent");
    const summaryStore = new SummaryIndexStore(dir, "agent");
    await rawStore.init();
    await summaryStore.init();

    await rawStore.append(raw({
      id: "s1-u1",
      sessionId: "session-1",
      agentId: "agent",
      turnNumber: 1,
      content: "Gateway port must stay 15432.",
    }));
    await rawStore.append(raw({
      id: "s2-u1",
      sessionId: "session-2",
      agentId: "agent",
      turnNumber: 1,
      content: "Gateway port must stay 9999 in another session.",
    }));

    const sourceMessages = rawStore.getAll({ sessionId: "session-1" });
    const sourceHash = hashRawMessages(sourceMessages);
    const summary: SummaryEntry = {
      id: "summary-session-1",
      sessionId: "session-1",
      agentId: "agent",
      summary: "Gateway port must stay 15432.",
      keywords: ["gateway", "port", "15432"],
      toneTag: "fixture",
      constraints: ["Gateway port must stay 15432."],
      decisions: [],
      blockers: [],
      exactFacts: ["15432"],
      startTurn: 1,
      endTurn: 1,
      sourceMessageIds: sourceMessages.map((message) => message.id),
      sourceSequenceMin: sourceMessages[0].sequence,
      sourceSequenceMax: sourceMessages.at(-1)?.sequence,
      sourceHash,
      sourceMessageCount: sourceMessages.length,
      tokenCount: 6,
      createdAt: new Date().toISOString(),
    };
    await summaryStore.addSummary(summary);

    const result = new RecallResolver().resolve("exact gateway port 15432", summaryStore, rawStore, 100);
    assert(result.items.length === 1, "expected recall to return one source message");
    assert(result.items[0].content.includes("15432"), "expected session-1 source content");
    assert(!result.items[0].content.includes("9999"), "expected recall not to cross session");
    assert(result.sourceTrace.length === 1, "expected one source trace");
    assert(result.sourceTrace[0].verified === true, "expected verified source trace");
    assert(result.sourceTrace[0].strategy === "message_ids", "expected message-id source strategy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const router = new MemoryRetrievalRouter();
  for (const fixture of fixtures) {
    const context = {
      ...baseContext,
      ...(fixture.context ?? {}),
    };
    const decision = router.decide(fixture.query, context);
    assert(
      decision.route === fixture.route,
      `${fixture.name}: expected ${fixture.route}, got ${decision.route}`,
    );
    assert(
      Array.isArray(decision.layerScores) && decision.layerScores.length > 0,
      `${fixture.name}: expected layer scores`,
    );
    const layerScores = decision.layerScores ?? [];
    assert(
      layerScores.some((score) => score.route === decision.route),
      `${fixture.name}: expected selected route to appear in layer scores`,
    );
  }

  await assertRecallSourceTrace();
  console.log("test-retrieval-router-fixtures passed");
}

void main();
