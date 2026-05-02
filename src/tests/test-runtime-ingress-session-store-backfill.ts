import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { RuntimeMessageIngress } from "../runtime/RuntimeMessageIngress";
import { RuntimeIngressService } from "../runtime/RuntimeIngressService";
import { RuntimeMessageSnapshot } from "../host/OpenClawPayloadAdapter";
import { MemoryItemDraftEntry, RawMessage } from "../types";
import { SessionDataStores } from "../data/SessionDataLayer";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

class InMemoryRawStore {
  private readonly messages: RawMessage[] = [];

  getAll(): RawMessage[] {
    return [...this.messages];
  }

  appendRawMessages(messages: RawMessage[]): void {
    this.messages.push(...messages);
  }
}

async function main(): Promise<void> {
  const openclawHome = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-openclaw-home-"));
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = openclawHome;

  try {
    const sessionId = "session-backfill-1";
    const agentId = "main";
    const sessionDir = path.join(openclawHome, "agents", agentId, "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "message",
          id: "user-msg-1",
          timestamp: "2026-05-02T01:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "I graduated with a degree in Business Administration." }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-msg-1",
          timestamp: "2026-05-02T01:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ack-1" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const rawStore = new InMemoryRawStore();
    const memoryItemDraftStore = {
      getAll(): MemoryItemDraftEntry[] {
        return [];
      },
    } as unknown as SessionDataStores["memoryItemDraftStore"];

    const service = new RuntimeIngressService({
      runtimeIngress: new RuntimeMessageIngress(),
      extractionEngine: {
        extractFromRawMessage(): MemoryItemDraftEntry[] {
          return [];
        },
      } as never,
      knowledgeIntentClassifier: {
        async classifyUserMessage(): Promise<null> {
          return null;
        },
      } as never,
      ensureSession: async () => ({
        rawStore: rawStore as never,
        memoryItemDraftStore,
      } as unknown as SessionDataStores),
      appendRawMessages: async (messages) => {
        rawStore.appendRawMessages(messages);
      },
      persistMemoryItemDrafts: async () => {},
    });

    const runtimeMessages: RuntimeMessageSnapshot[] = [
      {
        sourceKey: "runtime-user-only",
        role: "user",
        content: "I graduated with a degree in Business Administration.",
        text: "I graduated with a degree in Business Administration.",
        timestamp: "2026-05-02T01:00:00.000Z",
      },
    ];

    const imported = await service.syncRuntimeMessages(
      sessionId,
      {
        ...DEFAULT_BRIDGE_CONFIG,
        agentId,
        sessionId,
        runtimeCaptureEnabled: true,
        emergencyBrake: false,
        openClawRuntimeProfile: "lightweight",
      },
      runtimeMessages,
    );

    const stored = rawStore.getAll();
    assert(imported.importedMessages === 2, `expected 2 imported messages, got ${imported.importedMessages}`);
    assert(stored.length === 2, `expected 2 stored messages, got ${stored.length}`);
    assert(stored.some((message) => message.role === "assistant" && message.content.includes("ack-1")), "expected assistant turn to be backfilled from session store");
    assert(stored.some((message) => message.role === "user" && message.content.includes("Business Administration")), "expected user turn to remain imported");
  } finally {
    if (previousOpenClawHome) {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    } else {
      delete process.env.OPENCLAW_HOME;
    }
    await rm(openclawHome, { recursive: true, force: true });
  }

  console.log("test-runtime-ingress-session-store-backfill passed");
}

void main();
