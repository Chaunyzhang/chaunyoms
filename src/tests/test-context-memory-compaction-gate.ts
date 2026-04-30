import { ContextAssembler } from "../engines/ContextAssembler";
import {
  ContextItem,
  ContextViewRepository,
  FixedPrefixProvider,
  MemoryItemDraftRepository,
  RawMessage,
  RawMessageRepository,
  SummaryRepository,
} from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

class InMemoryContextViewStore implements ContextViewRepository {
  private items: ContextItem[] = [];

  setItems(items: ContextItem[]): void {
    this.items = items;
  }

  getItems(): ContextItem[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }
}

const fixedPrefixProvider: FixedPrefixProvider = {
  async load(): Promise<ContextItem[]> {
    return [];
  },
  async getKnowledgeBaseHit() {
    return null;
  },
  async hasKnowledgeBaseTopicHit() {
    return false;
  },
};

const messages: RawMessage[] = [
  {
    id: "m-compacted",
    sessionId: "session",
    role: "user",
    content: "Old compacted source: keep the final architecture clean.",
    turnNumber: 1,
    createdAt: "2026-04-29T00:00:00.000Z",
    tokenCount: 12,
    compacted: true,
  },
  {
    id: "m-live",
    sessionId: "session",
    role: "user",
    content: "Live source still in recent tail: do not duplicate this as a memory card yet.",
    turnNumber: 2,
    createdAt: "2026-04-29T00:01:00.000Z",
    tokenCount: 16,
    compacted: false,
  },
];

const rawStore: RawMessageRepository = {
  async init() {},
  async append() {},
  getAll() {
    return [...messages];
  },
  getByRange(startTurn: number, endTurn: number) {
    return messages.filter((message) => message.turnNumber >= startTurn && message.turnNumber <= endTurn);
  },
  getByIds(ids: string[]) {
    const requested = new Set(ids);
    return messages.filter((message) => requested.has(message.id));
  },
  getBySequenceRange() {
    return [];
  },
  getRecentTail() {
    return [messages[1]];
  },
  getRecentTailByTokens() {
    return [messages[1]];
  },
  totalUncompactedTokens() {
    return messages.filter((message) => !message.compacted).reduce((sum, message) => sum + message.tokenCount, 0);
  },
  getUncompactedMessages() {
    return messages.filter((message) => !message.compacted);
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
    return [];
  },
  getActiveSummaries() {
    return [];
  },
  getRootSummaries() {
    return [];
  },
  getCoveredTurns() {
    return new Set<number>();
  },
  findBySourceCoverage() {
    return null;
  },
  search() {
    return [];
  },
  getTotalTokens() {
    return 0;
  },
  async attachParent() {},
};

const memoryItemDraftStore: MemoryItemDraftRepository = {
  async init() {},
  async addEntries() {
    return 0;
  },
  async replaceAll() {},
  search() {
    return [];
  },
  getAll() {
    return [
      {
        id: "mem-live",
        sessionId: "session",
        kind: "constraint",
        recordStatus: "active",
        text: "Live raw fact should not surface while its source remains uncompacted.",
        fingerprint: "live",
        tags: ["live"],
        createdAt: "2026-04-29T00:02:00.000Z",
        sourceType: "raw_message",
        sourceIds: ["m-live"],
      },
      {
        id: "mem-compacted",
        sessionId: "session",
        kind: "constraint",
        recordStatus: "active",
        text: "Old compacted fact should surface after its source is compacted.",
        fingerprint: "compacted",
        tags: ["compacted"],
        createdAt: "2026-04-29T00:01:00.000Z",
        sourceType: "raw_message",
        sourceIds: ["m-compacted"],
      },
    ];
  },
  count() {
    return 2;
  },
};

async function main(): Promise<void> {
  const assembler = new ContextAssembler(
    new InMemoryContextViewStore(),
    fixedPrefixProvider,
  );

  const result = await assembler.assemble(
    rawStore,
    summaryStore,
    memoryItemDraftStore,
    400,
    0,
    80,
    2,
    "C:\\shared",
    "C:\\workspace",
    { sessionId: "session" },
  );

  const joined = result.items.map((item) => item.content).join("\n");
  assert(
    joined.includes("Old compacted fact should surface"),
    "expected compacted-source memory item to enter default context",
  );
  assert(
    !joined.includes("Live raw fact should not surface"),
    "expected uncompacted-source memory item to stay out of default context",
  );
  assert(
    joined.indexOf("Live source still in recent tail") < joined.indexOf("Old compacted fact should surface"),
    "expected live recent tail to precede mature dynamic recall",
  );

  console.log("test-context-memory-compaction-gate passed");
}

void main();
