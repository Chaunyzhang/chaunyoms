import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const openclawHome = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-openclaw-tool-config-"));
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = openclawHome;

  try {
    await writeFile(
      path.join(openclawHome, "openclaw.json"),
      JSON.stringify({
        plugins: {
          entries: {
            oms: {
              config: {
                enableTools: true,
              },
            },
          },
        },
      }),
      "utf8",
    );

    const runtimeEnabledAdapter = new OpenClawPayloadAdapter(
      () => ({ config: { enableTools: true } }),
      () => ({ info(): void {}, warn(): void {}, error(): void {} }),
    );
    const runtimeEnabled = runtimeEnabledAdapter.resolveToolConfig();
    assert(runtimeEnabled.enabled === true, "expected runtime enableTools=true to win");
    assert(runtimeEnabled.source === "runtime", "expected runtime source label");

    const fileEnabledAdapter = new OpenClawPayloadAdapter(
      () => ({ config: {} }),
      () => ({ info(): void {}, warn(): void {}, error(): void {} }),
    );
    const fileEnabled = fileEnabledAdapter.resolveToolConfig();
    assert(fileEnabled.enabled === true, "expected openclaw.json enableTools=true to enable tools");
    assert(fileEnabled.source === "openclaw_json", "expected file source label");

    const disabledAdapter = new OpenClawPayloadAdapter(
      () => ({ config: { enableTools: false } }),
      () => ({ info(): void {}, warn(): void {}, error(): void {} }),
    );
    const disabled = disabledAdapter.resolveToolConfig();
    assert(disabled.enabled === true, "expected file-backed enableTools to remain available when runtime only says false");
    assert(disabled.source === "openclaw_json", "expected openclaw_json fallback when runtime does not explicitly enable");
  } finally {
    if (previousOpenClawHome) {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    } else {
      delete process.env.OPENCLAW_HOME;
    }
    await rm(openclawHome, { recursive: true, force: true });
  }

  console.log("test-openclaw-tool-config-resolution passed");
}

void main();
