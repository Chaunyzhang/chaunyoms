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

  const complexStateUpgrade = router.decide(
    "how should we sequence the rollout for this project",
    {
      memorySearchEnabled: false,
      hasNavigationHint: true,
      hasStructuredNavigationState: true,
      hasCompactedHistory: true,
      queryComplexity: "high",
      referencesCurrentWork: true,
    },
  );
  assert(
    complexStateUpgrade.route === "navigation",
    "expected navigation upgrade for complex current-work question",
  );
  assert(
    complexStateUpgrade.reason === "complex_task_state_upgrade",
    "expected complex task upgrade reason",
  );

  const uncertaintyUpgrade = router.decide(
    "help with this project",
    {
      memorySearchEnabled: false,
      hasNavigationHint: true,
      hasStructuredNavigationState: true,
      hasCompactedHistory: true,
      recentAssistantUncertainty: true,
      referencesCurrentWork: true,
    },
  );
  assert(
    uncertaintyUpgrade.route === "navigation",
    "expected navigation upgrade when recent assistant replies show uncertainty",
  );
  assert(
    uncertaintyUpgrade.reason === "assistant_uncertainty_state_upgrade",
    "expected uncertainty upgrade reason",
  );

  console.log("test-memory-router passed");
}

main();
