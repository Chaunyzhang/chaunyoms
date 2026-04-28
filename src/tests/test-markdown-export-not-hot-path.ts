import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OpenClawBridge } from "../OpenClawBridge";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { WorkspaceBootstrapTokenEstimator } from "../host/WorkspaceBootstrapTokenEstimator";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-markdown-not-hot-"));
  try {
    const knowledgeDir = path.join(dir, "knowledge");
    await mkdir(path.join(knowledgeDir, "raw"), { recursive: true });
    await writeFile(
      path.join(knowledgeDir, "raw", "manual.md"),
      "# Manual raw note\n\nMARKDOWN_ONLY_SECRET=do-not-recall-from-hot-path\n",
      "utf8",
    );

    const config = {
      ...DEFAULT_BRIDGE_CONFIG,
      dataDir: path.join(dir, "data"),
      workspaceDir: path.join(dir, "workspace"),
      sharedDataDir: path.join(dir, "shared"),
      memoryVaultDir: path.join(dir, "vault"),
      knowledgeBaseDir: knowledgeDir,
      sessionId: "markdown-session",
      agentId: "markdown-agent",
      enableTools: true,
      semanticCandidateExpansionEnabled: true,
      knowledgeMarkdownEnabled: false,
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

    const recall = await tools.get("memory_search")?.execute("markdown-search", {
      sessionId: config.sessionId,
      config,
      query: "MARKDOWN_ONLY_SECRET",
      retrievalStrength: "strict",
    }) as { content?: Array<Record<string, unknown>>; details?: Record<string, unknown> } | undefined;
    const text = String(recall?.content?.[0]?.text ?? "");
    assert(!text.includes("do-not-recall-from-hot-path"), "memory_search must not return Markdown raw file contents");
    const compatibility = recall?.details?.toolCompatibility as Record<string, unknown> | undefined;
    assert(compatibility?.markdownHotPath === false, "compatibility metadata should state Markdown is not a hot path");

    const assetSync = await tools.get("oms_asset_sync")?.execute("asset-sync", {
      sessionId: config.sessionId,
      config,
    }) as { details?: Record<string, unknown> } | undefined;
    const markdownSync = assetSync?.details?.markdown as Record<string, unknown> | undefined;
    assert(markdownSync?.afterCount === 0, "disabled Markdown export/indexing should not ingest raw Markdown assets");

    const workspaceDir = config.workspaceDir;
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# Old MEMORY\n\nLEGACY_MEMORY_SECRET should not be counted because this is not the OMS stub.\n",
      "utf8",
    );
    const estimator = new WorkspaceBootstrapTokenEstimator();
    assert(await estimator.estimateWorkspaceBootstrapTokens(workspaceDir) === 0, "non-stub MEMORY.md should not be counted into OMS bootstrap budget");
    await writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# MEMORY.md\n\nThis agent's memory is managed by oms. Do not write long-term memory here.\n",
      "utf8",
    );
    assert(await estimator.estimateWorkspaceBootstrapTokens(workspaceDir) > 0, "OMS MEMORY.md stub can remain as a tiny host compatibility pointer");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log("test-markdown-export-not-hot-path passed");
}

void main();
