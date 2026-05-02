import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const APPDATA = process.env.APPDATA ?? "C:/Users/ye302/AppData/Roaming";
const OPENCLAW_GLOBAL = path.join(APPDATA, "npm", "node_modules", "openclaw");
const SDK_MODULE = path.join(OPENCLAW_GLOBAL, "node_modules", "@agentclientprotocol", "sdk", "dist", "acp.js");
const OPENCLAW_ENTRY = path.join(OPENCLAW_GLOBAL, "dist", "index.js");

const { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } = await import(`file:///${SDK_MODULE.replace(/\\/g, "/")}`);

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg === name || arg.startsWith(prefix));
  if (!hit) return fallback;
  if (hit === name) {
    const index = process.argv.indexOf(name);
    return process.argv[index + 1] ?? fallback;
  }
  return hit.slice(prefix.length);
}

const options = {
  caseFile: argValue("--case-file", ""),
  outDir: argValue("--out-dir", path.join("artifacts", "evals", `openclaw-acp-harness-${new Date().toISOString().slice(0, 10)}`)),
  cwd: argValue("--cwd", process.cwd()),
  sessionKey: argValue("--session-key", `agent:main:harness-${Date.now()}-${randomUUID().slice(0, 8)}`),
  agentId: argValue("--agent-id", "main"),
};

if (!options.caseFile) {
  console.error("Missing --case-file");
  process.exit(1);
}

function parseTurns(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const turns = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^##\s+Turn\s+(\d+)\s*$/i);
    if (match) {
      if (current) {
        current.content = current.content.trim();
        if (current.content) turns.push(current);
      }
      current = { turn: Number(match[1]), content: "" };
      continue;
    }
    if (!current) continue;
    current.content += `${line}\n`;
  }
  if (current) {
    current.content = current.content.trim();
    if (current.content) turns.push(current);
  }
  return turns;
}

function loadGatewayToken() {
  const configPath = path.join(process.env.USERPROFILE, ".openclaw", "openclaw.json");
  return fs.readFile(configPath, "utf8").then((raw) => JSON.parse(raw).gateway.auth.token);
}

function firstPermissionOption(options) {
  const allow = options.find((option) => option.kind === "allow_once" || option.kind === "allow_always");
  return allow ?? options[0];
}

const transcript = [];
const toolEvents = [];
const transportNoise = [];

function handleSessionUpdate(params) {
  const update = params.update;
  transcript.push(update);
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    toolEvents.push(update);
  }
}

function getOpenClawHomeDir() {
  return process.env.OPENCLAW_HOME?.trim()
    || path.join(process.env.USERPROFILE ?? "", ".openclaw");
}

function createNdJsonFilter(noiseSink) {
  let buffer = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          if (line.startsWith("{")) {
            this.push(`${line}\n`);
          } else {
            noiseSink.push(line);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
      callback();
    },
    flush(callback) {
      const line = buffer.trim();
      if (line) {
        if (line.startsWith("{")) {
          this.push(`${line}\n`);
        } else {
          noiseSink.push(line);
        }
      }
      callback();
    },
  });
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function resolveRealSessionId(agentId, sessionKey) {
  const registryPath = path.join(
    getOpenClawHomeDir(),
    "agents",
    agentId,
    "sessions",
    "sessions.json",
  );
  const registry = await readJsonIfExists(registryPath);
  const entry = registry && typeof registry === "object" ? registry[sessionKey] : null;
  if (entry && typeof entry === "object" && typeof entry.sessionId === "string" && entry.sessionId.trim()) {
    return entry.sessionId.trim();
  }
  return null;
}

function extractTextFromContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter((value) => value.trim().length > 0)
    .join("\n")
    .trim();
}

