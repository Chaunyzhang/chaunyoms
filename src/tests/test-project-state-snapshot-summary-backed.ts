import { RawMessage, RawMessageRepository, SummaryEntry, SummaryRepository } from "../types";
import { buildProjectStateSnapshot, formatProjectStateSnapshot } from "../utils/projectState";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const rawMessages: RawMessage[] = [
  {
    id: "live-user",
    sessionId: "session",
    role: "user",
    content: "DO NOT LEAK LIVE RAW: this turn is still available as recent context.",
    turnNumber: 1,
    createdAt: "2026-04-29T00:00:00.000Z",
    tokenCount: 16,
    compacted: false,
  },
];

const summary: SummaryEntry = {
  id: "summary-compressed",
  sessionId: "session",
  summary: "Compressed architecture state: keep prefix projections summary-backed.",
  keywords: ["prefix", "summary"],
  toneTag: "focused",
  constraints: ["do not duplicate live raw turns in prefix"],
  decisions: ["prefix projections are rewritten only from compacted summaries"],
  blockers: [],
  nextSteps: ["assemble dynamic recall after the live tail"],
  exactFacts: [],
  startTurn: 1,
  endTurn: 1,
  tokenCount: 20,
  createdAt: "2026-04-29T00:01:00.000Z",
};

const rawStore: RawMessageRepository = {
  async init() {},
  async append() {},
  getAll() {
    return [...rawMessages];
  },
  getByRange() {
    return [];
  },
  getByIds(ids: string[]) {
    const requested = new Set(ids);
    return rawMessages.filter((message) => requested.has(message.id));
  },
  getBySequenceRange() {
    return [];
  },
  getRecentTail() {
    return [...rawMessages];
  },
  getRecentTailByTokens() {
    return [...rawMessages];
  },
  totalUncompactedTokens() {
    return rawMessages.reduce((sum, message) => sum + message.tokenCount, 0);
  },
  getUncompactedMessages() {
    return [...rawMessages];
  },
  async markCompacted() {},
};

const summaryStore: SummaryRepository = {
  async init() {},
  async addSummary() {
    return true;
  },
  async upsertSummary() {},
  getAllSummaries() {
    return [summary];
  },
  getActiveSummaries() {
    return [summary];
  },
  getRootSummaries() {
    return [summary];
  },
  getCoveredTurns() {
    return new Set<number>([1]);
  },
  findBySourceCoverage() {
    return summary;
  },
  search() {
    return [summary];
  },
  getTotalTokens() {
    return summary.tokenCount;
  },
  async attachParent() {},
};

function main(): void {
  const snapshot = buildProjectStateSnapshot(
    rawStore,
    summaryStore,
    new Date("2026-04-29T00:02:00.000Z"),
  );
  const rendered = formatProjectStateSnapshot(snapshot);

  assert(
    rendered.includes("Compressed architecture state"),
    "expected project-state prefix projection to use compressed summary text",
  );
  assert(
    !rendered.includes("DO NOT LEAK LIVE RAW"),
    "expected project-state prefix projection to exclude uncompacted live raw text",
  );

  console.log("test-project-state-snapshot-summary-backed passed");
}

main();
