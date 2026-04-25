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
    await bridge.assemble({ sessionId: config.sessionId, config });
    await bridge.ingest({
      sessionId: "tools-session-2",
      config: { ...config, sessionId: "tools-session-2" },
      id: "tool-message-2",
      role: "user",
      content: "Remember TRACE_PORT=19090 for the second session.",
      turnNumber: 1,
    });
    await bridge.assemble({ sessionId: "tools-session-2", config: { ...config, sessionId: "tools-session-2" } });

    const grep = await tools.get("oms_grep")?.execute("tool-1", {
      sessionId: config.sessionId,
      config,
      query: "TRACE_PORT=15432",
      scope: "session",
    }) as { details?: Record<string, unknown> } | undefined;
    assert(grep?.details?.hitCount === 1, "oms_grep should return the raw message hit");

    const grepAgent = await tools.get("oms_grep")?.execute("tool-1b", {
      sessionId: config.sessionId,
      config,
      query: "TRACE_PORT",
    }) as { details?: Record<string, unknown> } | undefined;
    assert(grepAgent?.details?.scope === "agent", "oms_grep should default to agent scope");
    assert(grepAgent?.details?.hitCount === 2, "agent-scoped oms_grep should see both sessions for the agent");

    const replay = await tools.get("oms_replay")?.execute("tool-2", {
      sessionId: config.sessionId,
      config,
      startTurn: 1,
      endTurn: 1,
      scope: "session",
    }) as { details?: Record<string, unknown> } | undefined;
    assert(replay?.details?.messageCount === 1, "oms_replay should replay the ingested turn");

    const replayAgent = await tools.get("oms_replay")?.execute("tool-2b", {
      sessionId: config.sessionId,
      config,
      startTurn: 1,
      endTurn: 1,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(replayAgent?.details?.scope === "agent", "oms_replay should default to agent scope");
    assert(replayAgent?.details?.messageCount === 2, "agent-scoped oms_replay should replay both sessions for the agent");

    const status = await tools.get("oms_status")?.execute("tool-3", {
      sessionId: config.sessionId,
      config,
    }) as { details?: Record<string, unknown> } | undefined;
    const statusCounts = status?.details?.counts as Record<string, unknown> | undefined;
    assert(status?.details?.scope === "agent", "oms_status should default to agent scope");
    assert(statusCounts?.rawMessages === 2, "agent-scoped oms_status should report agent-wide raw message count");

    const verify = await tools.get("oms_verify")?.execute("tool-4", {
      sessionId: config.sessionId,
      config,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(verify?.details?.scope === "agent", "oms_verify should default to agent scope");
    assert(typeof verify?.details?.ok === "boolean", "oms_verify should return an ok flag");

    const doctor = await tools.get("oms_doctor")?.execute("tool-5", {
      sessionId: config.sessionId,
      config,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(doctor?.details?.engineId === "chaunyoms", "oms_doctor should identify the engine");

    const setup = await tools.get("oms_setup_guide")?.execute("tool-setup", {
      sessionId: config.sessionId,
      config,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(setup?.details?.purpose === "Configure ChaunyOMS as a SQLite-first runtime with Markdown assets as reviewed human-readable output.", "oms_setup_guide should explain setup intent");

    const assetSync = await tools.get("oms_asset_sync")?.execute("tool-asset-sync", {
      sessionId: config.sessionId,
      config,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(assetSync?.details?.mode === "sync", "oms_asset_sync should synchronize Markdown assets into SQLite");

    const assetReindex = await tools.get("oms_asset_reindex")?.execute("tool-asset-reindex", {
      sessionId: config.sessionId,
      config,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(assetReindex?.details?.mode === "reindex", "oms_asset_reindex should rebuild the SQLite asset index");

    const assetVerify = await tools.get("oms_asset_verify")?.execute("tool-asset-verify", {
      sessionId: config.sessionId,
      config,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(typeof assetVerify?.details?.ok === "boolean", "oms_asset_verify should return an ok flag");

    const inspect = await tools.get("oms_inspect_context")?.execute("tool-6", {
      sessionId: config.sessionId,
      config,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(Boolean(inspect?.details?.run), "oms_inspect_context should expose the latest context run");

    const why = await tools.get("oms_why_recalled")?.execute("tool-7", {
      sessionId: config.sessionId,
      config,
      query: "TRACE_PORT",
    }) as { details?: Record<string, unknown> } | undefined;
    assert(Array.isArray(why?.details?.matches), "oms_why_recalled should return candidate matches");

    const backup = await tools.get("oms_backup")?.execute("tool-8", {
      sessionId: config.sessionId,
      config,
      label: "unit",
    }) as { details?: Record<string, unknown> } | undefined;
    assert(typeof backup?.details?.backupDir === "string", "oms_backup should create a backup directory");

    const restore = await tools.get("oms_restore")?.execute("tool-9", {
      sessionId: config.sessionId,
      config,
      backupDir: backup?.details?.backupDir,
      apply: false,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(restore?.details?.apply === false, "oms_restore should default safely to dry-run validation");

    const wipeSessionDryRun = await tools.get("oms_wipe_session")?.execute("tool-10", {
      sessionId: config.sessionId,
      config,
      apply: false,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(wipeSessionDryRun?.details?.scope === "session", "oms_wipe_session should report session scope");
    assert(wipeSessionDryRun?.details?.apply === false, "oms_wipe_session should default to dry-run");

    const wipeSessionApply = await tools.get("oms_wipe_session")?.execute("tool-11", {
      sessionId: config.sessionId,
      config,
      apply: true,
      backupBeforeApply: true,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(wipeSessionApply?.details?.apply === true, "oms_wipe_session should apply when requested");
    assert(typeof wipeSessionApply?.details?.backupDir === "string", "oms_wipe_session should create a backup before destructive apply by default");

    const wipedReplay = await tools.get("oms_replay")?.execute("tool-12", {
      sessionId: config.sessionId,
      config,
      scope: "session",
    }) as { details?: Record<string, unknown> } | undefined;
    assert(wipedReplay?.details?.messageCount === 0, "oms_wipe_session should remove session replay data");

    const wipedStatus = await tools.get("oms_status")?.execute("tool-13", {
      sessionId: config.sessionId,
      config,
      scope: "session",
    }) as { details?: Record<string, unknown> } | undefined;
    const wipedCounts = wipedStatus?.details?.counts as Record<string, unknown> | undefined;
    assert(wipedCounts?.rawMessages === 0, "oms_wipe_session should clear raw message count for the session");

    const remainingAgentReplay = await tools.get("oms_replay")?.execute("tool-13b", {
      sessionId: config.sessionId,
      config,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(remainingAgentReplay?.details?.messageCount === 1, "session wipe should preserve other sessions on the same agent");

    const wipeAgentDryRun = await tools.get("oms_wipe_agent")?.execute("tool-14", {
      sessionId: config.sessionId,
      config,
      apply: false,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(wipeAgentDryRun?.details?.scope === "agent", "oms_wipe_agent should report agent scope");
    assert(wipeAgentDryRun?.details?.apply === false, "oms_wipe_agent should remain dry-run by default");

    assert(tools.has("oms_expand"), "oms_expand should be registered");
    assert(tools.has("oms_trace"), "oms_trace should be registered");
    assert(tools.has("oms_status"), "oms_status should be registered");
    assert(tools.has("oms_setup_guide"), "oms_setup_guide should be registered");
    assert(tools.has("oms_doctor"), "oms_doctor should be registered");
    assert(tools.has("oms_verify"), "oms_verify should be registered");
    assert(tools.has("oms_backup"), "oms_backup should be registered");
    assert(tools.has("oms_restore"), "oms_restore should be registered");
    assert(tools.has("oms_wipe_session"), "oms_wipe_session should be registered");
    assert(tools.has("oms_wipe_agent"), "oms_wipe_agent should be registered");
    assert(tools.has("oms_inspect_context"), "oms_inspect_context should be registered");
    assert(tools.has("oms_why_recalled"), "oms_why_recalled should be registered");
    assert(tools.has("oms_asset_sync"), "oms_asset_sync should be registered");
    assert(tools.has("oms_asset_reindex"), "oms_asset_reindex should be registered");
    assert(tools.has("oms_asset_verify"), "oms_asset_verify should be registered");
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
