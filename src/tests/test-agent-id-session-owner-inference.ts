import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_BRIDGE_CONFIG } from "../host/OpenClawHostServices";
import { OpenClawPayloadAdapter } from "../host/OpenClawPayloadAdapter";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const openClawHome = path.join(
    tmpdir(),
    `chaunyoms-agent-owner-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const sessionId = "session-owned-by-memory-agent";
  const agentId = "memory-ctx-only";
  const workspaceDir = path.join(openClawHome, "workspace-memory-ctx-only");

  try {
    const sessionDir = path.join(openClawHome, "agents", agentId, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(path.join(openClawHome, "agents", "main", "sessions"), {
      recursive: true,
    });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      path.join(openClawHome, "agents", agentId, "sessions", `${sessionId}.jsonl`),
      "{\"type\":\"session\"}\n",
      "utf8",
    );
    writeFileSync(
      path.join(openClawHome, "agents", agentId, "sessions", "sessions.json"),
      JSON.stringify({
        [`agent:${agentId}:main`]: {
          sessionId: "logical-session-from-registry",
        },
      }),
      "utf8",
    );
    writeFileSync(
      path.join(openClawHome, "openclaw.json"),
      JSON.stringify({
        agents: {
          list: [
            {
              id: agentId,
              workspace: workspaceDir,
            },
          ],
        },
      }),
      "utf8",
    );

    process.env.OPENCLAW_HOME = openClawHome;

    const adapter = new OpenClawPayloadAdapter(
      () => ({
        session: {
          id: sessionId,
        },
      }),
      () => ({
        info(): void {},
        warn(): void {},
        error(): void {},
      }),
    );

    const context = adapter.resolveLifecycleContext({}, DEFAULT_BRIDGE_CONFIG);
    assert(context.sessionId === sessionId, "expected session id to come from host api");
    assert(
      context.config.agentId === agentId,
      "expected missing tool agentId to be inferred from the OpenClaw session owner",
    );

    const workspaceContext = adapter.resolveLifecycleContext(
      {
        sessionId: "logical-session-without-file",
        workspaceDir,
      },
      DEFAULT_BRIDGE_CONFIG,
    );
    assert(
      workspaceContext.config.agentId === agentId,
      "expected missing tool agentId to be inferred from the OpenClaw workspace owner",
    );

    const defaultMainFromHost = new OpenClawPayloadAdapter(
      () => ({
        agent: {
          id: "main",
        },
      }),
      () => ({
        info(): void {},
        warn(): void {},
        error(): void {},
      }),
    ).resolveLifecycleContext(
      {
        sessionId: "logical-session-with-default-main-host-agent",
        workspaceDir,
      },
      DEFAULT_BRIDGE_CONFIG,
    );
    assert(
      defaultMainFromHost.config.agentId === agentId,
      "expected workspace owner to override the host default main agent id",
    );

    const registryContext = new OpenClawPayloadAdapter(
      () => ({
        agent: {
          id: "main",
        },
        session: {
          id: "logical-session-from-registry",
        },
      }),
      () => ({
        info(): void {},
        warn(): void {},
        error(): void {},
      }),
    ).resolveLifecycleContext({}, DEFAULT_BRIDGE_CONFIG);
    assert(
      registryContext.config.agentId === agentId,
      "expected OpenClaw sessions registry to override the host default main agent id",
    );
  } finally {
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    rmSync(openClawHome, { recursive: true, force: true });
  }

  console.log("test-agent-id-session-owner-inference passed");
}

void main();
