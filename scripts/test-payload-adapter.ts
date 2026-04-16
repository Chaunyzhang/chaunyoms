import { DEFAULT_BRIDGE_CONFIG } from "../src/host/OpenClawHostServices";
import { OpenClawPayloadAdapter } from "../src/host/OpenClawPayloadAdapter";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  const warnings: Array<Record<string, unknown>> = [];
  const adapter = new OpenClawPayloadAdapter(
    () => ({
      session: { id: "api-session" },
      context: { model: { id: "gpt-test" } },
      config: {},
    }),
    () => ({
      info(): void {},
      warn(message: string, meta?: Record<string, unknown>): void {
        warnings.push({ message, meta });
      },
      error(): void {},
    }),
  );

  const contextFromConversation = adapter.resolveLifecycleContext(
    {
      conversation: {
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }], id: "u1" },
          { role: "assistant", content: "world", createdAt: "2026-04-16T12:00:00.000Z" },
        ],
      },
      config: { dataDir: "D:/tmp/chaunyoms", contextWindow: 1234 },
      tokenBudget: 888,
      systemPrompt: "sys",
    },
    DEFAULT_BRIDGE_CONFIG,
  );
  assert(contextFromConversation.sessionId === "api-session", "expected adapter to fall back to api session id");
  assert(contextFromConversation.totalBudget === 888, "expected smaller tokenBudget to win over config contextWindow");
  assert(contextFromConversation.summaryModel === "gpt-test", "expected model fallback from api context model");
  assert(contextFromConversation.runtimeMessages.length === 2, "expected conversation messages to normalize");
  assert(contextFromConversation.runtimeMessages[0].text === "hello", "expected array content to flatten to text");
  assert(
    contextFromConversation.runtimeMessages[1].timestamp === "2026-04-16T12:00:00.000Z",
    "expected createdAt to normalize into timestamp",
  );

  const ingestFromInput = adapter.resolveIngestPayload(
    {
      sessionId: "payload-session",
      id: "payload-id",
      role: "assistant",
      content: [{ type: "text", text: "ingest me" }],
      metadata: { source: "test" },
      turnNumber: 7,
      config: { workspaceDir: "D:/workspace" },
    },
    DEFAULT_BRIDGE_CONFIG,
  );
  assert(ingestFromInput.sessionId === "payload-session", "expected explicit session id to win");
  assert(ingestFromInput.id === "payload-id", "expected explicit id to win");
  assert(ingestFromInput.role === "assistant", "expected explicit role to win");
  assert(ingestFromInput.content === "ingest me", "expected ingest content to flatten");
  assert(ingestFromInput.turnNumber === 7, "expected explicit turn number to survive");
  assert(ingestFromInput.metadata?.source === "test", "expected metadata to survive");
  assert(ingestFromInput.config.workspaceDir === "D:/workspace", "expected config overrides to merge");

  const contextFromInputMessages = adapter.resolveLifecycleContext(
    {
      input: {
        messages: [
          { role: "user", content: "alpha" },
          { role: "tool", content: [{ text: "beta" }] },
        ],
      },
    },
    DEFAULT_BRIDGE_CONFIG,
  );
  assert(contextFromInputMessages.runtimeMessages.length === 2, "expected input.messages to normalize");
  assert(contextFromInputMessages.runtimeMessages[1].text === "beta", "expected tool content fallback to text");

  const contextWithHugeRuntimeBudget = adapter.resolveLifecycleContext(
    {
      tokenBudget: 5000,
      config: { contextWindow: 400 },
    },
    DEFAULT_BRIDGE_CONFIG,
  );
  assert(
    contextWithHugeRuntimeBudget.totalBudget === 400,
    "expected plugin config contextWindow to cap oversized runtime budgets",
  );

  assert(warnings.length === 0, "expected no warnings during normal payload normalization");
  console.log("test-payload-adapter passed");
}

main();
