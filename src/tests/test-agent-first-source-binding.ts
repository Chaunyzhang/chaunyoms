import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";
import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";
import { SourceMessageResolver } from "../resolvers/SourceMessageResolver";
import { RawMessageStore } from "../stores/RawMessageStore";
import { RawMessage, SummaryEntry } from "../types";
import { hashRawMessages } from "../utils/integrity";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function raw(overrides: Partial<RawMessage> & Pick<RawMessage, "id" | "sessionId" | "content">): RawMessage {
  return {
    role: "user",
    turnNumber: 1,
    createdAt: new Date().toISOString(),
    tokenCount: 5,
    compacted: false,
    ...overrides,
  };
}

function summaryFor(messages: RawMessage[], overrides: Partial<SummaryEntry> = {}): SummaryEntry {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const sourceHash = hashRawMessages(messages);
  return {
    id: `summary-${first.sessionId}`,
    sessionId: first.sessionId,
    agentId: first.agentId,
    summary: `Summary for ${first.sessionId}`,
    keywords: [first.sessionId],
    toneTag: "test",
    constraints: [],
    decisions: [],
    blockers: [],
    exactFacts: [],
    startTurn: first.turnNumber,
    endTurn: last.turnNumber,
    sourceFirstMessageId: first.id,
    sourceLastMessageId: last.id,
    sourceMessageIds: messages.map((message) => message.id),
    sourceSequenceMin: first.sequence,
    sourceSequenceMax: last.sequence,
    sourceBinding: SourceMessageResolver.bindingFromMessages({
      sessionId: first.sessionId,
      agentId: first.agentId,
      messages,
      sourceHash,
      sourceMessageCount: messages.length,
    }),
    tokenCount: 5,
    createdAt: new Date().toISOString(),
    sourceHash,
    sourceMessageCount: messages.length,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-agent-first-source-"));
  try {
    const rawStore = new RawMessageStore(dir, "agent-1");
    await rawStore.init();
    await rawStore.append(raw({
      id: "s1-u1",
      sessionId: "session-1",
      agentId: "agent-1",
      content: "Session one source message",
    }));
    await rawStore.append(raw({
      id: "s2-u1",
      sessionId: "session-2",
      agentId: "agent-1",
      content: "Session two source message with same turn",
    }));

    const s1Messages = rawStore.getAll({ sessionId: "session-1" });
    const s2Messages = rawStore.getAll({ sessionId: "session-2" });
    assert(s1Messages.length === 1 && s2Messages.length === 1, "expected agent raw pool to retain per-session filtering");
    assert(s1Messages[0].turnNumber === s2Messages[0].turnNumber, "test requires overlapping turn numbers");

    const resolver = new SourceMessageResolver();
    const boundSummary = summaryFor(s1Messages);
    const byBinding = resolver.resolve(rawStore, boundSummary);
    assert(byBinding.verified, "expected explicit evidence binding to verify");
    assert(byBinding.messages.length === 1, "expected one source message from bound session");
    assert(byBinding.messages[0].id === "s1-u1", "expected binding to resolve session-1 source only");

    const legacyRangeSummary = summaryFor(s1Messages, {
      sourceBinding: undefined,
      sourceMessageIds: [],
      sourceSequenceMin: undefined,
      sourceSequenceMax: undefined,
    });
    const byLegacyRange = resolver.resolve(rawStore, legacyRangeSummary);
    assert(byLegacyRange.verified, "expected legacy turn range fallback to verify within summary session only");
    assert(byLegacyRange.messages.length === 1, "expected legacy range fallback not to cross session");
    assert(byLegacyRange.messages[0].id === "s1-u1", "expected legacy range fallback to keep session boundary");

    const config = {
      ...DEFAULT_BRIDGE_CONFIG,
      dataDir: path.join(dir, "data"),
      workspaceDir: path.join(dir, "workspace"),
      sharedDataDir: path.join(dir, "shared"),
      memoryVaultDir: path.join(dir, "vault"),
      knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),
      agentId: "agent-1",
      sessionId: "session-1",
    };
    const runtime = new ChaunyomsSessionRuntime(
      { info(): void {}, warn(): void {}, error(): void {} },
      null,
      config,
      createRuntimeLayerDependencies(),
    );
    const stores1 = await runtime.getSessionStores({ sessionId: "session-1", config });
    const enqueued = await stores1.knowledgeRawStore.enqueue({
      id: "knowledge-raw-s1",
      sessionId: "session-1",
      agentId: "agent-1",
      sourceSummaryId: boundSummary.id,
      sourceSummary: boundSummary,
      sourceBinding: boundSummary.sourceBinding,
      intakeReason: "test",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assert(enqueued, "expected session-1 knowledge raw enqueue");

    const session2Config = { ...config, sessionId: "session-2" };
    const stores2 = await runtime.getSessionStores({ sessionId: "session-2", config: session2Config });
    assert(stores2.knowledgeRawStore.getAll().length === 0, "expected knowledge raw store cache to be session-bound");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-agent-first-source-binding passed");
}

void main();
