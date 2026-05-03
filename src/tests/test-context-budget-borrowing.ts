import { ContextAssembler } from "../engines/ContextAssembler";
import {
  ContextItem,
  ContextViewRepository,
  MemoryItemDraftRepository,
  FixedPrefixProvider,
  RawMessageRepository,
  SummaryEntry,
  SummaryRepository,
} from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

class InMemoryContextViewStore implements ContextViewRepository {
  private items: ContextItem[] = [];
  setItems(items: ContextItem[]): void { this.items = items; }
  getItems(): ContextItem[] { return [...this.items]; }
  clear(): void { this.items = []; }
}

const fixedPrefixProvider: FixedPrefixProvider = {
  async load(): Promise<ContextItem[]> {
    return [{
      kind: "summary",
      tokenCount: 5,
      content: "[shared_cognition]\nsmall stable prefix",
      metadata: { layer: "shared_cognition" },
    }];
  },
  async getKnowledgeBaseHit() { return null; },
  async hasKnowledgeBaseTopicHit() { return false; },
};

const recentMessages = [{
  id: "recent-1",
  sessionId: "session",
  role: "user" as const,
  content: "Latest protected user turn",
  turnNumber: 10,
  createdAt: new Date().toISOString(),
  tokenCount: 12,
  compacted: false,
}];

const rawStore: RawMessageRepository = {
  async init() {},
  async append() {},
  getAll() { return recentMessages; },
  getByRange() { return []; },
  getByIds() { return []; },
  getBySequenceRange() { return []; },
  getRecentTail() { return recentMessages; },
  getRecentTailByTokens() { return recentMessages; },
  totalUncompactedTokens() { return 12; },
  getUncompactedMessages() { return recentMessages; },
  async markCompacted() {},
};

function summary(index: number): SummaryEntry {
  return {
    id: `s-${index}`,
    sessionId: "session",
    summary: `Earlier compressed context ${index}`,
    keywords: [`k${index}`],
    toneTag: "neutral",
    constraints: [],
    decisions: [],
    blockers: [],
    exactFacts: [],
    startTurn: index,
    endTurn: index,
    summaryLevel: 2,
    nodeKind: "branch",
    tokenCount: 20,
    createdAt: new Date().toISOString(),
    sourceHash: `hash-${index}`,
    sourceMessageCount: 2,
  };
}

const summaries = [1, 2, 3, 4, 5].map(summary);
const summaryStore: SummaryRepository = {
  async init() {},
  async addSummary() { return true; },
  async upsertSummary() {},
  getAllSummaries() { return summaries; },
  getActiveSummaries() { return summaries; },
  getRootSummaries() { return summaries; },
  getCoveredTurns() { return new Set<number>(); },
  findBySourceCoverage() { return null; },
  search() { return []; },
  getTotalTokens() { return summaries.reduce((sum, item) => sum + item.tokenCount, 0); },
  async attachParent() {},
};

const memoryItemDraftStore: MemoryItemDraftRepository = {
  async init() {},
  async addEntries() { return 0; },
  async replaceAll() {},
  search() { return []; },
  getAll() { return []; },
  count() { return 0; },
};

async function main(): Promise<void> {
  const assembler = new ContextAssembler(new InMemoryContextViewStore(), fixedPrefixProvider);
  const result = await assembler.assemble(
    rawStore,
    summaryStore,
    memoryItemDraftStore,
    320,
    20,
    40,
    4,
    "C:\\shared",
    "C:\\workspace",
    { sessionId: "session" },
  );

  const summaryCount = result.items.filter((item) => typeof item.summaryId === "string").length;
  const guidanceCount = result.items.filter((item) => item.metadata?.layer === "oms_recall_guidance").length;
  const recentCount = result.items.filter((item) => item.kind === "message").length;

  assert(summaryCount === 0, `expected summaries to stay out of default context, got ${summaryCount}`);
  assert(guidanceCount === 1, "expected recall guidance to remain as the summary-map hint");
  assert(recentCount === 1, "expected protected recent tail to remain selected while summaries stay as recall substrate");
  console.log("test-context-budget-borrowing passed");
}

void main();
