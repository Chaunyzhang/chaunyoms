import { CompactionEngine } from "../src/engines/CompactionEngine";

const logger = {
  info(): void {},
  warn(): void {},
  error(): void {},
};

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const engine = new CompactionEngine(null, logger);
  const result = await engine.generateSummary(
    [
      {
        id: "u-1",
        sessionId: "test",
        role: "user",
        content:
          "Important constraint: do not enable tools until the isolated smoke test passes. Exact operational detail: the isolated gateway port is 19021.",
        turnNumber: 1,
        createdAt: new Date().toISOString(),
        tokenCount: 30,
        compacted: false,
      },
      {
        id: "a-1",
        sessionId: "test",
        role: "assistant",
        content:
          "Decision recorded: keep tools disabled for now. Next action: run the safest smoke test first.",
        turnNumber: 1,
        createdAt: new Date().toISOString(),
        tokenCount: 20,
        compacted: false,
      },
      {
        id: "u-2",
        sessionId: "test",
        role: "user",
        content:
          "Current blocker: Docker is not installed on this machine, so we must rely on profile isolation.",
        turnNumber: 2,
        createdAt: new Date().toISOString(),
        tokenCount: 20,
        compacted: false,
      },
    ],
    undefined,
    180,
  );

  assert(
    /19021/.test(result.summary),
    "expected fallback summary to preserve exact numeric fact",
  );
  assert(
    /tools disabled|do not enable tools/i.test(result.summary),
    "expected fallback summary to preserve constraint/decision context",
  );
  assert(
    /Docker is not installed/i.test(result.summary),
    "expected fallback summary to preserve blocker detail",
  );
  assert(
    result.keywords.includes("19021") || result.keywords.includes("docker"),
    "expected fallback keywords to preserve important anchors",
  );

  console.log("test-fallback-summary-quality passed");
}

void main();
