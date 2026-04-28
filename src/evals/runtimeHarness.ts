import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StablePrefixAdapter } from "../data/StablePrefixAdapter";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";
import { ChaunyomsRetrievalService } from "../runtime/ChaunyomsRetrievalService";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";
import { BridgeConfig, SummaryEntry } from "../types";
import { EvalCaseDefinition, EvalExplicitMessage, EvalSeedKnowledgeDraft } from "./types";

function transcriptSnippetsFromPrompt(prompt: string): string[] {
  const snippets: string[] = [];
  const transcriptPattern = /Turn \d+ \| (?:user|assistant)\n([\s\S]*?)(?=\n\nTurn \d+ \| (?:user|assistant)\n|$)/g;
  for (const match of prompt.matchAll(transcriptPattern)) {
    const snippet = match[1]?.replace(/\s+/g, " ").trim();
    if (snippet) {
      snippets.push(snippet);
    }
  }
  return snippets;
}

function uniqueLimited(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized.toLowerCase())) {
      continue;
    }
    seen.add(normalized.toLowerCase());
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function extractSearchTerms(text: string): string[] {
  const stopWords = new Set([
    "about", "after", "again", "assistant", "before", "between", "conversation",
    "current", "earlier", "exact", "from", "have", "locomo", "message",
    "sample", "session", "source", "speaker", "that", "their", "there", "these",
    "they", "this", "turn", "user", "with", "would", "you", "your",
  ]);
  return uniqueLimited(
    text
      .split(/[^A-Za-z0-9\u4e00-\u9fff:'"-]+/g)
      .map((term) => term.replace(/^['"]|['"]$/g, "").trim())
      .filter((term) => term.length >= 3 && !stopWords.has(term.toLowerCase())),
    80,
  );
}

function extractExactFacts(text: string): string[] {
  const patterns = [
    /[A-Z_]+=[A-Za-z0-9:._-]+/g,
    /\bD\d+:\d+\b/g,
    /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+\d{4}\b/gi,
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+\d{4}\b/gi,
    /\b\d{4}\b/g,
    /\b\d+\s+(?:years?|weeks?|months?|days?|hours?)\b/gi,
    /"[^"]{3,80}"/g,
  ];
  return uniqueLimited(patterns.flatMap((pattern) => Array.from(text.matchAll(pattern), (match) => match[0])), 80);
}

function syntheticSummaryFromPrompt(prompt: string): string {
  const transcriptSnippets = transcriptSnippetsFromPrompt(prompt);
  const sourceText = transcriptSnippets.length > 0 ? transcriptSnippets.join(" ") : prompt;
  const exactFacts = extractExactFacts(sourceText);
  const keywords = extractSearchTerms(sourceText);
  const summaryBody = sourceText.replace(/\s+/g, " ").slice(0, 6000);
  return JSON.stringify({
    summary: `Synthetic source-grounded summary: ${summaryBody}`,
    keywords: ["eval", "memory", ...keywords],
    toneTag: "focused",
    memoryType: "project_state",
    phase: "implementation",
    constraints: ["preserve source-grounded facts"],
    decisions: ["prefer source-trace-backed retrieval"],
    blockers: [],
    nextSteps: ["continue evaluation replay"],
    keyEntities: uniqueLimited(["ChaunyomsSessionRuntime", "ChaunyomsRetrievalService", ...keywords.filter((term) => /^[A-Z]/.test(term))], 40),
    exactFacts,
    promotionIntent: "candidate",
  });
}

export function materializeMessages(caseDef: EvalCaseDefinition): EvalExplicitMessage[] {
  if (Array.isArray(caseDef.messages)) {
    return caseDef.messages;
  }
  const generated = caseDef.generatedScenario;
  if (!generated || generated.kind !== "marker_replay") {
    return [];
  }
  const markerMap = new Map<number, string>(
    generated.markers.map((marker) => [marker.turn, marker.text]),
  );
  const messages: EvalExplicitMessage[] = [];
  for (let turn = 1; turn <= generated.turns; turn += 1) {
    const marker = markerMap.get(turn) ?? `routine-${turn}`;
    const prefix = generated.fillerPrefix ?? "Replay turn";
    const content = `${prefix} ${turn}. Keep project memory organized. ${marker}. ${"context ".repeat(18)}`;
    messages.push({ role: "user", content });
    messages.push({ role: "assistant", content: `Assistant response ${turn}. ${content}` });
  }
  return messages;
}

export async function buildEvalHarness(caseDef: EvalCaseDefinition): Promise<{
  dir: string;
  config: BridgeConfig;
  runtime: ChaunyomsSessionRuntime;
  retrieval: ChaunyomsRetrievalService;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-eval-suite-"));
  const config: BridgeConfig = {
    ...DEFAULT_BRIDGE_CONFIG,
    dataDir: path.join(dir, "data"),
    workspaceDir: path.join(dir, "workspace"),
    sharedDataDir: path.join(dir, "shared"),
    memoryVaultDir: path.join(dir, "vault"),
    knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
    sessionId: caseDef.id,
    ...(caseDef.configOverrides ?? {}),
  };

  await mkdir(path.join(config.workspaceDir, "memory"), { recursive: true });

  const runtime = new ChaunyomsSessionRuntime(
    { info(): void {}, warn(): void {}, error(): void {} },
    {
      async call(params): Promise<string> {
        return syntheticSummaryFromPrompt(params.prompt);
      },
    },
    config,
    createRuntimeLayerDependencies(),
  );
  await runtime.bootstrap({
    sessionId: config.sessionId,
    config,
    totalBudget: config.contextWindow,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });

  const payloadAdapter = new OpenClawPayloadAdapter(
    () => ({ config: {} }),
    () => ({ info(): void {}, warn(): void {}, error(): void {} }),
  );
  const retrieval = new ChaunyomsRetrievalService(
    runtime,
    payloadAdapter,
    {
      fixedPrefixProvider: new StablePrefixAdapter(),
    },
  );

  return { dir, config, runtime, retrieval };
}

export async function seedKnowledge(
  runtime: ChaunyomsSessionRuntime,
  config: BridgeConfig,
  seeds: EvalSeedKnowledgeDraft[],
): Promise<void> {
  if (seeds.length === 0) {
    return;
  }
  const stores = await runtime.getSessionStores({ sessionId: config.sessionId, config });
  for (const seed of seeds) {
    const summary: SummaryEntry = {
      id: `${seed.id}-summary`,
      sessionId: config.sessionId,
      agentId: config.agentId,
      summary: seed.summary,
      keywords: seed.tags,
      toneTag: "neutral",
      constraints: [],
      decisions: [],
      blockers: [],
      exactFacts: [],
      startTurn: 1,
      endTurn: 1,
      tokenCount: 16,
      createdAt: new Date().toISOString(),
      sourceHash: `${seed.id}-hash`,
      sourceMessageCount: 1,
    };
    await stores.knowledgeStore.writePromotion(
      summary,
      {
        shouldWrite: true,
        reason: "eval_seed_knowledge",
        bucket: seed.bucket,
        slug: seed.slug,
        title: seed.title,
        summary: seed.summary,
        tags: seed.tags,
        canonicalKey: seed.canonicalKey,
        body: seed.body,
        status: seed.status,
      },
      {
        sessionId: config.sessionId,
        sourceHash: summary.sourceHash,
        sourceMessageCount: summary.sourceMessageCount,
        promptVersion: "eval-seed-v1",
        modelName: "eval-seed-model",
      },
    );
  }
}

export async function replayMessages(
  runtime: ChaunyomsSessionRuntime,
  config: BridgeConfig,
  messages: EvalExplicitMessage[],
  afterTurnEvery?: number,
): Promise<void> {
  let turnNumber = 0;
  for (const message of messages) {
    if (message.role === "user") {
      turnNumber += 1;
    }
    await runtime.ingest({
      sessionId: config.sessionId,
      config,
      id: `${message.role}-${turnNumber}-${Math.random().toString(36).slice(2, 8)}`,
      role: message.role,
      content: message.content,
      turnNumber,
    });
    if (
      afterTurnEvery &&
      afterTurnEvery > 0 &&
      message.role === "assistant" &&
      turnNumber > 0 &&
      turnNumber % afterTurnEvery === 0
    ) {
      await runtime.compact({
        sessionId: config.sessionId,
        config,
        totalBudget: config.contextWindow,
        systemPromptTokens: 0,
        runtimeMessages: [],
      });
      await runtime.afterTurn({
        sessionId: config.sessionId,
        config,
        totalBudget: config.contextWindow,
        systemPromptTokens: 0,
        runtimeMessages: [],
      });
    }
  }
}

export async function finalizeReplay(
  runtime: ChaunyomsSessionRuntime,
  config: BridgeConfig,
): Promise<void> {
  await runtime.compact({
    sessionId: config.sessionId,
    config,
    totalBudget: config.contextWindow,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });
  await runtime.afterTurn({
    sessionId: config.sessionId,
    config,
    totalBudget: config.contextWindow,
    systemPromptTokens: 0,
    runtimeMessages: [],
  });
}

export async function cleanupEvalHarness(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function writeReportArtifacts(
  reportDir: string,
  jsonFileName: string,
  markdownFileName: string,
  json: string,
  markdown: string,
): Promise<void> {
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, jsonFileName), json, "utf8");
  await writeFile(path.join(reportDir, markdownFileName), markdown, "utf8");
}