async function readRealSessionMessages(agentId, sessionId) {
  const sessionPath = path.join(
    getOpenClawHomeDir(),
    "agents",
    agentId,
    "sessions",
    `${sessionId}.jsonl`,
  );
  try {
    const raw = await fs.readFile(sessionPath, "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record?.type === "message" && record?.message?.role)
      .map((record) => ({
        id: typeof record.id === "string" ? record.id : undefined,
        timestamp: record.timestamp,
        role: record.message.role,
        text: extractTextFromContent(record.message.content),
      }))
      .filter((message) =>
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult"
      );
  } catch {
    return [];
  }
}

function summarizePersistedTurn(messages, baselineCount) {
  const appended = messages.slice(baselineCount);
  const firstNewUserIndex = appended.findIndex((message) => message.role === "user");
  if (firstNewUserIndex < 0) {
    return null;
  }
  const turnMessages = appended.slice(firstNewUserIndex);
  const assistantMessages = turnMessages.filter((message) => message.role === "assistant");
  const nonEmptyAssistantMessages = assistantMessages.filter((message) => message.text.trim().length > 0);
  const latestAssistantReply = nonEmptyAssistantMessages.at(-1)?.text ?? "";
  const latestMessage = turnMessages.at(-1) ?? null;
  return {
    turnMessages,
    latestAssistantReply,
    latestMessageRole: latestMessage?.role ?? null,
  };
}

async function waitForTurnPersistence({
  agentId,
  sessionKey,
  baselineCount,
  timeoutMs = 180000,
  idleMs = 3000,
}) {
  const startedAt = Date.now();
  let resolvedSessionId = null;
  let lastStateKey = null;
  let lastStateChangeAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!resolvedSessionId) {
      resolvedSessionId = await resolveRealSessionId(agentId, sessionKey);
    }
    if (resolvedSessionId) {
      const messages = await readRealSessionMessages(agentId, resolvedSessionId);
      const turnState = summarizePersistedTurn(messages, baselineCount);
      if (turnState) {
        const stateKey = JSON.stringify({
          messageCount: messages.length,
          latestMessageRole: turnState.latestMessageRole,
          latestAssistantReply: turnState.latestAssistantReply,
        });
        if (stateKey !== lastStateKey) {
          lastStateKey = stateKey;
          lastStateChangeAt = Date.now();
        }
        if (
          turnState.latestAssistantReply &&
          Date.now() - lastStateChangeAt >= idleMs
        ) {
          return {
            sessionId: resolvedSessionId,
            messageCount: messages.length,
            assistantReply: turnState.latestAssistantReply,
          };
        }
      }
    }
    await delay(1000);
  }

  throw new Error(`Timed out waiting for a stable persisted assistant reply for session key ${sessionKey}`);
}

async function runHarness() {
  const token = await loadGatewayToken();
  const tokenFile = path.join(os.tmpdir(), `openclaw-acp-token-${randomUUID().slice(0, 8)}.txt`);
  await fs.writeFile(tokenFile, token, "utf8");
  const turns = parseTurns(await fs.readFile(options.caseFile, "utf8"));
  const agent = spawn(process.execPath, [
    OPENCLAW_ENTRY,
    "acp",
    "--url",
    "ws://127.0.0.1:18795",
    "--token-file",
    tokenFile,
    "--session",
    options.sessionKey,
  ], {
    stdio: ["pipe", "pipe", "inherit"],
    cwd: options.cwd,
    windowsHide: true,
  });

  if (!agent.stdin || !agent.stdout) {
    throw new Error("Failed to start ACP bridge stdio");
  }
  const filteredStdout = createNdJsonFilter(transportNoise);
  agent.stdout.pipe(filteredStdout);

  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params) => {
        handleSessionUpdate(params);
      },
      requestPermission: async (params) => {
        const option = firstPermissionOption(params.options ?? []);
        if (!option) {
          return { outcome: { outcome: "cancelled" } };
        }
        return {
          outcome: {
            outcome: "selected",
            optionId: option.optionId,
          },
        };
      },
    }),
    ndJsonStream(Writable.toWeb(agent.stdin), Readable.toWeb(filteredStdout)),
  );

  await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
    },
    clientInfo: {
      name: "chaunyoms-openclaw-acp-harness",
      version: "0.1.0",
    },
  });

  const { sessionId } = await client.newSession({
    cwd: options.cwd,
    mcpServers: [],
  });

  const results = [];
  let persistedMessageCount = 0;
  let realSessionId = null;
  for (const turn of turns) {
    const startedAt = Date.now();
    const response = await client.prompt({
      sessionId,
      prompt: [
        {
          type: "text",
          text: turn.content,
        },
      ],
    });
    const persisted = await waitForTurnPersistence({
      agentId: options.agentId,
      sessionKey: options.sessionKey,
      baselineCount: persistedMessageCount,
    });
    persistedMessageCount = persisted.messageCount;
    realSessionId = persisted.sessionId;
    results.push({
      turn: turn.turn,
      user: turn.content,
      stopReason: response.stopReason,
      durationMs: Date.now() - startedAt,
      assistantReply: persisted.assistantReply,
    });
  }

  try {
    agent.kill();
  } catch {}
  try {
    await fs.rm(tokenFile, { force: true });
  } catch {}

  await fs.mkdir(options.outDir, { recursive: true });
  const outPath = path.join(options.outDir, `${path.basename(options.caseFile, path.extname(options.caseFile))}.json`);
  await fs.writeFile(
    outPath,
    JSON.stringify(
      {
        sessionKey: options.sessionKey,
        acpSessionId: sessionId,
        realSessionId,
        agentId: options.agentId,
        caseFile: options.caseFile,
        results,
        transcript,
        toolEvents,
        transportNoise,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(JSON.stringify({ outPath, sessionKey: options.sessionKey, turns: results.length, toolEvents: toolEvents.length }, null, 2));
}

runHarness().catch((error) => {
  console.error(error);
  process.exit(1);
});
