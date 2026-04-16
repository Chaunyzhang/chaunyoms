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
  const engine = new CompactionEngine(
    {
      async call(): Promise<string> {
        return JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "State summary with exact fact 19021 preserved.",
                keywords: ["state", "19021", "gateway"],
                toneTag: "focused",
              }),
            },
          ],
        });
      },
    },
    logger,
  );

  const result = await engine.generateSummary(
    [
      {
        id: "m-1",
        sessionId: "test",
        role: "user",
        content: "Gateway port is 19021.",
        turnNumber: 1,
        createdAt: new Date().toISOString(),
        tokenCount: 8,
        compacted: false,
      },
    ],
    undefined,
    120,
  );

  assert(
    result.summary.includes("19021"),
    "expected host-style content wrapper to parse into summary result",
  );
  assert(
    result.keywords.includes("gateway"),
    "expected keywords to survive wrapped host response",
  );

  console.log("test-host-summary-parsing passed");
}

void main();
