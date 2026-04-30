import { RetrievalEnhancementRegistry } from "../retrieval/RetrievalEnhancementProviders";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const defaults = RetrievalEnhancementRegistry.status(DEFAULT_BRIDGE_CONFIG);
  assert(!defaults.graph.active && !defaults.rag.active && !defaults.rerank.active && !defaults.evidenceAnswerResolver.active, "enhancement lanes should be inactive by default");
  assert(defaults.defaultLatencyImpact === "none_when_disabled", "disabled enhancements should have no default latency impact");
  const enabled = RetrievalEnhancementRegistry.status({
    ...DEFAULT_BRIDGE_CONFIG,
    graphEnabled: true,
    graphProvider: "sqlite_edges",
    rerankEnabled: true,
    rerankProvider: "deterministic",
    evidenceAnswerResolverEnabled: true,
    evidenceAnswerResolverProvider: "deterministic",
  });
  assert(enabled.graph.active, "sqlite_edges graph lane should be active when explicitly enabled");
  assert(enabled.rerank.active && enabled.rerank.authority === "ordering_only", "rerank lane should be ordering-only");
  assert(enabled.evidenceAnswerResolver.active && enabled.evidenceAnswerResolver.authority === "answer_resolution", "EvidenceAnswerResolver should be explicit answer-resolution lane");
  console.log("test-retrieval-enhancement-providers passed");
}

void main();
