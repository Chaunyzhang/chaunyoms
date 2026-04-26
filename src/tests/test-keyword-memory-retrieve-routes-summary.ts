import { MemoryRetrievalRouter } from "../routing/MemoryRetrievalRouter";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  const router = new MemoryRetrievalRouter();
  const decision = router.decide(
    "online memory use offline consolidation split latency lightweight agent memory hierarchy",
    {
      hasCompactedHistory: true,
      hasProjectRegistry: true,
      matchedProjectId: "agent-memory-corpus",
      matchedProjectTitle: "Agent Memory Corpus",
    },
  );

  assert(decision.route === "summary_tree", "keyword corpus lookup should route to summary_tree when compacted history exists");
  assert(decision.requiresSourceRecall === true, "summary-tree keyword lookup should trigger source recall");
  assert(decision.reason === "keyword_query_with_compacted_history", "expected keyword lookup reason");
  assert(
    decision.layerScores?.some((score) =>
      score.route === "summary_tree" &&
      score.reasons.includes("keyword_query_with_compacted_history")),
    "expected diagnostic layer score to explain keyword summary routing",
  );

  const projectDecision = router.decide(
    "current project status blocker next step",
    {
      hasCompactedHistory: true,
      hasProjectRegistry: true,
      matchedProjectId: "agent-memory-corpus",
      matchedProjectTitle: "Agent Memory Corpus",
    },
  );
  assert(projectDecision.route === "project_registry", "explicit project state should still route to project registry");

  console.log("test-keyword-memory-retrieve-routes-summary passed");
}

main();
