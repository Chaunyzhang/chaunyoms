import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import { ContextAssembler } from "../engines/ContextAssembler";
import {
  ContextItem,
  ContextViewRepository,
  FixedPrefixProvider,
  RawMessage,
  SummaryEntry,
} from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

class InMemoryContextViewStore implements ContextViewRepository {
  private items: ContextItem[] = [];

  setItems(items: ContextItem[]): void {
    this.items = items;
  }

  getItems(): ContextItem[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }
}

const emptyFixedPrefix: FixedPrefixProvider = {
  async load(): Promise<ContextItem[]> {
    return [];
  },
  async getKnowledgeBaseHit() {
    return null;
  },
  async hasKnowledgeBaseTopicHit() {
    return false;
  },
};

const logger = {
  info(): void {},
  warn(): void {},
  error(): void {},
};

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-context-evidence-"));
  try {
    const runtimeStore = new SQLiteRuntimeStore({
      dbPath: path.join(dir, "runtime.sqlite"),
      agentId: "agent-1",
      knowledgeBaseDir: path.join(dir, "knowledge"),
      logger,
    });
    const messages: RawMessage[] = [{
      id: "raw-melanie-race",
      sessionId: "material-session",
      agentId: "agent-1",
      role: "user",
      content: "Melanie ran a charity race on April 12, 2024, to support the adoption agency fundraiser.",
      turnNumber: 7,
      sequence: 7,
      createdAt: "2026-04-24T00:00:00.000Z",
      tokenCount: 22,
      compacted: true,
    }];
    const summaries: SummaryEntry[] = [{
      id: "summary-melanie-race",
      sessionId: "material-session",
      agentId: "agent-1",
      summary: "Melanie ran a charity race for an adoption agency fundraiser on April 12, 2024.",
      keywords: ["Melanie", "charity race", "adoption agency", "April 12 2024"],
      toneTag: "neutral",
      constraints: [],
      decisions: [],
      blockers: [],
      exactFacts: ["Melanie ran the charity race on April 12, 2024."],
      startTurn: 7,
      endTurn: 7,
      summaryLevel: 1,
      nodeKind: "leaf",
      tokenCount: 24,
      createdAt: "2026-04-24T00:00:01.000Z",
      sourceMessageIds: ["raw-melanie-race"],
      sourceFirstMessageId: "raw-melanie-race",
      sourceLastMessageId: "raw-melanie-race",
    }];
    await runtimeStore.mirror({ messages, summaries, memories: [] });

    const assembler = new ContextAssembler(new InMemoryContextViewStore(), emptyFixedPrefix);
    const result = await assembler.assembleFromRuntime(
      runtimeStore,
      800,
      0,
      80,
      4,
      dir,
      dir,
      {
        activeQuery: "When did Melanie run a charity race?",
        sessionId: "question-session",
        forceDagOnlyRecall: true,
      },
    );

    assert(
      result.evidenceDelivery.status === "delivered",
      `expected delivered evidence, got ${result.evidenceDelivery.status}`,
    );
    assert(
      result.evidenceDelivery.deliveredToOpenClaw === true,
      "summary-derived raw evidence should be selected into OpenClaw context",
    );
    assert(
      result.evidenceDelivery.route === "summary_raw_expand",
      `expected summary_raw_expand route, got ${result.evidenceDelivery.route}`,
    );
    assert(
      result.evidenceDelivery.selectedRawSourceCount >= 1,
      "selectedRawSourceCount should count delivered raw evidence items",
    );
    assert(
      result.evidenceDelivery.summaryDerivedRawSourceCount >= 1,
      "summaryDerivedRawSourceCount should count delivered summary-derived raw evidence",
    );
    assert(
      result.evidenceDelivery.rawMessageIds.includes("raw-melanie-race"),
      "receipt should include the delivered raw message id",
    );
    assert(
      result.evidenceDelivery.sourceSummaryIds.includes("summary-melanie-race"),
      "receipt should include the source summary id",
    );
    assert(
      result.items.some((item) => item.content.includes("April 12, 2024")),
      "OpenClaw context should contain the nearby raw answer text",
    );

    console.log("test-context-assembly-evidence-delivery passed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void main();
