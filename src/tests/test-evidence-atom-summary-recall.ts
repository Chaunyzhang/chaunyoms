import { SummaryNavigationRecallResolver } from "../resolvers/SummaryNavigationRecallResolver";
import {
  RawMessage,
  RawMessageRepository,
  SummaryEntry,
  SummaryRepository,
} from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const message: RawMessage = {
  id: "m-1",
  sessionId: "s-1",
  agentId: "agent-1",
  role: "user",
  content: "工具结果不需要任何保存，压缩的时候就直接删了。",
  turnNumber: 1,
  sequence: 1,
  createdAt: "2026-04-26T00:00:00.000Z",
  tokenCount: 20,
  compacted: true,
};

const summary: SummaryEntry = {
  id: "summary-atom-1",
  sessionId: "s-1",
  agentId: "agent-1",
  summary: "讨论长期记忆底座结构。",
  keywords: ["工具结果", "长期记忆", "压缩"],
  toneTag: "test",
  constraints: ["工具结果默认不作为长期记忆保存，压缩时直接删除。"],
  decisions: ["一级摘要作为底座，不默认进入上下文。"],
  blockers: [],
  nextSteps: [],
  keyEntities: ["工具结果", "一级摘要"],
  exactFacts: ["recent tail 保留 5%-10% 上下文窗口，限制 1-10 轮。"],
  startTurn: 1,
  endTurn: 1,
  sourceMessageIds: ["m-1"],
  sourceBinding: {
    scope: "agent",
    sessionId: "s-1",
    agentId: "agent-1",
    messageIds: ["m-1"],
    turnStart: 1,
    turnEnd: 1,
  },
  tokenCount: 30,
  createdAt: "2026-04-26T00:00:01.000Z",
  sourceMessageCount: 1,
};

const rawStore: RawMessageRepository = {
  async init() {},
  async append() {},
  getAll() { return [message]; },
  getByRange() { return [message]; },
  getByIds() { return [message]; },
  getBySequenceRange() { return [message]; },
  getRecentTail() { return [message]; },
  getRecentTailByTokens() { return [message]; },
  totalUncompactedTokens() { return 0; },
  getUncompactedMessages() { return []; },
  async markCompacted() {},
};

const summaryStore: SummaryRepository = {
  async init() {},
  async addSummary() { return true; },
  async upsertSummary() {},
  getAllSummaries() { return [summary]; },
  getActiveSummaries() { return [summary]; },
  getRootSummaries() { return [summary]; },
  getCoveredTurns() { return new Set([1]); },
  findBySourceCoverage() { return summary; },
  search() { return [summary]; },
  getTotalTokens() { return summary.tokenCount; },
  async attachParent() {},
};

function main(): void {
  const resolver = new SummaryNavigationRecallResolver();
  const result = resolver.resolve(
    "工具结果是否应该作为长期记忆保存？",
    summaryStore,
    rawStore,
    800,
    { sessionId: "s-1" },
  );

  assert(result.items.length === 1, `expected only the matching evidence atom, got ${result.items.length}`);
  assert(result.items[0].metadata?.evidenceAtom === true, "expected evidence atom recall item");
  assert(result.items[0].metadata?.evidenceType === "constraint", "expected constraint atom");
  assert(String(result.items[0].content).includes("工具结果默认不作为长期记忆保存"), "expected constraint text");
  assert(result.sourceTrace.length === 1 && result.sourceTrace[0].verified, "expected source trace to remain available");

  console.log("test-evidence-atom-summary-recall passed");
}

main();
