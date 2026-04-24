import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OpenClawBridge } from "../OpenClawBridge";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-oms-tools-"));
  try {
    const config = {
      ...DEFAULT_BRIDGE_CONFIG,
      dataDir: path.join(dir, "data"),
      workspaceDir: path.join(dir, "workspace"),
      sharedDataDir: path.join(dir, "shared"),
      memoryVaultDir: path.join(dir, "vault"),
      knowledgeBaseDir: path.join(dir, "knowledge"),
      sessionId: "tools-session",
      agentId: "agent-tools",
      enableTools: true,
    };
    const tools = new Map<string, { execute: (toolCallId: string, args: unknown) => Promise<unknown> }>();
    const bridge = new OpenClawBridge();
    bridge.register({
      config: { enableTools: true },
      pluginConfig: config,
      logger: { info(): void {}, warn(): void {}, error(): void {} },
      registerTool(tool: { name: string; execute: (toolCallId: string, args: unknown) => Promise<unknown> }): void {
        tools.set(tool.name, tool);
      },
      registerContextEngine(): void {},
    });

    await bridge.ingest({
      sessionId: config.sessionId,
      config,
      id: "tool-message-1",
      role: "user",
      content: "Remember TRACE_PORT=15432 for the runtime tool test.",
      turnNumber: 1,
    });

    const grep = await tools.get("oms_grep")?.execute("tool-1", {
      sessionId: config.sessionId,
      config,
      query: "TRACE_PORT=15432",
    }) as { details?: Record<string, unknown> } | undefined;
    assert(grep?.details?.hitCount === 1, "oms_grep should return the raw message hit");

    const replay = await tools.get("oms_replay")?.execute("tool-2", {
      sessionId: config.sessionId,
      config,
      startTurn: 1,
      endTurn: 1,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(replay?.details?.messageCount === 1, "oms_replay should replay the ingested turn");

    assert(tools.has("oms_expand"), "oms_expand should be registered");
    assert(tools.has("oms_trace"), "oms_trace should be registered");
    assert(tools.has("memory_retrieve"), "memory_retrieve should remain the primary retrieval entrypoint");
    assert(!tools.has("memory_route"), "memory_route should not be registered on the standard tool surface");
    assert(!tools.has("recall_detail"), "recall_detail should not be registered on the standard tool surface");
    assert(!tools.has("lcm_grep"), "legacy lcm aliases should not be registered on the standard tool surface");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-oms-runtime-tools passed");
}

void main();
