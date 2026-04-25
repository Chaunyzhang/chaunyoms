import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RecallResolver } from "../resolvers/RecallResolver";
import { RawMessageStore } from "../stores/RawMessageStore";
import { RawMessage, SummaryRepository } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function raw(overrides: Partial<RawMessage> & Pick<RawMessage, "id" | "sessionId" | "content" | "turnNumber">): RawMessage {
  return {
    role: "user",
    createdAt: new Date().toISOString(),
    tokenCount: Math.max(8, Math.ceil(overrides.content.length / 5)),
    compacted: false,
    ...overrides,
  };
}

const emptySummaryStore: SummaryRepository = {
  async init() {},
  async addSummary() { return true; },
  async upsertSummary() {},
  getAllSummaries() { return []; },
  getActiveSummaries() { return []; },
  getRootSummaries() { return []; },
  getCoveredTurns() { return new Set<number>(); },
  findBySourceCoverage() { return null; },
  search() { return []; },
  getTotalTokens() { return 0; },
  async attachParent() {},
};

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-history-raw-first-"));
  try {
    const rawStore = new RawMessageStore(dir, "agent");
    await rawStore.init();
    const sessionId = "history-session";

    await rawStore.append(raw({
      id: "moved-duration",
      sessionId,
      turnNumber: 1,
      content: "LoCoMo conv-26 | session_3 date 7:55 pm on 9 June, 2023 | D3:13 | Caroline: I've known these friends for 4 years, since I moved from my home country.",
    }));
    await rawStore.append(raw({
      id: "sweden-source",
      sessionId,
      turnNumber: 2,
      content: "LoCoMo conv-26 | session_4 date 10:37 am on 27 June, 2023 | D4:3 | Caroline: This necklace is a gift from my grandma in my home country, Sweden.",
    }));
    await rawStore.append(raw({
      id: "book-source",
      sessionId,
      turnNumber: 3,
      content: "LoCoMo conv-26 | session_7 date 4:33 pm on 12 July, 2023 | D7:11 | Caroline: I loved \"Becoming Nicole\" by Amy Ellis Nutt. Highly recommend it for sure!",
    }));

    const resolver = new RecallResolver();
    const moveResult = resolver.resolve(
      "History recall: Where did Caroline move from 4 years ago?",
      emptySummaryStore,
      rawStore,
      240,
      { sessionId },
    );
    assert(moveResult.strategy === "raw_first", "expected history QA to use raw-first recall");
    assert(moveResult.dagTrace.length === 0, "expected raw-first success not to invoke DAG traversal");
    assert(
      moveResult.answerCandidates?.some((candidate) => candidate.text === "Sweden" && candidate.sourceVerified),
      "expected source-verified Sweden answer candidate",
    );

    const bookResult = resolver.resolve(
      "History recall: What book did Melanie read from Caroline's suggestion?",
      emptySummaryStore,
      rawStore,
      240,
      { sessionId },
    );
    assert(
      bookResult.answerCandidates?.some((candidate) => candidate.text === "\"Becoming Nicole\""),
      "expected quoted book answer candidate to preserve quotes",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-history-raw-first-recall passed");
}

void main();
