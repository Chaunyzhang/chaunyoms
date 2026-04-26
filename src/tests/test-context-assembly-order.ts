import { ContextAssembler } from "../engines/ContextAssembler";
import { ContextItem, ContextViewRepository, DurableMemoryRepository, FixedPrefixProvider, RawMessageRepository, SummaryRepository } from "../types";

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
    return [
      {
        kind: "summary",
        tokenCount: 10,
        content: "[shared_cognition]\nDo not cut corners.",
        metadata: { layer: "shared_cognition" },
      },
      {
        kind: "summary",
        tokenCount: 10,
        content: "[knowledge_base_index]\n- architecture: v3",
        metadata: { layer: "knowledge_base_index" },
      },
      {
        kind: "summary",
        tokenCount: 10,
        content: "[navigation]\nCurrent focus: tighten memory ordering.",
        metadata: { layer: "navigation" },
      },
    ];
  },
  async getKnowledgeBaseHit() {
    return null;
  },
  async hasKnowledgeBaseTopicHit() {
    return false;
  },
};

const rawStore: RawMessageRepository = {
  async init() {},
  async append() {},
  getAll() {
    return [
      {
        id: "m-1",
        sessionId: "session",
        role: "user",
        content: "Latest user turn",
        turnNumber: 1,
        createdAt: new Date().toISOString(),
        tokenCount: 6,
        compacted: false,
      },
    ];
  },
  getByRange() {
    return [];
  },
  getByIds() {
    return [];
  },
  getBySequenceRange() {
    return [];
  },
  getRecentTail() {
    return [
      {
        id: "m-1",
        sessionId: "session",
        role: "user",
        content: "Latest user turn",
        turnNumber: 1,
        createdAt: new Date().toISOString(),
        tokenCount: 6,
        compacted: false,
      },
    ];
  },
  getRecentTailByTokens() {
    return [
      {
        id: "m-1",
        sessionId: "session",
        role: "user",
        content: "Latest user turn",
        turnNumber: 1,
        createdAt: new Date().toISOString(),
        tokenCount: 6,
        compacted: false,
      },
    ];
  },
  totalUncompactedTokens() {
    return 6;
  },
  getUncompactedMessages() {
    return this.getAll();
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
    return [
      {
        id: "s-1",
        sessionId: "session",
        summary: "Earlier work established the ordering rule.",
        keywords: ["ordering"],
        toneTag: "neutral",
        constraints: [],
        decisions: [],
        blockers: [],
        exactFacts: [],
        startTurn: 1,
        endTurn: 1,
        summaryLevel: 2,
        nodeKind: "branch",
        tokenCount: 12,
        createdAt: new Date().toISOString(),
      },
    ];
  },
  getActiveSummaries() {
    return [
      {
        id: "s-1",
        sessionId: "session",
        summary: "Earlier work established the ordering rule.",
        keywords: ["ordering"],
        toneTag: "neutral",
        constraints: [],
        decisions: [],
        blockers: [],
        exactFacts: [],
        startTurn: 1,
        endTurn: 1,
        summaryLevel: 2,
        nodeKind: "branch",
        tokenCount: 12,
        createdAt: new Date().toISOString(),
      },
    ];
  },
  getRootSummaries() {
    return [
      {
        id: "s-1",
        sessionId: "session",
        summary: "Earlier work established the ordering rule.",
        keywords: ["ordering"],
        toneTag: "neutral",
        constraints: [],
        decisions: [],
        blockers: [],
        exactFacts: [],
        startTurn: 1,
        endTurn: 1,
        summaryLevel: 2,
        nodeKind: "branch",
        tokenCount: 12,
        createdAt: new Date().toISOString(),
      },
    ];
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
    return 12;
  },
  async attachParent() {},
};

const durableMemoryStore: DurableMemoryRepository = {
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
        id: "d-1",
        sessionId: "session",
        kind: "constraint",
        recordStatus: "active",
        text: "Summaries should beat reference indexes for historical continuity.",
        fingerprint: "fp-1",
        tags: ["ordering"],
        createdAt: new Date().toISOString(),
        sourceType: "snapshot",
        sourceIds: ["snapshot-1"],
      },
    ];
  },
  count() {
    return 1;
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
    durableMemoryStore,
    400,
    0,
    80,
    4,
    "C:\\shared",
    "C:\\workspace",
  );

  const labels = result.items.map((item) => {
    if (typeof item.metadata?.layer === "string") {
      return item.metadata.layer;
    }
    if (typeof item.content === "string" && item.content.startsWith("[durable_memory:")) {
      return "durable_memory";
    }
    if (typeof item.summaryId === "string") {
      return "summaries";
    }
    if (item.kind === "message") {
      return "recent_tail";
    }
    return "unknown";
  });

  assert(
    labels.join(" > ") ===
      "shared_cognition > navigation > oms_recall_guidance > durable_memory > summaries > knowledge_base_index > recent_tail",
    `unexpected assembly order: ${labels.join(" > ")}`,
  );

  console.log("test-context-assembly-order passed");
}

void main();
