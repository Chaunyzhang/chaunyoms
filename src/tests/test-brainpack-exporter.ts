import { mkdtemp, rm, readFile } from "node:fs/promises";

import os from "node:os";

import path from "node:path";



import { BrainPackExporter } from "../brainpack/BrainPackExporter";

import { BrainPackScheduler } from "../brainpack/BrainPackScheduler";

import { SecretScanner } from "../brainpack/SecretScanner";

import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";

import { MemoryItemDraftEntry, RawMessage, SummaryEntry } from "../types";



function assert(condition: unknown, message: string): void {

  if (!condition) {

    throw new Error(message);

  }

}



const logger = { info(): void {}, warn(): void {}, error(): void {} };



async function main(): Promise<void> {

  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-brainpack-"));

  try {

    const store = new SQLiteRuntimeStore({

      dbPath: path.join(dir, "runtime.sqlite"),

      agentId: "agent-brain",

      knowledgeBaseDir: path.join(dir, "knowledge"),

      logger,

    });

    const messages: RawMessage[] = [{

      id: "m-secret",

      sessionId: "s-brain",

      agentId: "agent-brain",

      role: "user",

      content: "Remember the project uses a safe projection.",

      turnNumber: 1,

      sequence: 1,

      createdAt: "2026-04-28T00:00:00.000Z",

      tokenCount: 8,

      compacted: false,

    }];

    const memories: MemoryItemDraftEntry[] = [{

      id: "memory-secret",

      sessionId: "s-brain",

      agentId: "agent-brain",

      kind: "constraint",

      recordStatus: "active",

      text: "Never commit token=supersecret123456789 to git.",

      fingerprint: "fp-secret",

      tags: ["security"],

      createdAt: "2026-04-28T00:00:01.000Z",

      sourceType: "raw_message",

      sourceIds: ["m-secret"],

      metadata: { apiKey: "REDACT_ME" },

    }];

    const summaries: SummaryEntry[] = [{

      id: "summary-base-1",

      sessionId: "s-brain",

      agentId: "agent-brain",

      summary: "Project uses a safe projection.",

      keywords: ["safe", "projection"],

      toneTag: "fixture",

      constraints: ["Do not export raw transcript by default."],

      decisions: [],

      blockers: [],

      exactFacts: ["BrainPack is Git-safe projection."],

      startTurn: 1,

      endTurn: 1,

      sourceMessageIds: ["m-secret"],

      sourceBinding: {

        scope: "session",

        sessionId: "s-brain",

        agentId: "agent-brain",

        messageIds: ["m-secret"],

      },

      summaryLevel: 1,

      nodeKind: "leaf",

      tokenCount: 8,

      createdAt: "2026-04-28T00:00:02.000Z",

      sourceHash: "fixture-source-hash",

      sourceMessageCount: 1,

    }];

    await store.mirror({ messages, summaries, memories, atoms: [] });

    store.recordRetrievalUsageEvents([{

      eventType: "verified_answer_used",

      targetKind: "memory_item",

      targetId: "memory-item:memory-secret",

      sessionId: "s-brain",

      agentId: "agent-brain",

      query: "safe projection",

      route: "memory_item",

      retrievalStrength: "high",

      sourceVerified: true,

      answerUsed: true,

    }]);



    const config = {

      ...DEFAULT_BRIDGE_CONFIG,

      agentId: "agent-brain",

      sessionId: "s-brain",

      workspaceDir: dir,

      brainPackOutputDir: path.join(dir, "agent-brainpack"),

      brainPackRedactionMode: "redact" as const,

    };

    const result = await new BrainPackExporter(store, config).export({ reason: "manual" });

    assert(result.ok, "brainpack export should complete");

    assert(result.files.includes("manifest.json"), "manifest should be written");

    assert(result.files.includes("reports/redaction-report.json"), "redaction report should be written");

    assert(result.files.includes("summaries/base-summaries.jsonl"), "base summary map should be written");

    assert(result.files.includes("summaries/summary-tree.jsonl"), "summary tree map should be written");

    assert(result.files.includes("summaries/source-map.jsonl"), "summary source map should be written");

    assert(result.files.includes("summaries/summary-index.md"), "summary index should be written");

    const memoryFile = await readFile(path.join(result.outputDir, "memory", "memory-items.jsonl"), "utf8");

    assert(!memoryFile.includes("supersecret123456789"), "secret assignment value must be redacted from memory projection");

    assert(!memoryFile.includes("REDACT_ME"), "metadata api key must be redacted from memory projection");

    assert(memoryFile.includes("[REDACTED_SECRET]") || memoryFile.includes("[REDACTED_FIELD]"), "projection should contain redaction markers");

    const usageFile = await readFile(path.join(result.outputDir, "retrieval", "usage-stats.jsonl"), "utf8");

    assert(usageFile.includes("verifiedAnswerUsedCount"), "usage stats should be projected");

    const sourceMap = await readFile(path.join(result.outputDir, "summaries", "source-map.jsonl"), "utf8");

    assert(sourceMap.includes("summary-base-1"), "summary source map should preserve summary id");

    assert(sourceMap.includes("m-secret"), "summary source map should preserve source message handles without exporting transcript");



    const scan = new SecretScanner().scanText("memory/test.json", "token=supersecret123456789", "strict");

    const directFinding = scan.findings[0];

    assert(directFinding !== undefined, "direct scanner should report secret assignment");

    if (!directFinding) {

      throw new Error("direct scanner should report secret assignment");

    }

    assert(directFinding.start === 0, "secret finding start offset should be exact");

    assert(directFinding.end === "token=supersecret123456789".length, "secret finding end offset should be exact");

    assert(directFinding.action === "blocked", "strict scanner should block high-risk plaintext instead of redacting and passing");

    assert(directFinding.hash.length === 64, "secret finding should expose hash, not value");

    assert(scan.blocked, "strict scanner should mark high-risk plaintext as blocked");



    const strictBlocked = await new BrainPackExporter(store, {

      ...config,

      brainPackOutputDir: path.join(dir, "agent-brainpack-strict"),

      brainPackRedactionMode: "strict" as const,

    }).export({ reason: "manual" });

    assert(!strictBlocked.ok, "strict brainpack export should block when high-risk plaintext is present");

    assert(strictBlocked.redactionReport.blockedGit, "strict brainpack redaction report should block git progression");

    assert(strictBlocked.files.length === 1 && strictBlocked.files[0] === "reports/redaction-report.json", "blocked strict export should leave only the control redaction report");



    const unsafeOutput = await new BrainPackExporter(store, config).export({

      reason: "manual",

      outputDir: path.dirname(dir),

    });

    assert(!unsafeOutput.ok, "brainpack export should refuse output directories outside the configured workspace/shared roots");

    assert(unsafeOutput.redactionReport.findings.some((finding) => finding.type === "unsafe_output_dir"), "unsafe output dir should be reported as a blocker");



    const scheduler = new BrainPackScheduler();

    assert(scheduler.shouldExport(config, { manual: true }).reason === "manual", "manual trigger should export");

    assert(scheduler.shouldExport(config, { currentTurn: 500, lastSnapshotTurn: 0 }).reason === "turn_count", "turn-count trigger should fire at interval");

    assert(scheduler.shouldExport(config, { now: new Date("2026-04-28T12:00:00.000Z"), lastSnapshotAt: "2026-04-27T11:00:00.000Z" }).reason === "interval", "24h interval trigger should fire after interval");

  } finally {

    await rm(dir, { recursive: true, force: true });

  }

  console.log("test-brainpack-exporter passed");

}



void main();
