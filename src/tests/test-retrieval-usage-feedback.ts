import { mkdtemp, rm } from "node:fs/promises";

import os from "node:os";

import path from "node:path";



import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";

import { ContextPlanner } from "../engines/ContextPlanner";

import { MemoryItemDraftEntry, RawMessage } from "../types";



function assert(condition: unknown, message: string): void {

  if (!condition) {

    throw new Error(message);

  }

}



const logger = { info(): void {}, warn(): void {}, error(): void {} };



async function main(): Promise<void> {

  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-usage-feedback-"));

  try {

    const store = new SQLiteRuntimeStore({

      dbPath: path.join(dir, "runtime.sqlite"),

      agentId: "agent-usage",

      knowledgeBaseDir: path.join(dir, "knowledge"),

      logger,

    });

    const messages: RawMessage[] = [{

      id: "m-usage",

      sessionId: "s-usage",

      agentId: "agent-usage",

      role: "user",

      content: "The recall port is 15432.",

      turnNumber: 1,

      sequence: 1,

      createdAt: "2026-04-28T00:00:00.000Z",

      tokenCount: 7,

      compacted: false,

    }];

    const memories: MemoryItemDraftEntry[] = [{

      id: "memory-usage",

      sessionId: "s-usage",

      agentId: "agent-usage",

      kind: "constraint",

      recordStatus: "active",

      text: "Use recall port 15432.",

      fingerprint: "fp-usage",

      tags: ["recall"],

      createdAt: "2026-04-28T00:00:01.000Z",

      sourceType: "raw_message",

      sourceIds: ["m-usage"],

      metadata: { factKey: "recall_port", factValue: "15432" },

    }];

    await store.mirror({ messages, summaries: [], memories, atoms: [] });

    const planner = new ContextPlanner();

    const plan = planner.plan([

      planner.buildCandidate({

        kind: "summary",

        tokenCount: 8,

        content: "Use recall port 15432.",

        metadata: { memoryId: "memory-usage", sourceVerified: true },

      }, "active_memory", 0),

    ], { budget: 20, runId: "usage-run-1", createdAt: "2026-04-28T00:00:02.000Z" });

    store.recordContextPlan({

      sessionId: "s-usage",

      agentId: "agent-usage",

      totalBudget: 20,

      intent: "memory_retrieve",

      plan,

      metadata: {

        query: "what recall port",

        route: "memory_item",

        retrievalStrength: "high",

        usageFeedbackEnabled: true,

        answerUsed: true,

        verifiedAnswerUsed: true,

      },

    });



    store.recordContextPlan({

      sessionId: "s-usage",

      agentId: "agent-usage",

      totalBudget: 20,

      intent: "memory_retrieve",

      plan,

      metadata: {

        query: "what recall port",

        route: "memory_item",

        retrievalStrength: "high",

        usageFeedbackEnabled: true,

        answerUsed: true,

        verifiedAnswerUsed: true,

      },

    });

    const stats = store.listRetrievalUsageStats({ targetKind: "memory_item", targetId: "memory-item:memory-usage", agentId: "agent-usage" })[0];

    assert(stats.candidateSeenCount === 1, "candidate_seen should be idempotently materialized from context plan");

    assert(stats.contextSelectedCount === 1, "context_selected should be materialized from context plan");

    assert(stats.verifiedAnswerUsedCount === 1, "verified_answer_used should be materialized when answer used with source verification");

    assert(stats.authorityUsageScore > stats.decayedUsageScore, "source-verified usage should carry stronger authority score");



    store.recordRetrievalUsageEvents([{

      eventType: "negative_feedback",

      targetKind: "memory_item",

      targetId: "memory-item:memory-usage",

      sessionId: "s-usage",

      agentId: "agent-usage",

      query: "wrong recall",

      route: "memory_item",

      retrievalStrength: "medium",

    }]);

    const updated = store.listRetrievalUsageStats({ targetKind: "memory_item", targetId: "memory-item:memory-usage", agentId: "agent-usage" })[0];

    assert(updated.negativeFeedbackCount === 1, "negative_feedback should be counted");

    const defaultItem = store.listMemoryItems({ agentId: "agent-usage" }).find((entry) => entry.id === "memory-item:memory-usage");

    assert(!defaultItem?.metadata?.retrievalUsage, "MemoryItem default listing should not pay usage-stats lookup cost");

    const item = store.listMemoryItems({ agentId: "agent-usage", includeRetrievalUsage: true }).find((entry) => entry.id === "memory-item:memory-usage");

    assert(Boolean(item?.metadata?.retrievalUsage), "MemoryItem list should attach retrievalUsage stats as metadata");



    store.recordRetrievalUsageEvents([{

      eventType: "verified_answer_used",

      targetKind: "memory_item",

      targetId: "memory-item:decay-demo",

      sessionId: "s-usage",

      agentId: "agent-usage",

      query: "decay first",

      sourceVerified: true,

      answerUsed: true,

      createdAt: "2026-01-01T00:00:00.000Z",

    }, {

      eventType: "verified_answer_used",

      targetKind: "memory_item",

      targetId: "memory-item:decay-demo",

      sessionId: "s-usage",

      agentId: "agent-usage",

      query: "decay second",

      sourceVerified: true,

      answerUsed: true,

      createdAt: "2026-03-02T00:00:00.000Z",

    }]);

    const decayed = store.listRetrievalUsageStats({ targetKind: "memory_item", targetId: "memory-item:decay-demo", agentId: "agent-usage" })[0];

    assert(decayed.verifiedAnswerUsedCount === 2, "decay must not erase usage counts");

    assert(decayed.decayedUsageScore > 2 && decayed.decayedUsageScore < 3, "decayed usage score should half-life old recall weight instead of accumulating forever");

  } finally {

    await rm(dir, { recursive: true, force: true });

  }

  console.log("test-retrieval-usage-feedback passed");

}



void main();
