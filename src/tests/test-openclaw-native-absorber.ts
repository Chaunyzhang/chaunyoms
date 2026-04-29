import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SQLiteRuntimeStore } from "../data/SQLiteRuntimeStore";
import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { OpenClawNativeAbsorber } from "../native/OpenClawNativeAbsorber";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const logger = { info(): void {}, warn(): void {}, error(): void {} };

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-native-absorber-"));
  try {
    const store = new SQLiteRuntimeStore({
      dbPath: path.join(dir, "runtime.sqlite"),
      agentId: "agent-native",
      knowledgeBaseDir: path.join(dir, "knowledge"),
      logger,
    });
    await store.init();
    const config = {
      ...DEFAULT_BRIDGE_CONFIG,
      dataDir: path.join(dir, "data"),
      workspaceDir: dir,
      sharedDataDir: path.join(dir, "shared"),
      sessionId: "s-native",
      agentId: "agent-native",
    };

    const disabled = await new OpenClawNativeAbsorber(store, config).absorb({
      feature: "dreaming",
      content: "Native dream should not enter OMS while disabled.",
      sourceId: "dream-1",
    });
    assert(!disabled.ok && disabled.mode === "disabled", "disabled native mode should reject native output");

    const coexist = await new OpenClawNativeAbsorber(store, {
      ...config,
      openClawNativeMode: "coexist",
    }).absorb({
      feature: "dreaming",
      content: "Native dream remains advisory only.",
      sourceId: "dream-2",
    });
    assert(coexist.ok && !coexist.absorbed, "coexist mode should record advisory observation without candidate absorption");
    assert(coexist.observationId !== undefined, "coexist mode should still keep an observation audit record");

    const blocked = await new OpenClawNativeAbsorber(store, {
      ...config,
      openClawNativeMode: "absorbed",
    }).absorb({
      feature: "dreaming",
      content: "Native dream lacks source binding.",
    });
    assert(!blocked.ok && blocked.absorbed, "absorbed native mode should still block source-less candidates");
    assert(blocked.validation?.ok === false, "source-less absorbed output should fail MemoryOperation validation");

    const absorbed = await new OpenClawNativeAbsorber(store, {
      ...config,
      openClawNativeMode: "absorbed",
    }).absorb({
      feature: "dreaming",
      content: "Native dream is a candidate only.",
      sourceId: "dream-3",
      confidence: 0.8,
    });
    assert(absorbed.ok && absorbed.candidateId !== undefined, "absorbed native mode should create a validated candidate");
    assert(absorbed.becomesMemoryItem === false && absorbed.becomesKnowledgeRaw === false, "absorbed native output must not become authoritative data without promotion");
    assert(store.listRuntimeRecords("openclaw_native_candidate", { agentId: "agent-native" }).length === 1, "absorbed candidate should be auditable in runtime records");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("test-openclaw-native-absorber passed");
}

void main();
