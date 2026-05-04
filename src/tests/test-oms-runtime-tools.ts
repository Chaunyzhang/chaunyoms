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
    const cliRegistrations: Array<{
      registrar: (ctx: { program: FakeCliCommand }) => void | Promise<void>;
      opts?: { commands?: string[]; descriptors?: unknown[] };
    }> = [];
    class FakeCliCommand {
      readonly children: FakeCliCommand[] = [];
      handler?: (...args: unknown[]) => unknown;
      descriptionText?: string;
      constructor(readonly nameAndArgs: string) {}
      command(nameAndArgs: string): FakeCliCommand {
        const child = new FakeCliCommand(nameAndArgs);
        this.children.push(child);
        return child;
      }
      description(description: string): FakeCliCommand {
        this.descriptionText = description;
        return this;
      }
      option(): FakeCliCommand {
        return this;
      }
      argument(): FakeCliCommand {
        return this;
      }
      action(handler: (...args: unknown[]) => unknown): FakeCliCommand {
        this.handler = handler;
        return this;
      }
    }
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
      registerCli(
        registrar: (ctx: any) => void | Promise<void>,
        opts?: { commands?: string[]; descriptors?: unknown[] },
      ): void {
        cliRegistrations.push({ registrar, opts });
      },
    });
    assert(cliRegistrations.length === 1, "OMS should register OpenClaw CLI compatibility commands");
    const cliOptions = cliRegistrations[0].opts as { commands?: unknown; descriptors?: unknown } | undefined;
    assert(Array.isArray(cliOptions?.commands), "OMS CLI registration should declare command roots");
    assert((cliOptions?.commands as unknown[]).includes("memory"), "OMS should own the OpenClaw memory CLI root when memory-core is disabled");
    assert((cliOptions?.commands as unknown[]).includes("oms"), "OMS should own an oms diagnostics CLI root");
    const fakeProgram = new FakeCliCommand("root");
    await cliRegistrations[0].registrar({ program: fakeProgram });
    const memoryCli = fakeProgram.children.find((child) => child.nameAndArgs === "memory");
    const omsCli = fakeProgram.children.find((child) => child.nameAndArgs === "oms");
    assert(Boolean(memoryCli), "OMS CLI registrar should register memory root");
    assert(Boolean(omsCli), "OMS CLI registrar should register oms root");
    assert(Boolean(memoryCli?.children.find((child) => child.nameAndArgs === "status")), "OMS memory CLI should expose status");
    assert(Boolean(memoryCli?.children.find((child) => child.nameAndArgs === "search [query]")), "OMS memory CLI should expose search");
    assert(Boolean(memoryCli?.children.find((child) => child.nameAndArgs === "index")), "OMS memory CLI should expose index");
    assert(Boolean(omsCli?.children.find((child) => child.nameAndArgs === "doctor")), "OMS diagnostics CLI should expose doctor");
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
    assert(typeof memoryRuntimeRecord.getMemorySearchManager === "function", "memory runtime should expose OpenClaw getMemorySearchManager");
    assert(typeof memoryRuntimeRecord.resolveMemoryBackendConfig === "function", "memory runtime should expose OpenClaw resolveMemoryBackendConfig");
    assert(typeof memoryRuntimeRecord.closeAllMemorySearchManagers === "function", "memory runtime should expose OpenClaw closeAllMemorySearchManagers");
    const backendConfig = (memoryRuntimeRecord.resolveMemoryBackendConfig as (args?: unknown) => Record<string, unknown>)({
      cfg: { memory: { backend: "qmd", citations: "auto" } },
      agentId: config.agentId,
    });
    const backendCustom = backendConfig.custom as Record<string, unknown> | undefined;
    assert(backendConfig.backend === "builtin", "OMS runtime should return a non-qmd OpenClaw-compatible backend config");
    assert(backendCustom?.activeRuntime === "oms", "backend config should identify OMS as the active runtime");
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

    const formalQuestionSessionId = "tools-formal-question-session";
    await bridge.ingest({

      sessionId: formalQuestionSessionId,

      config: { ...config, sessionId: formalQuestionSessionId },

      id: "tool-formal-question",

      role: "user",

      content: [
        "Answer this LOCOMO memory question from OMS-recalled raw evidence.",
        "Before answering, call the OpenClaw OMS memory plugin/tool to search historical evidence.",
        "",
        "Question: What did Caroline research?",
      ].join("\n"),

      turnNumber: 1,

    });

    await bridge.assemble({ sessionId: formalQuestionSessionId, config: { ...config, sessionId: formalQuestionSessionId } });

    const canonicalSearch = await tools.get("memory_search")?.execute("tool-canonical-query", {

      sessionId: formalQuestionSessionId,

      config: { ...config, sessionId: formalQuestionSessionId },

      q: "Caroline researched LGBTQ art project",

    }) as { details?: Record<string, unknown> } | undefined;

    assert(canonicalSearch?.details?.query === "What did Caroline research?", `OpenClaw memory_search should use the exact formal Question line instead of a rewritten keyword query, got ${String(canonicalSearch?.details?.query)}`);
    assert(canonicalSearch?.details?.originalToolQuery === "Caroline researched LGBTQ art project", "memory_search diagnostics should preserve the model-provided rewritten query");
    assert(canonicalSearch?.details?.canonicalQuerySource === "current_formal_question", "memory_search diagnostics should show current formal question override");
    assert(canonicalSearch?.details?.toolQueryOverridden === true, "memory_search should mark rewritten tool query overrides");



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

    assert(replayAgent?.details?.messageCount === 3, "agent-scoped oms_replay should replay material and formal-question sessions for the agent");



    const status = await tools.get("oms_status")?.execute("tool-3", {

      sessionId: config.sessionId,

      config,

    }) as { details?: Record<string, unknown> } | undefined;

    const statusCounts = status?.details?.counts as Record<string, unknown> | undefined;

    const compatibility = status?.details?.openClawCompatibility as Record<string, unknown> | undefined;

    assert(status?.details?.scope === "agent", "oms_status should default to agent scope");

    assert(statusCounts?.rawMessages === 3, "agent-scoped oms_status should report agent-wide raw message count including the formal question session");

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
    const recommendedAgents = recommendedConfig?.agents as Record<string, unknown> | undefined;
    const recommendedDefaults = recommendedAgents?.defaults as Record<string, unknown> | undefined;
    const recommendedMemorySearch = recommendedDefaults?.memorySearch as Record<string, unknown> | undefined;
    const recommendedPlugins = recommendedConfig?.plugins as Record<string, unknown> | undefined;
    assert(Boolean(recommendedPlugins), "oms_setup_guide should emit OpenClaw dual-slot plugin config");
    assert(recommendedMemorySearch?.enabled === false, "oms_setup_guide should disable OpenClaw native memorySearch in authoritative OMS mode");
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

      retrievalStrength: "high",

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

    assert(remainingAgentReplay?.details?.messageCount === 2, "session wipe should preserve other material/formal sessions on the same agent");



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

    assert(!tools.has("oms_test_start"), "legacy background QA tools must not be registered");
    assert(!tools.has("qa_start"), "legacy QA aliases must not be registered");
    assert(!tools.has("qa"), "unified legacy QA shortcut must not be registered");

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

      retrievalStrength: "high",

    }) as { details?: Record<string, unknown> } | undefined;

    const searchCompatibility = memorySearch?.details?.toolCompatibility as Record<string, unknown> | undefined;

    assert(searchCompatibility?.openClawTool === "memory_search", "memory_search should identify its OpenClaw compatibility tool name");

    assert(searchCompatibility?.markdownHotPath === false, "memory_search must not use Markdown as a hot fact source");



    const slotSearch = await (memoryRuntimeRecord.search as (args?: unknown) => Promise<unknown>)({

      sessionId: "tools-session-2",

      config: { ...config, sessionId: "tools-session-2" },

      query: "TRACE_PORT=19090",

      scope: "session",

      retrievalStrength: "high",

    }) as { details?: Record<string, unknown> };

    const slotSearchCompatibility = slotSearch.details?.toolCompatibility as Record<string, unknown> | undefined;
    assert(slotSearchCompatibility?.openClawTool === "memory_search", "memory slot runtime search should route to the OpenClaw-compatible search facade");
    assert(slotSearchCompatibility?.markdownHotPath === false, "memory slot runtime search must not use Markdown as a hot fact source");

    const managerEnvelope = await (memoryRuntimeRecord.getMemorySearchManager as (args?: unknown) => Promise<Record<string, unknown>>)({
      agentId: config.agentId,
      purpose: "status",
    });
    const manager = managerEnvelope.manager as Record<string, unknown> | undefined;
    if (!manager) {
      throw new Error("OpenClaw memory manager adapter should be returned");
    }
    assert(typeof manager?.search === "function", "OpenClaw memory manager adapter should expose search");
    assert(typeof manager?.readFile === "function", "OpenClaw memory manager adapter should expose readFile");
    assert(typeof manager?.status === "function", "OpenClaw memory manager adapter should expose status");
    assert(typeof manager?.sync === "function", "OpenClaw memory manager adapter should expose sync");
    assert(typeof manager?.probeEmbeddingAvailability === "function", "OpenClaw memory manager adapter should expose embedding probe");
    assert(typeof manager?.probeVectorAvailability === "function", "OpenClaw memory manager adapter should expose vector probe");
    const managerStatus = (manager.status as () => Record<string, unknown>)();
    const managerCustom = managerStatus.custom as Record<string, unknown> | undefined;
    assert(managerStatus.backend === "oms", "OpenClaw memory manager status should report OMS as the active backend");
    assert(managerCustom?.markdownHotPath === false, "OpenClaw memory manager status should reject Markdown hot paths");
    const managerHits = await (manager.search as (
      query: string,
      options?: { maxResults?: number },
    ) => Promise<Array<Record<string, unknown>>>)("TRACE_PORT=19090", { maxResults: 3 });
    assert(managerHits.length >= 1, "OpenClaw memory manager search should adapt OMS search results");
    assert(String(managerHits[0].path ?? "").startsWith("oms/query/"), "OpenClaw memory manager search should emit OMS virtual paths");
    const managerRead = await (manager.readFile as (params: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      relPath: managerHits[0].path,
      from: 1,
      lines: 5,
    });
    assert(String(managerRead.text ?? "").includes("TRACE_PORT"), "OpenClaw memory manager readFile should resolve OMS virtual paths");

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

    assert(!tools.has("oms_benchmark_report"), "benchmark report tool must not be registered");
  } finally {
    await rm(dir, { recursive: true, force: true });

  }



  console.log("test-oms-runtime-tools passed");

}



void main();
