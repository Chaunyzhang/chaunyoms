import { ContextAssembler } from "../engines/ContextAssembler";
import {
  ContextItem,
  ContextViewRepository,
  FixedPrefixProvider,
  RawMessage,
  RawMessageRepository,
} from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

class InMemoryContextViewStore implements ContextViewRepository {
  setItems(): void {}
  getItems(): ContextItem[] { return []; }
  clear(): void {}
}

const fixedPrefixProvider: FixedPrefixProvider = {
  async load(): Promise<ContextItem[]> { return []; },
  async getKnowledgeBaseHit() { return null; },
  async hasKnowledgeBaseTopicHit() { return false; },
};

const hugeMessage: RawMessage = {
  id: "huge-tail",
  sessionId: "session",
  agentId: "agent",
  role: "user",
  content: Array.from({ length: 3000 }, (_, index) => `tail-${index}`).join(" "),
  turnNumber: 99,
  createdAt: "2026-04-26T00:00:00.000Z",
  tokenCount: 5000,
  compacted: false,
};

let observedBudget = 0;
let observedTurns = 0;

const rawStore: RawMessageRepository = {
  async init() {},
  async append() {},
  getAll() { return [hugeMessage]; },
  getByRange() { return []; },
  getByIds() { return []; },
  getBySequenceRange() { return []; },
  getRecentTail() { return [hugeMessage]; },
  getRecentTailByTokens(tokenBudget: number, maxTurns: number) {
    observedBudget = tokenBudget;
    observedTurns = maxTurns;
    return [hugeMessage];
  },
  totalUncompactedTokens() { return hugeMessage.tokenCount; },
  getUncompactedMessages() { return [hugeMessage]; },
  async markCompacted() {},
};

async function main(): Promise<void> {
  const assembler = new ContextAssembler(new InMemoryContextViewStore(), fixedPrefixProvider);
  const items = assembler.assembleRecentTail(rawStore, 10000, 99999, 99, "session");

  assert(observedBudget === 1000, `expected recent tail budget to cap at 10% of context, got ${observedBudget}`);
  assert(observedTurns === 10, `expected recent tail turns to cap at 10, got ${observedTurns}`);
  assert(items.length === 1, `expected one clipped recent tail item, got ${items.length}`);
  assert(items[0].tokenCount <= observedBudget, `expected clipped item to stay within budget, got ${items[0].tokenCount}`);
  assert(items[0].metadata?.recentTailClipped === true, "expected oversized recent tail message to be marked clipped");
  assert(items[0].metadata?.originalTokenCount === hugeMessage.tokenCount, "expected original token count metadata");

  console.log("test-recent-tail-proportional-budget passed");
}

void main();
