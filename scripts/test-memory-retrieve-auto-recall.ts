import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OpenClawBridge } from "../src/OpenClawBridge";

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, args: any) => Promise<any>;
};

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-auto-recall-"));
  const dataDir = path.join(dir, ".chaunyoms");
  const workspaceDir = path.join(dir, "workspace");
  const sharedDataDir = path.join(dir, "openclaw-data");

  await mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, "memory", "2026-04-02.md"),
    [
      "2026-04-02:",
      "- active: plugin rollout",
      "- decision: keep tools disabled until smoke test passes",
      "- todo: verify runtime fallback compaction",
      "- next: run the safest smoke test first",
      "- pending: decide when to enable tools",
      "- blocker: none recorded",
    ].join("\n"),
    "utf8",
  );

  const tools = new Map<string, RegisteredTool>();
  const api = {
    logger: { info(): void {}, warn(): void {}, error(): void {} },
    config: {
      enableTools: true,
      agents: { defaults: { memorySearch: { enabled: false } } },
    },
    registerTool(tool: RegisteredTool): void {
      tools.set(tool.name, tool);
    },
    registerContextEngine(): void {},
  };

  const bridge = new OpenClawBridge();
  bridge.register(api);
  await bridge.bootstrap({
    sessionId: "test-session",
    config: { dataDir, workspaceDir, sharedDataDir, contextWindow: 120, contextThreshold: 0.5 },
  });

  for (let turn = 1; turn <= 6; turn += 1) {
    await bridge.ingest({
      sessionId: "test-session",
      message: {
        id: `u-${turn}`,
        role: "user",
        content: turn === 3 ? "The exact parameter is maxRetries=5." : `User message ${turn}`,
        turnNumber: turn,
      },
    });
    await bridge.ingest({
      sessionId: "test-session",
      message: {
        id: `a-${turn}`,
        role: "assistant",
        content: `Assistant message ${turn}`,
        turnNumber: turn,
      },
    });
  }

  await bridge.compact({ sessionId: "test-session", contextWindow: 120 });

  const memoryRetrieve = tools.get("memory_retrieve");
  assert(memoryRetrieve, "memory_retrieve tool not registered");

  const factResult = await memoryRetrieve!.execute("tool-1", {
    sessionId: "test-session",
    query: "what was the exact parameter",
  });
  assert(factResult?.details?.autoRecall === true, "expected autoRecall=true for fact query");
  assert(factResult?.details?.retrievalHitType === "dag_recall", "expected dag_recall for fact query");
  assert(
    typeof factResult?.details?.autoRecallReason === "string" && factResult.details.autoRecallReason.length > 0,
    "expected non-empty autoRecallReason",
  );

  const navResult = await memoryRetrieve!.execute("tool-2", {
    sessionId: "test-session",
    query: "recent active topic",
  });
  assert(navResult?.details?.autoRecall === false, "expected autoRecall=false for navigation query");
  assert(navResult?.details?.retrievalHitType === "route_hit", "expected route_hit for navigation query");

  const nextResult = await memoryRetrieve!.execute("tool-3", {
    sessionId: "test-session",
    query: "what should we do next",
  });
  assert(nextResult?.details?.route === "navigation", "expected navigation route for next-step state query");
  assert(
    typeof nextResult?.content?.[0]?.text === "string" &&
      nextResult.content[0].text.includes("- next: run the safest smoke test first"),
    "expected state-first navigation response to prioritize next action",
  );

  await bridge.ingest({
    sessionId: "test-session",
    message: {
      id: "a-uncertain",
      role: "assistant",
      content: "I am not sure yet; I need more context before I can sequence this well.",
      turnNumber: 7,
    },
  });

  const complexUpgradeResult = await memoryRetrieve!.execute("tool-4", {
    sessionId: "test-session",
    query: "how should we sequence the rollout for this project",
  });
  assert(
    complexUpgradeResult?.details?.route === "navigation",
    "expected complex current-work query to upgrade into navigation state recall",
  );
  assert(
    complexUpgradeResult?.details?.retrievalHitType === "route_hit",
    "expected state upgrade to stay in the route-hit lane",
  );

  await rm(dir, { recursive: true, force: true });
  console.log("test-memory-retrieve-auto-recall passed");
}

void main();
