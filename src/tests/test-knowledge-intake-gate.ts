import { KnowledgeIntakeGate } from "../engines/KnowledgeIntakeGate";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { SummaryEntry } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function buildSummary(overrides: Partial<SummaryEntry> = {}): SummaryEntry {
  return {
    id: "summary-1",
    sessionId: "session-1",
    summary: "Decision summary with stable engineering value.",
    keywords: ["retry", "queue"],
    toneTag: "neutral",
    memoryType: "decision",
    phase: "implementation",
    constraints: ["avoid duplicate processing"],
    decisions: ["use capped exponential backoff"],
    blockers: [],
    nextSteps: [],
    keyEntities: ["QueueWorker"],
    exactFacts: ["five retries max"],
    promotionIntent: "promote",
    startTurn: 1,
    endTurn: 2,
    summaryLevel: 1,
    nodeKind: "leaf",
    tokenCount: 24,
    createdAt: new Date().toISOString(),
    sourceHash: "summary-hash",
    sourceMessageCount: 2,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const gate = new KnowledgeIntakeGate();

  const accepted = gate.decide(buildSummary(), DEFAULT_BRIDGE_CONFIG);
  assert(accepted.accepted === true, "expected memoryItem promoted leaf summary to enter knowledge raw");

  const navigationOnly = gate.decide(buildSummary({
    promotionIntent: "navigation_only",
  }), DEFAULT_BRIDGE_CONFIG);
  assert(navigationOnly.accepted === false, "expected navigation-only summary to stay out of knowledge raw");

  const branchSummary = gate.decide(buildSummary({
    id: "summary-branch",
    summaryLevel: 2,
    nodeKind: "branch",
  }), DEFAULT_BRIDGE_CONFIG);
  assert(branchSummary.accepted === false, "expected branch summary to stay out of knowledge raw");

  const weakProjectState = gate.decide(buildSummary({
    id: "summary-project-state",
    memoryType: "project_state",
    promotionIntent: "candidate",
    constraints: [],
    decisions: [],
    exactFacts: [],
    keyEntities: [],
    summary: "Current implementation is moving forward.",
  }), DEFAULT_BRIDGE_CONFIG);
  assert(weakProjectState.accepted === false, "expected weak project-state summary to stay in asset layer");

  const conservativeGeneral = gate.decide(buildSummary({
    id: "summary-conservative",
    promotionIntent: "candidate",
    memoryType: "general",
    constraints: [],
    decisions: ["settled result"],
    exactFacts: [],
    keyEntities: ["QueueWorker"],
  }), {
    ...DEFAULT_BRIDGE_CONFIG,
    knowledgeIntakeMode: "conservative",
  });
  assert(conservativeGeneral.accepted === false, "expected conservative mode to require more long-term signals");

  const aggressiveGeneral = gate.decide(buildSummary({
    id: "summary-aggressive",
    promotionIntent: "candidate",
    memoryType: "general",
    constraints: [],
    decisions: [],
    exactFacts: ["five retries max"],
    keyEntities: [],
  }), {
    ...DEFAULT_BRIDGE_CONFIG,
    knowledgeIntakeMode: "aggressive",
  });
  assert(aggressiveGeneral.accepted === true, "expected aggressive mode to admit weaker but still structured candidates");

  const allowedProjectState = gate.decide(buildSummary({
    id: "summary-allowed-project-state",
    memoryType: "project_state",
    promotionIntent: "candidate",
    constraints: [],
    decisions: [],
    exactFacts: [],
    keyEntities: [],
  }), {
    ...DEFAULT_BRIDGE_CONFIG,
    knowledgeIntakeAllowProjectState: true,
  });
  assert(allowedProjectState.accepted === true, "expected project-state summaries to pass when policy explicitly allows them");

  console.log("test-knowledge-intake-gate passed");
}

void main();
