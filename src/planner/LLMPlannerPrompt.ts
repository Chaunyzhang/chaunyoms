import { RetrievalDecision } from "../types";
import { PlannerRuntimeSignals } from "./LLMPlannerTypes";

export function buildLLMPlannerPrompt(args: {
  query: string;
  deterministicDecision: RetrievalDecision;
  signals: PlannerRuntimeSignals;
}): string {
  return [
    "You are OMS LLMPlanner, the on-demand retrieval scheduling brain.",
    "Return strict JSON only. Do not answer the user.",
    "",
    "Hard laws:",
    "- Source is the highest evidence; tool calls and tool results are RuntimeEvent, not Source.",
    "- BaseSummary is a map, not a final precise fact substitute.",
    "- MemoryItem may guide answers, but high/xhigh facts require source trace.",
    "- Markdown/Obsidian/AgentVault never becomes a runtime fact source.",
    "- Current user instruction and recent tail must be protected.",
    "- Destructive operations require dry-run by default.",
    "- Heavy retrieval lanes (rag_candidates, graph_neighbors, rerank) are tools scheduled by LLMPlanner, not independent brains.",
    "- RAG and Graph produce candidates only; they cannot become final authority without MemoryItem/Summary/Raw source verification.",
    "- Rerank orders overloaded or ambiguous candidates; it cannot create facts.",
    "- Candidate overload must include a rerank.order step before final context selection or answer formation.",
    "- DAG expansion can be deterministic or delegated_agent. delegated_agent is allowed only when configured and should be chosen for complex high/xhigh or multi-hop summary navigation; deterministic remains the safe fallback.",
    "",
    "Use this JSON shape:",
    JSON.stringify({
      intent: {
        primary: "precision_fact",
        confidence: 0.9,
        ambiguity: [],
      },
      retrieval: {
        sourceTraceRequired: true,
        dagExpansion: {
          mode: "delegated_agent",
          reason: "complex source-sensitive recall benefits from agentic DAG expansion",
        },
        candidateLayers: ["memory_items", "base_summaries", "raw_sources", "rerank"],
        progressive: true,
        stopCondition: "sufficient_source_backed_answer",
      },
      memoryWrite: {
        allowed: false,
        candidateKinds: [],
        reason: "no durable user preference or correction",
      },
      explain: {
        shortReason: "why this plan is appropriate",
        whyTheseLayers: ["layer reason"],
      },
    }, null, 2),
    "",
    `Query: ${args.query}`,
    `Deterministic decision: ${JSON.stringify({
      route: args.deterministicDecision.route,
      routePlan: args.deterministicDecision.routePlan,
      reason: args.deterministicDecision.reason,
      requiresSourceRecall: args.deterministicDecision.requiresSourceRecall,
      layerScores: args.deterministicDecision.layerScores ?? [],
    })}`,
    `Runtime signals: ${JSON.stringify(args.signals)}`,
  ].join("\n");
}
