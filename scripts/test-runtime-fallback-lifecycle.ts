import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OpenClawBridge } from "../src/OpenClawBridge";

type RegisteredContextEngineFactory = () => {
  bootstrap?: (payload?: any) => Promise<any>;
  assemble?: (payload?: any) => Promise<any>;
  afterTurn?: (payload?: any) => Promise<any>;
};

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  let factory: RegisteredContextEngineFactory | null = null;
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-runtime-fallback-"));
  const dataDir = path.join(dir, ".chaunyoms");
  const workspaceDir = path.join(dir, "workspace");
  const sharedDataDir = path.join(dir, "openclaw-data");
  const sessionId = "runtime-fallback-session";

  await mkdir(path.join(workspaceDir, "memory"), { recursive: true });

  const api = {
    logger: { info(): void {}, warn(): void {}, error(): void {} },
    registerTool(): void {},
    registerContextEngine(
      _id: string,
      create: RegisteredContextEngineFactory,
    ): void {
      factory = create;
    },
  };

  const bridge = new OpenClawBridge();
  bridge.register(api);
  assert(factory, "context engine factory not registered");
  const engine = factory!();

  const config = {
    dataDir,
    workspaceDir,
    sharedDataDir,
    contextWindow: 120,
    contextThreshold: 0.45,
    freshTailTokens: 24,
    maxFreshTailTurns: 1,
    compactionBatchTurns: 2,
    summaryMaxOutputTokens: 80,
  };

  await engine.bootstrap?.({ sessionId, config });

  const transcript: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let turn = 1; turn <= 4; turn += 1) {
    transcript.push({
      role: "user",
      content: `User turn ${turn}: ${"alpha ".repeat(28)}`,
    });
    transcript.push({
      role: "assistant",
      content: `Assistant turn ${turn}: ${"beta ".repeat(28)}`,
    });

    const payload = {
      sessionId,
      config,
      contextWindow: config.contextWindow,
      messages: transcript.map((message, index) => ({
        id: `m-${index + 1}`,
        role: message.role,
        content: [{ type: "text", text: message.content }],
      })),
    };

    await engine.assemble?.(payload);
    await engine.afterTurn?.(payload);
  }

  const rawPath = path.join(dataDir, `${sessionId}.raw.jsonl`);
  const summaryPath = path.join(dataDir, `${sessionId}.summaries.json`);
  const rawContent = await readFile(rawPath, "utf8");
  const summaryContent = await readFile(summaryPath, "utf8");

  const rawMessages = rawContent.split(/\r?\n/).filter(Boolean);
  const parsed = JSON.parse(summaryContent) as {
    schemaVersion?: number;
    summaries?: Array<Record<string, unknown>>;
  };
  const summaries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.summaries)
      ? parsed.summaries
      : [];

  assert(rawMessages.length >= transcript.length, "expected runtime transcript import to create raw message entries");
  assert(summaries.length > 0, "expected afterTurn fallback compaction to create summaries");

  const lastSummary = summaries[summaries.length - 1];
  assert(typeof lastSummary.summary === "string" && lastSummary.summary.length > 0, "expected non-empty summary text");

  await rm(dir, { recursive: true, force: true });
  console.log("test-runtime-fallback-lifecycle passed");
}

void main();
