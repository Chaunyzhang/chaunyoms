import { mkdtemp, rm } from "node:fs/promises";

import os from "node:os";

import path from "node:path";



import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";

import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";

import { StablePrefixAdapter } from "../data/StablePrefixAdapter";

import { ChaunyomsRetrievalService } from "../runtime/ChaunyomsRetrievalService";

import { ChaunyomsSessionRuntime } from "../runtime/ChaunyomsSessionRuntime";

import { createRuntimeLayerDependencies } from "../runtime/createRuntimeLayerDependencies";



function assert(condition: unknown, message: string): void {

  if (!condition) {

    throw new Error(message);

  }

}



async function main(): Promise<void> {

  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-verifier-runtime-"));

  try {

    const config = {

      ...DEFAULT_BRIDGE_CONFIG,

      dataDir: path.join(dir, "data"),

      workspaceDir: path.join(dir, "workspace"),

      sharedDataDir: path.join(dir, "shared"),

      memoryVaultDir: path.join(dir, "vault"),

      knowledgeBaseDir: path.join(dir, "knowledge"),

      sessionId: "verifier-runtime-session",

      agentId: "agent-verifier-runtime",

      retrievalStrength: "high" as const,

      autoRecallEnabled: true,

      llmPlannerMode: "auto" as const,

    };

    const runtime = new ChaunyomsSessionRuntime(

      { info(): void {}, warn(): void {}, error(): void {} },

      null,

      config,

      createRuntimeLayerDependencies(),

    );

    await runtime.bootstrap({

      sessionId: config.sessionId,

      config,

      totalBudget: config.contextWindow,

      systemPromptTokens: 0,

      runtimeMessages: [],

    });



    const retrieval = new ChaunyomsRetrievalService(

      runtime,

      new OpenClawPayloadAdapter(

        () => ({ config: {} }),

        () => ({ info(): void {}, warn(): void {}, error(): void {} }),

      ),

      { fixedPrefixProvider: new StablePrefixAdapter() },

    );



    const result = await retrieval.executeMemoryRetrieve({

      sessionId: config.sessionId,

      config,

      query: "find the exact MISSING_RUNTIME_TOKEN from earlier",

      retrievalStrength: "high",

    });

    const text = String(result.content[0]?.text ?? "");

    assert(result.details.retrievalHitType === "insufficient_source_evidence", "strict runtime path should block unsupported retrieval");

    assert(result.details.evidencePresentation === "no_answer", "strict runtime path should produce no-answer presentation when source is missing");

    assert(/Retrieval verifier blocked final answer/i.test(text), "blocked response should name RetrievalVerifier enforcement");

    assert(!/Historical source hits/i.test(text), "blocked strict response must not present normal historical hits");

    const verification = result.details.retrievalVerification as Record<string, unknown> | undefined;

    assert(verification?.status === "insufficient", "runtime response should expose insufficient verifier status");

    assert(verification?.recommendedAction === "no_answer", "runtime response should expose no-answer verifier action");



    const runtimeStore = await runtime.getRuntimeStore({ sessionId: config.sessionId, config });

    const inspection = runtimeStore.inspectContextRun();

    const metadata = inspection.run?.metadata as Record<string, unknown> | undefined;

    const steps = metadata?.progressiveRetrievalSteps as unknown[] | undefined;

    assert(Array.isArray(steps) && steps.length > 0, "strict verifier-blocked runtime path should persist planner progressive steps");

    assert(

      inspection.selected.some((candidate) => candidate.source === "llm_planner" && candidate.targetKind === "planner_step") ||

        inspection.rejected.some((candidate) => candidate.source === "llm_planner" && candidate.targetKind === "planner_step"),

      "planner progressive steps should be visible through context-run candidate audit rows",

    );

  } finally {

    await rm(dir, { recursive: true, force: true });

  }



  console.log("test-retrieval-verifier-runtime-enforcement passed");

}



void main();
