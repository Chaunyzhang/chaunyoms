import { MemoryRetrievalRouter } from "../src/routing/MemoryRetrievalRouter";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  const router = new MemoryRetrievalRouter();

  const kbRoute = router.decide("去 knowledge-base 里找一下类似之前那个缓存方案", {
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

  const navRoute = router.decide("最近我们主线在做什么", {
    memorySearchEnabled: false,
  });
  assert(
    navRoute.route === "navigation",
    "expected navigation for recent workflow question",
  );
  assert(
    navRoute.canAnswerDirectly === true,
    "expected direct answer for navigation route",
  );

  const factRoute = router.decide("把上次那个配置参数的原话找出来", {
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
    "我记得有篇 knowledge-base 文档讲过缓存方案，帮我找相关资料",
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
