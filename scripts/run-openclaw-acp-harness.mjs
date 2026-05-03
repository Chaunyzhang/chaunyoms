import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform, Writable } from "node:stream";
import { randomUUID } from "node:crypto";

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

function createNdJsonFilter() {
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
        }
      }
      callback();
    },
  });
}

async function runHarness() {
  const turns = parseTurns(await fs.readFile(options.caseFile, "utf8"));
  if (turns.length !== 1) {
    throw new Error(
      `Thin OpenClaw ACP sender requires exactly one Turn per run; found ${turns.length}. ` +
      "Run one sender process per user message and reuse --session-key for a normal multi-turn conversation.",
    );
  }
  const token = await loadGatewayToken();
  const tokenFile = path.join(process.cwd(), `.openclaw-acp-token-${randomUUID().slice(0, 8)}.txt`);
  await fs.writeFile(tokenFile, token, "utf8");
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
    env: {
      ...process.env,
      OPENCLAW_HIDE_BANNER: "1",
      OPENCLAW_SUPPRESS_NOTES: "1",
    },
    windowsHide: true,
  });

  if (!agent.stdin || !agent.stdout) {
    throw new Error("Failed to start ACP bridge stdio");
  }
  const filteredStdout = createNdJsonFilter();
  agent.stdout.pipe(filteredStdout);

  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
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
    results.push({
      turn: turn.turn,
      user: turn.content,
      stopReason: response.stopReason,
      durationMs: Date.now() - startedAt,
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
        caseFile: options.caseFile,
        results,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(JSON.stringify({ outPath, sessionKey: options.sessionKey, turns: results.length }, null, 2));
}

runHarness().catch((error) => {
  console.error(error);
  process.exit(1);
});
