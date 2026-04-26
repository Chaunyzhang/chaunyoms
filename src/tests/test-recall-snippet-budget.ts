import { ChaunyomsRetrievalService } from "../runtime/ChaunyomsRetrievalService";
import { ContextItem } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const service = Object.create(ChaunyomsRetrievalService.prototype) as {
    buildBudgetAwareRecallItem(query: string, item: ContextItem, recallBudget: number): ContextItem;
  };
  const before = Array.from({ length: 2500 }, (_, index) => `before${index}`).join(" ");
  const after = Array.from({ length: 2500 }, (_, index) => `after${index}`).join(" ");
  const item: ContextItem = {
    kind: "message",
    tokenCount: 9000,
    role: "assistant",
    turnNumber: 42,
    content: `${before} needle-anchor exact evidence ${after}`,
    metadata: { messageId: "m-large" },
  };

  const result = service.buildBudgetAwareRecallItem("needle anchor", item, 1000);

  assert(result.metadata?.recallSnippet === true, "expected oversized recall item to become a snippet");
  assert(Number(result.metadata?.originalTokenCount ?? 0) >= 9000, "expected original token count metadata");
  assert(result.tokenCount <= 1000, `expected snippet to stay within recall budget, got ${result.tokenCount}`);
  assert(String(result.content).includes("needle-anchor exact evidence"), "expected query-adjacent evidence to be preserved");
  assert(String(result.content).includes("oms_expand/oms_trace"), "expected full-source recovery hint");

  console.log("test-recall-snippet-budget passed");
}

void main();
