import { SummaryHierarchyEngine } from "../engines/SummaryHierarchyEngine";
import { SummaryEntry, SummaryRepository } from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function makeSummary(id: string, projectId: string, startTurn: number): SummaryEntry {
  return {
    id,
    sessionId: "cross-project-rollup-session",
    agentId: "agent-1",
    projectId,
    topicId: `${projectId}-topic`,
    recordStatus: "active",
    summary: `# Level-1 Base\n\nHigh-quality base text for ${projectId}.`,
    keywords: [projectId],
    toneTag: "base",
    memoryType: "project_state",
    phase: "active",
    constraints: [],
    decisions: [],
    blockers: [],
    nextSteps: [],
    keyEntities: [],
    exactFacts: [],
    promotionIntent: "candidate",
    startTurn,
    endTurn: startTurn + 1,
    sourceMessageIds: [`${id}-message`],
    sourceSequenceMin: startTurn,
    sourceSequenceMax: startTurn + 1,
    parentSummaryIds: [],
    childSummaryIds: [],
    sourceSummaryIds: [],
    summaryLevel: 1,
    nodeKind: "leaf",
    tokenCount: 16,
    createdAt: new Date(startTurn * 1000).toISOString(),
  };
}

class InMemorySummaryStore implements SummaryRepository {
  constructor(private readonly summaries: SummaryEntry[]) {}

  async init(): Promise<void> {}

  async addSummary(entry: SummaryEntry): Promise<boolean> {
    this.summaries.push(entry);
    return true;
  }

  async upsertSummary(entry: SummaryEntry): Promise<void> {
    const index = this.summaries.findIndex((summary) => summary.id === entry.id);
    if (index >= 0) {
      this.summaries[index] = entry;
      return;
    }
    this.summaries.push(entry);
  }

  getAllSummaries(): SummaryEntry[] {
    return [...this.summaries];
  }

  getActiveSummaries(): SummaryEntry[] {
    return this.summaries.filter((summary) => summary.recordStatus === "active");
  }

  getRootSummaries(): SummaryEntry[] {
    return this.getActiveSummaries().filter((summary) => !summary.parentSummaryId);
  }

  getCoveredTurns(): Set<number> {
    return new Set();
  }

  findBySourceCoverage(): SummaryEntry | null {
    return null;
  }

  search(): SummaryEntry[] {
    return [];
  }

  getTotalTokens(): number {
    return this.summaries.reduce((total, summary) => total + summary.tokenCount, 0);
  }

  async attachParent(parentSummaryId: string, childSummaryIds: string[]): Promise<void> {
    for (const summary of this.summaries) {
      if (!childSummaryIds.includes(summary.id)) {
        continue;
      }
      summary.parentSummaryId = parentSummaryId;
      summary.parentSummaryIds = [parentSummaryId];
    }
  }
}

async function main(): Promise<void> {
  const store = new InMemorySummaryStore([
    makeSummary("leaf-1", "paper-a", 1),
    makeSummary("leaf-2", "paper-b", 3),
    makeSummary("leaf-3", "paper-c", 5),
  ]);
  const engine = new SummaryHierarchyEngine(
    {
      async call(): Promise<string> {
        return JSON.stringify({
          summary: "Level-2 branch summary that links heterogeneous level-1 base summaries.",
          keywords: ["branch", "rollup"],
          toneTag: "navigation",
          memoryType: "project_state",
          phase: "active",
          constraints: [],
          decisions: ["roll up level-1 base summaries across project labels"],
          blockers: [],
          nextSteps: ["use branch summary in context"],
          keyEntities: ["paper-a", "paper-b", "paper-c"],
          exactFacts: ["created from three level-1 summaries"],
          promotionIntent: "candidate",
        });
      },
    },
    { info(): void {}, warn(): void {}, error(): void {} },
  );

  const branch = await engine.rollUp(store, "cross-project-rollup-session", "agent-1", undefined, 120);
  assert(branch, "expected rollup to produce a branch when three level-1 roots have different project ids");
  assert(branch?.nodeKind === "branch", "expected rollup output to be a branch node");
  assert(branch?.summaryLevel === 2, "expected rollup output to be level 2");
  assert(branch?.projectId !== "paper-a", "expected heterogeneous rollup to avoid inheriting the first child project id");
  assert(branch?.childSummaryIds?.length === 3, "expected branch to link all selected level-1 children");

  console.log("test-summary-rollup-cross-project passed");
}

void main();
