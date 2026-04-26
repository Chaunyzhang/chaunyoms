import { CompactionEngine } from "../engines/CompactionEngine";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const engine = new CompactionEngine(null, {
  info(): void {},
  warn(): void {},
  error(): void {},
});

const markdown = `
# Level-1 Memory Extraction

## Scope
- Covers memory substrate design.

## Mechanisms And Claims
- Level-1 summaries are nutrient substrate, not prompt-resident short summaries.

## Exact Anchors
- Recent tail keeps 5%-10% of the model window and clamps to 1-10 turns.

## Constraints
- Tool results must be scratch-only unless promoted into sourced facts.

## Decisions
- Evidence atoms should be the smallest retrieval unit before expanding to raw source spans.

## Failure Modes
- Mixing constraints and decisions pollutes downstream retrieval.

## Next Steps
- Verify source trace coverage for generated atoms.

## Open Questions
- Should promotion require human review when conflicts are present?

## Conflicts / Ambiguities
- Tool output can be source evidence, but raw tool payload should not be durable memory.

## Candidate Evidence Atoms
- constraint | Tool results must be scratch-only unless promoted into sourced facts.

## Retrieval Cues
- substrate
- evidence atoms

## Key Entities
- ChaunyOMS
- Level-1 substrate
`;

const parsed = (engine as unknown as {
  markdownToSummaryResult(raw: string): {
    constraints: string[];
    decisions: string[];
    blockers: string[];
    nextSteps?: string[];
    openQuestions?: string[];
    conflicts?: string[];
    candidateAtomPreviews?: string[];
    exactFacts: string[];
    keyEntities?: string[];
  } | null;
}).markdownToSummaryResult(markdown);

assert(parsed, "expected markdown substrate to parse");
if (!parsed) {
  throw new Error("expected markdown substrate to parse");
}
assert(parsed.constraints.length === 1 && parsed.constraints[0].includes("Tool results"), "expected constraints to be isolated");
assert(parsed.decisions.length === 1 && parsed.decisions[0].includes("Evidence atoms"), "expected decisions to be isolated");
assert(parsed.blockers.length === 1 && parsed.blockers[0].includes("pollutes"), "expected failure modes to map to blockers");
assert(parsed.nextSteps?.length === 1 && parsed.nextSteps[0].includes("source trace"), "expected next steps to be isolated");
assert(parsed.openQuestions?.length === 1 && parsed.openQuestions[0].includes("human review"), "expected open questions to be isolated");
assert(parsed.conflicts?.length === 1 && parsed.conflicts[0].includes("raw tool payload"), "expected conflicts to be isolated");
assert(parsed.candidateAtomPreviews?.length === 1 && parsed.candidateAtomPreviews[0].includes("scratch-only"), "expected candidate atom previews to be retained");
assert(parsed.exactFacts.some((fact) => fact.includes("5%-10%")), "expected exact anchors to feed exact facts");
assert(parsed.exactFacts.some((fact) => fact.includes("nutrient substrate")), "expected mechanisms and claims to feed exact facts");
assert(parsed.keyEntities?.some((entity) => entity.includes("ChaunyOMS")), "expected key entities to be retained");
assert(!parsed.constraints.some((item) => item.includes("Evidence atoms")), "decisions should not leak into constraints");

console.log("test-level-one-substrate-parsing passed");
