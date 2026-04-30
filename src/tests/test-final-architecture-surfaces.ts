import { access, mkdtemp, rm } from "node:fs/promises";

import os from "node:os";

import path from "node:path";



import { OpenClawBridge } from "../OpenClawBridge";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";



function assert(condition: unknown, message: string): asserts condition {

  if (!condition) {

    throw new Error(message);

  }

}



async function pathExists(filePath: string): Promise<boolean> {

  try {

    await access(filePath);

    return true;

  } catch {

    return false;

  }

}



async function main(): Promise<void> {

  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-final-surfaces-"));

  try {

    const config = {

      ...DEFAULT_BRIDGE_CONFIG,

      dataDir: path.join(dir, "data"),

      workspaceDir: path.join(dir, "workspace"),

      sharedDataDir: path.join(dir, "shared"),

      memoryVaultDir: path.join(dir, "vault"),

      knowledgeBaseDir: path.join(dir, "shared", "knowledge-base"),

      sessionId: "final-session",

      agentId: "final-agent",

      enableTools: true,

      retrievalStrength: "high" as const,

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



    for (const tool of ["oms_agent_export", "oms_agent_verify", "oms_agent_import"]) {

      assert(tools.has(tool), `${tool} should be registered`);

    }



    await bridge.ingest({

      sessionId: config.sessionId,

      config,

      id: "source-1",

      role: "user",

      content: "Remember that final architecture tests require complete source capsules.",

      turnNumber: 1,

    });

    const toolIngest = await bridge.ingest({

      sessionId: config.sessionId,

      config,

      id: "tool-output-1",

      role: "tool",

      content: "stdout: external tool result must be a RuntimeEvent, not Source",

      turnNumber: 2,

    });

    assert(toolIngest.ingested === false, "tool output should not be ingested as Source/raw message");



    const status = await tools.get("oms_status")?.execute("status", { sessionId: config.sessionId, config }) as { details?: Record<string, unknown> } | undefined;

    const counts = status?.details?.counts as Record<string, unknown> | undefined;

    const statusConfig = status?.details?.config as Record<string, unknown> | undefined;

    assert(counts?.rawMessages === 1, "only the natural user message should be a raw Source message");

    assert(counts?.observations === 1, "tool output should be retained as an observation/runtime event");

    assert(statusConfig?.retrievalStrength === "high", "status should expose retrievalStrength as the single retrieval knob");



    await bridge.assemble({ sessionId: config.sessionId, config });

    const runtimeStatus = status?.details?.runtimeStore as Record<string, unknown> | undefined;

    assert(runtimeStatus, "status should include runtime store details");



    const exportResult = await tools.get("oms_agent_export")?.execute("export", {

      sessionId: config.sessionId,

      config,

      label: "unit",

    }) as { details?: Record<string, unknown> } | undefined;

    assert(exportResult?.details?.ok === true, "agent capsule export should succeed");

    const capsuleDir = String(exportResult.details.capsuleDir ?? "");

    assert(

      path.normalize(capsuleDir).includes(path.join("agent_capsules", config.agentId)),

      "capsule should be written under dataDir/agent_capsules/<agent>",

    );

    for (const fileName of ["manifest.json", "capsule.sqlite", "capsule.sql", "checksums.txt", "README.restore.txt"]) {

      assert(await pathExists(path.join(capsuleDir, fileName)), `capsule should include ${fileName}`);

    }



    const verifyResult = await tools.get("oms_agent_verify")?.execute("verify", {

      sessionId: config.sessionId,

      config,

      capsulePath: capsuleDir,

    }) as { details?: Record<string, unknown> } | undefined;

    assert(verifyResult?.details?.ok === true, "agent capsule verify should pass");



    const outsideRootVerify = await tools.get("oms_agent_verify")?.execute("verify-outside", {

      sessionId: config.sessionId,

      config,

      capsulePath: path.join(config.dataDir, "agent_capsules-evil", "capsule"),

    }) as { details?: Record<string, unknown> } | undefined;

    assert(outsideRootVerify?.details?.ok === false, "agent capsule verify should reject sibling paths outside agent_capsules");



    const importDryRun = await tools.get("oms_agent_import")?.execute("import", {

      sessionId: config.sessionId,

      config,

      capsulePath: capsuleDir,

      apply: false,

    }) as { details?: Record<string, unknown> } | undefined;

    assert(importDryRun?.details?.ok === true, "agent capsule import dry-run should validate");

    assert(importDryRun?.details?.apply === false, "agent capsule import should default to dry-run semantics in this test");

  } finally {

    await rm(dir, { recursive: true, force: true });

  }



  console.log("test-final-architecture-surfaces passed");

}



void main();
