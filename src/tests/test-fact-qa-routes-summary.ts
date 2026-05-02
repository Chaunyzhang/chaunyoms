import { MemoryRetrievalRouter } from "../routing/MemoryRetrievalRouter";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  const router = new MemoryRetrievalRouter();
  const decision = router.decide(
    "How long is my daily commute to work?",
    {
      hasCompactedHistory: true,
      hasProjectRegistry: false,
      hasMemoryItemHits: false,
    },
  );

  assert(
    decision.route === "summary_tree",
    "fact QA over compacted history should route to summary_tree",
  );
  assert(
    decision.requiresSourceRecall === true,
    "fact QA over compacted history should require source recall",
  );
  assert(
    decision.reason === "fact_qa_requires_source_recall",
    "expected explicit fact QA routing reason",
  );

  console.log("test-fact-qa-routes-summary passed");
}

main();
