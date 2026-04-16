import { MemoryRetrievalRouter } from "../src/routing/MemoryRetrievalRouter";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  const router = new MemoryRetrievalRouter();

  const kbRoute = router.decide("find something related in the knowledge-base", {
    memorySearchEnabled: false,
  });
  assert(
    kbRoute.route === "knowledge_base",
    "expected knowledge_base fallback without embeddings",
  );
  assert(
    kbRoute.requiresEmbeddings === true,
    "expected embeddings request for fuzzy knowledge-base lookup",
  );

  const stateRoute = router.decide("what should we do next on this project?", {
    memorySearchEnabled: false,
  });
  assert(
    stateRoute.route === "navigation",
    "expected navigation for project state question",
  );
  assert(
    stateRoute.reason === "project_state_question",
    "expected state-specific navigation reason",
  );

  const factRoute = router.decide("what was the exact parameter we used before", {
    memorySearchEnabled: true,
  });
  assert(
    factRoute.route === "dag",
    "expected dag route for exact historical fact recall",
  );
  assert(
    factRoute.requiresSourceRecall === true,
    "expected source recall for fact question",
  );

  const vectorRoute = router.decide(
    "find something related about the knowledge-base cache plan",
    {
      memorySearchEnabled: true,
      hasTopicIndexHit: false,
    },
  );
  assert(
    vectorRoute.route === "vector_search",
    "expected vector search for fuzzy kb lookup when embeddings are enabled",
  );

  console.log("test-memory-router passed");
}

main();
