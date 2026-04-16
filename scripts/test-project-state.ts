import { parseProjectStateSnapshot, prioritizeProjectStateSnapshot } from "../src/utils/projectState";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  const legacySnapshot = [
    "2026-04-02:",
    "- active: shipping the plugin rollout",
    "- decision: keep tools disabled by default",
    "- todo: verify runtime fallback compaction",
    "- next: run the safest smoke test first",
    "- pending: decide when to enable tools",
    "- blocker: none recorded",
    "- risk: none recorded",
    "- recall: summary:test turns 1-4",
  ].join("\n");

  const parsedLegacy = parseProjectStateSnapshot(legacySnapshot);
  assert(parsedLegacy, "expected legacy snapshot to remain parseable");
  assert(parsedLegacy?.schemaVersion === 1, "expected parsed legacy snapshot to normalize to schemaVersion=1");
  assert(parsedLegacy?.next === "run the safest smoke test first", "expected next action to parse from legacy snapshot");

  const prioritized = prioritizeProjectStateSnapshot(parsedLegacy!, "what should we do next");
  assert(
    prioritized.startsWith("# chaunyoms-project-state:v1"),
    "expected prioritized snapshot to include schema header",
  );
  assert(
    prioritized.includes("- next: run the safest smoke test first"),
    "expected prioritized snapshot to preserve next action",
  );

  const reparsed = parseProjectStateSnapshot(prioritized);
  assert(reparsed, "expected new schema snapshot to parse");
  assert(reparsed?.schemaVersion === 1, "expected schema snapshot to remain versioned");
  assert(reparsed?.active === "shipping the plugin rollout", "expected active state to survive round-trip");

  console.log("test-project-state passed");
}

main();
