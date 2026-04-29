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
    const contextEngineIds: string[] = [];
    const memoryCapabilities: Record<string, unknown>[] = [];
    const bridge = new OpenClawBridge();
    bridge.register({
      config: { enableTools: true },
      pluginConfig: config,
      logger: { info(): void {}, warn(): void {}, error(): void {} },
      registerTool(tool: { name: string; execute: (toolCallId: string, args: unknown) => Promise<unknown> }): void {
        tools.set(tool.name, tool);
      },
      registerContextEngine(id: string): void {
        contextEngineIds.push(id);
      },
      registerMemoryCapability(capability: unknown): void {
        if (capability && typeof capability === "object" && !Array.isArray(capability)) {
          memoryCapabilities.push(capability as Record<string, unknown>);
        }
      },
    });
    assert(contextEngineIds.length === 1, "only the final docs-exact oms context engine should be registered");
    assert(contextEngineIds.includes("oms"), "oms context engine should be registered for docs-compatible slot binding");
    assert(memoryCapabilities.length === 1, "OpenClaw memory capability should be registered exactly once");
    const memoryCapability = memoryCapabilities[0] as Record<string, unknown>;
    assert(memoryCapability.id === "oms", "memory capability should bind the docs-exact oms memory slot");
    assert(memoryCapability.pluginId === "oms", "memory capability should use the docs-exact OpenClaw plugin id");
    assert(memoryCapability.markdownHotPath === false, "memory capability must reject Markdown hot-path ownership");
    const memoryRuntime = memoryCapability.runtime as Record<string, unknown> | undefined;
    assert(typeof memoryRuntime?.search === "function", "memory capability should expose runtime.search");
    assert(typeof memoryRuntime?.get === "function", "memory capability should expose runtime.get");
    const memoryRuntimeRecord = memoryRuntime as Record<string, unknown>;
    assert(typeof memoryCapability.promptBuilder === "function", "memory capability should expose a prompt section builder");
    assert(typeof memoryCapability.flushPlanResolver === "function", "memory capability should expose a flush plan resolver");

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
    const compatibility = status?.details?.openClawCompatibility as Record<string, unknown> | undefined;
    assert(status?.details?.scope === "agent", "oms_status should default to agent scope");
    assert(statusCounts?.rawMessages === 2, "agent-scoped oms_status should report agent-wide raw message count");
    assert(compatibility?.mode === "advisory", "oms_status should expose OpenClaw compatibility contract state");

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
    assert(doctor?.details?.engineId === "oms", "oms_doctor should identify the engine");

    const setup = await tools.get("oms_setup_guide")?.execute("tool-setup", {
      sessionId: config.sessionId,
      config,
    }) as { details?: Record<string, unknown> } | undefined;
    assert(setup?.details?.purpose === "Configure ChaunyOMS as a SQLite-first runtime with Markdown assets as reviewed human-readable output.", "oms_setup_guide should explain setup intent");
    const recommendedConfig = setup?.details?.recommendedConfig as Record<string, unknown> | undefined;
    const recommendedPlugins = recommendedConfig?.plugins as Record<string, unknown> | undefined;
    assert(Boolean(recommendedPlugins), "oms_setup_guide should emit OpenClaw dual-slot plugin config");
    const recommendedSlots = recommendedPlugins?.slots as Record<string, unknown> | undefined;
    const recommendedEntries = recommendedPlugins?.entries as Record<string, unknown> | undefined;
    assert(recommendedSlots?.memory === "oms", "oms_setup_guide should recommend docs-exact memory slot binding");
    assert(recommendedSlots?.contextEngine === "oms", "oms_setup_guide should recommend docs-exact contextEngine slot binding");
    assert(Boolean(recommendedEntries?.oms), "oms_setup_guide should recommend an oms plugin entry");

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

    const plannerDebug = await tools.get("oms_planner_debug")?.execute("tool-planner-debug", {
      sessionId: config.sessionId,
      config,
      query: "刚才那个端口是多少",
      retrievalStrength: "strict",
    }) as { details?: Record<string, unknown> } | undefined;
    const planner = plannerDebug?.details?.planner as Record<string, unknown> | null | undefined;
    const plannerIntent = plannerDebug?.details?.plannerIntent;
    const plannerValidation = planner && typeof planner === "object"
      ? planner.validation as Record<string, unknown> | undefined
      : undefined;
    assert(plannerDebug?.details?.tool === "oms_planner_debug", "oms_planner_debug should identify the tool");
    assert(plannerDebug?.details?.selectedPlan === "planner", "oms_planner_debug should show planner selected for strict source-sensitive query");
    assert(plannerIntent === "history_trace" || plannerIntent === "precision_fact", "oms_planner_debug should classify strict Chinese exact recall");
    assert(plannerValidation?.accepted === true, "oms_planner_debug should expose accepted PlanValidator result");

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
    assert(tools.has("oms_brainpack_export"), "oms_brainpack_export should be registered");
    assert(tools.has("oms_brainpack_status"), "oms_brainpack_status should be registered");
    assert(tools.has("oms_native_policy_status"), "oms_native_policy_status should be registered");
    assert(tools.has("oms_native_absorb"), "oms_native_absorb should be registered");
    assert(tools.has("oms_benchmark_report"), "oms_benchmark_report should be registered");
    assert(tools.has("oms_recall_feedback"), "oms_recall_feedback should be registered");
    assert(tools.has("oms_setup_guide"), "oms_setup_guide should be registered");
    assert(tools.has("oms_doctor"), "oms_doctor should be registered");
    assert(tools.has("oms_verify"), "oms_verify should be registered");
    assert(tools.has("oms_backup"), "oms_backup should be registered");
    assert(tools.has("oms_restore"), "oms_restore should be registered");
    assert(tools.has("oms_wipe_session"), "oms_wipe_session should be registered");
    assert(tools.has("oms_wipe_agent"), "oms_wipe_agent should be registered");
    assert(tools.has("oms_inspect_context"), "oms_inspect_context should be registered");
    assert(tools.has("oms_why_recalled"), "oms_why_recalled should be registered");
    assert(tools.has("oms_planner_debug"), "oms_planner_debug should be registered");
    assert(tools.has("oms_asset_sync"), "oms_asset_sync should be registered");
    assert(tools.has("oms_asset_reindex"), "oms_asset_reindex should be registered");
    assert(tools.has("oms_asset_verify"), "oms_asset_verify should be registered");
    assert(tools.has("oms_test_start"), "oms_test_start should be registered");
    assert(tools.has("oms_test_status"), "oms_test_status should be registered");
    assert(tools.has("oms_test_result"), "oms_test_result should be registered");
    assert(tools.has("oms_test_list"), "oms_test_list should be registered");
    assert(tools.has("oms_test_cancel"), "oms_test_cancel should be registered");
    assert(tools.has("qa_start"), "qa_start should be registered");
    assert(tools.has("qa_status"), "qa_status should be registered");
    assert(tools.has("qa_report"), "qa_report should be registered");
    assert(tools.has("qa_runs"), "qa_runs should be registered");
    assert(tools.has("qa_cancel"), "qa_cancel should be registered");
    assert(tools.has("qa"), "qa should be registered");
    assert(tools.has("memory_retrieve"), "memory_retrieve should remain the primary retrieval entrypoint");
    assert(tools.has("memory_search"), "OpenClaw-compatible memory_search should be registered");
    assert(tools.has("memory_get"), "OpenClaw-compatible memory_get should be registered");
    assert(tools.has("memory_status"), "OpenClaw-compatible memory_status should be registered");
    assert(tools.has("memory_index"), "OpenClaw-compatible memory_index should be registered");
    assert(tools.has("memory_promote"), "OpenClaw-compatible memory_promote should be registered");
    assert(tools.has("memory_promote_explain"), "OpenClaw-compatible memory_promote_explain should be registered");
    assert(!tools.has("memory_route"), "memory_route should not be registered on the standard tool surface");
    assert(!tools.has("recall_detail"), "recall_detail should not be registered on the standard tool surface");
    assert(!tools.has("lcm_grep"), "legacy lcm aliases should not be registered on the standard tool surface");

    const memorySearch = await tools.get("memory_search")?.execute("memory-search", {
      sessionId: "tools-session-2",
      config: { ...config, sessionId: "tools-session-2" },
      q: "TRACE_PORT=19090",
      scope: "session",
      retrievalStrength: "strict",
    }) as { details?: Record<string, unknown> } | undefined;
    const searchCompatibility = memorySearch?.details?.toolCompatibility as Record<string, unknown> | undefined;
    assert(searchCompatibility?.openClawTool === "memory_search", "memory_search should identify its OpenClaw compatibility tool name");
    assert(searchCompatibility?.markdownHotPath === false, "memory_search must not use Markdown as a hot fact source");

    const slotSearch = await (memoryRuntimeRecord.search as (args?: unknown) => Promise<unknown>)({
      sessionId: "tools-session-2",
      config: { ...config, sessionId: "tools-session-2" },
      query: "TRACE_PORT=19090",
      scope: "session",
      retrievalStrength: "strict",
    }) as { details?: Record<string, unknown> };
    const slotSearchCompatibility = slotSearch.details?.toolCompatibility as Record<string, unknown> | undefined;
    assert(slotSearchCompatibility?.openClawTool === "memory_search", "memory slot runtime search should route to the OpenClaw-compatible search facade");
    assert(slotSearchCompatibility?.markdownHotPath === false, "memory slot runtime search must not use Markdown as a hot fact source");

    const slotPrompt = await (memoryCapability.promptBuilder as (args?: unknown) => Promise<Record<string, unknown>>)({
      sessionId: config.sessionId,
      config,
    });
    assert(String(slotPrompt.content ?? "").includes("Do not read or write MEMORY.md"), "memory prompt section should warn off Markdown memory hot paths");

    const slotFlushPlan = await (memoryCapability.flushPlanResolver as (args?: unknown) => Promise<Record<string, unknown>>)({
      sessionId: config.sessionId,
      config,
    });
    assert(slotFlushPlan.markdownHotPath === false, "memory flush plan should suppress Markdown hot-path writes");

    const memoryGet = await tools.get("memory_get")?.execute("memory-get", {
      sessionId: "tools-session-2",
      config: { ...config, sessionId: "tools-session-2" },
      ref: "message_id:tool-message-2",
    }) as { details?: Record<string, unknown> } | undefined;
    const getCompatibility = memoryGet?.details?.toolCompatibility as Record<string, unknown> | undefined;
    assert(getCompatibility?.openClawTool === "memory_get", "memory_get should identify its OpenClaw compatibility tool name");
    assert(memoryGet?.details?.targetFound === true, "memory_get should resolve source/message refs through OMS");

    const nativeAbsorb = await tools.get("oms_native_absorb")?.execute("native-absorb", {
      sessionId: config.sessionId,
      config: { ...config, openClawNativeMode: "absorbed" },
      feature: "dreaming",
      sourceId: "dream-tool-1",
      content: "Native dream candidate from tool surface.",
    }) as { details?: Record<string, unknown> } | undefined;
    assert(nativeAbsorb?.details?.absorbed === true, "oms_native_absorb should route absorbed native output into OMS candidate flow");
    assert(nativeAbsorb?.details?.becomesMemoryItem === false, "native absorb tool must not directly create MemoryItem authority");

    const benchmarkReport = await tools.get("oms_benchmark_report")?.execute("benchmark-report", {
      sessionId: config.sessionId,
      config,
      suite: "locomo-small",
      scope: "development_sample",
      systems: ["chaunyoms"],
      metrics: { accuracy: 0.75 },
    }) as { details?: Record<string, unknown> } | undefined;
    assert(benchmarkReport?.details?.claimLevel === "regression_only", "oms_benchmark_report should guard development samples as regression-only");
    assert(benchmarkReport?.details?.publicComparableAllowed === false, "development sample reports must not be public-comparable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-oms-runtime-tools passed");
}

void main();
