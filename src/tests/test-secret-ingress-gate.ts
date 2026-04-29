import { MemoryExtractionEngine } from "../engines/MemoryExtractionEngine";
import { KnowledgeIntentClassifier } from "../engines/KnowledgeIntentClassifier";
import { RuntimeMessageSnapshot } from "../host/OpenClawPayloadAdapter";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { RuntimeMessageIngress } from "../runtime/RuntimeMessageIngress";
import { RuntimeIngressService } from "../runtime/RuntimeIngressService";
import {
  MemoryItemDraftEntry,
  MemoryItemDraftRepository,
  RawMessage,
  RawMessageRepository,
} from "../types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function rawStore(messages: RawMessage[]): RawMessageRepository {
  return {
    async init() {},
    async append(message: RawMessage) { messages.push(message); },
    getAll() { return messages; },
    getByRange() { return []; },
    getByIds() { return []; },
    getBySequenceRange() { return []; },
    getRecentTail() { return []; },
    getRecentTailByTokens() { return []; },
    totalUncompactedTokens() { return 0; },
    getUncompactedMessages() { return []; },
    async markCompacted() {},
  };
}

function memoryDraftStore(): MemoryItemDraftRepository {
  return {
    async init() {},
    async addEntries() { return 0; },
    async replaceAll() {},
    search() { return []; },
    getAll() { return []; },
    count() { return 0; },
  };
}

async function main(): Promise<void> {
  const persistedRaw: RawMessage[] = [];
  const persistedDrafts: MemoryItemDraftEntry[] = [];
  const service = new RuntimeIngressService({
    runtimeIngress: new RuntimeMessageIngress(),
    extractionEngine: new MemoryExtractionEngine(),
    knowledgeIntentClassifier: new KnowledgeIntentClassifier(null, { info() {}, warn() {}, error() {}, debug() {} }),
    ensureSession: async () => ({
      rawStore: rawStore([]),
      memoryItemDraftStore: memoryDraftStore(),
    } as never),
    appendRawMessages: async (messages) => {
      persistedRaw.push(...messages);
    },
    persistMemoryItemDrafts: async (_store, entries) => {
      persistedDrafts.push(...entries);
    },
  });

  const runtimeMessages: RuntimeMessageSnapshot[] = [{
    id: "runtime-secret-1",
    sourceKey: "runtime-secret-1",
    role: "user",
    content: "Remember token=supersecret123456789 and never put it in git.",
    text: "Remember token=supersecret123456789 and never put it in git.",
    timestamp: "2026-04-29T00:00:00.000Z",
  }];
  const result = await service.syncRuntimeMessages("secret-session", {
    ...DEFAULT_BRIDGE_CONFIG,
    agentId: "agent-secret",
    sessionId: "secret-session",
  }, runtimeMessages);

  assert(result.importedMessages === 1, "runtime secret message should import once");
  assert(persistedRaw.length === 1, "one raw message should be persisted");
  assert(!persistedRaw[0].content.includes("supersecret123456789"), "raw persisted content must not contain plaintext secret");
  assert(persistedRaw[0].content.includes("[REDACTED_SECRET]"), "raw persisted content should include redaction marker");
  const metadata = persistedRaw[0].metadata ?? {};
  assert(metadata.secretIngressRedacted === true, "raw metadata should record ingress redaction");
  const findings = metadata.secretIngressFindings as Array<Record<string, unknown>>;
  assert(Array.isArray(findings) && findings.length === 1, "raw metadata should keep secret finding metadata");
  assert(typeof findings[0].hash === "string" && String(findings[0].hash).length === 64, "secret finding should store only a hash");
  assert(!JSON.stringify(metadata).includes("supersecret123456789"), "secret metadata must not contain plaintext");
  assert(persistedDrafts.every((draft) => !draft.text.includes("supersecret123456789")), "MemoryItem drafts must be extracted from redacted raw text");

  console.log("test-secret-ingress-gate passed");
}

void main();
