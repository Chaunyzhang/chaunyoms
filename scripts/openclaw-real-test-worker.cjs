const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function parseArgs(argv) {
  const args = { statusFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--status-file") {
      args.statusFile = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--status-file=")) {
      args.statusFile = arg.slice("--status-file=".length);
    }
  }
  return args;
}

function now() {
  return new Date().toISOString();
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function appendLog(filePath, line) {
  await fsp.appendFile(filePath, `${now()} ${line}\n`, "utf8");
}

function quoteForPs(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resolveGatewayAuthEnv() {
  const configPath = path.join(process.env.USERPROFILE || "", ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const authMode = String(config?.gateway?.auth?.mode || "").trim().toLowerCase();
    if (authMode === "token") {
      const token = config?.gateway?.auth?.token;
      if (typeof token === "string" && token.trim()) {
        return { OPENCLAW_GATEWAY_TOKEN: token.trim() };
      }
    }
    if (authMode === "password") {
      const password = config?.gateway?.auth?.password;
      if (typeof password === "string" && password.trim()) {
        return { OPENCLAW_GATEWAY_PASSWORD: password.trim() };
      }
    }
  } catch {
    // ignore, fall back to inherited env
  }
  return {};
}

function runOpenClaw(command, timeoutMs, logPath) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      command,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: {
        ...process.env,
        ...resolveGatewayAuthEnv(),
      },
    },
  );
  const combined = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (combined) {
    fs.appendFileSync(logPath, `${now()} CMD ${command}\n${combined}\n`, "utf8");
  } else {
    fs.appendFileSync(logPath, `${now()} CMD ${command}\n`, "utf8");
  }
  return result;
}

function runNode(scriptPath, args, timeoutMs, logPath) {
  const result = spawnSync(
    process.execPath,
    args,
    {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: {
        ...process.env,
        ...resolveGatewayAuthEnv(),
      },
    },
  );
  const combined = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const display = `${quoteForPs(process.execPath)} ${[scriptPath, ...args].join(" ")}`;
  if (combined) {
    fs.appendFileSync(logPath, `${now()} CMD ${display}\n${combined}\n`, "utf8");
  } else {
    fs.appendFileSync(logPath, `${now()} CMD ${display}\n`, "utf8");
  }
  return result;
}

class CancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = "CancelledError";
  }
}

async function updateStatus(statusFile, mutate) {
  const record = await readJson(statusFile);
  const next = mutate(record);
  next.updatedAt = now();
  await writeJson(statusFile, next);
  return next;
}

async function assertNotCancelled(statusFile) {
  const record = await readJson(statusFile);
  if (record.cancelRequested) {
    throw new CancelledError(record.cancellationReason || "cancel_requested");
  }
}

function extractJsonTail(rawText) {
  const text = String(rawText || "").trim();
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") {
      starts.push(index);
    }
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const candidate = text.slice(starts[index]);
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  throw new Error(`Could not parse JSON output tail: ${text.slice(-800)}`);
}

function extractAssistantReply(raw) {
  const text = String(raw || "").trim();
  const jsonStart = text.lastIndexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      if (typeof parsed.reply === "string") return parsed.reply;
      if (typeof parsed.output === "string") return parsed.output;
      if (typeof parsed.text === "string") return parsed.text;
    } catch {
      // ignore
    }
  }
  return text;
}

async function runStableSuite(record, statusFile, logPath, reportPath) {
  const pluginRoot = path.resolve(__dirname, "..");
  const evalScript = path.join(pluginRoot, "dist", "src", "evals", "run-eval-suite.js");
  const benchmarkScript = path.join(pluginRoot, "dist", "src", "benchmarks", "benchmark-runtime.js");
  const reportDir = record.runDir;
  const evalPrefix = "stable-smoke";

  await updateStatus(statusFile, (current) => ({
    ...current,
    status: "running",
    phase: "running_eval_suite",
    startedAt: current.startedAt || now(),
    currentStep: 1,
    totalSteps: 3,
    progress: 0.2,
    agentId: "stable-harness",
    sessionId: "stable-harness",
  }));
  await assertNotCancelled(statusFile);

  let result = runNode(
    evalScript,
    [
      evalScript,
      "--report-prefix",
      evalPrefix,
      "--report-dir",
      reportDir,
    ],
    240000,
    logPath,
  );
  if (result.status !== 0) {
    throw new Error(`stable eval suite failed: ${String(result.stderr || result.stdout || "").trim()}`);
  }
  const evalReport = extractJsonTail(result.stdout || "");

  await updateStatus(statusFile, (current) => ({
    ...current,
    phase: "running_benchmark",
    currentStep: 2,
    progress: 0.7,
  }));
  await assertNotCancelled(statusFile);

  result = runNode(
    benchmarkScript,
    [benchmarkScript],
    240000,
    logPath,
  );
  if (result.status !== 0) {
    throw new Error(`stable benchmark failed: ${String(result.stderr || result.stdout || "").trim()}`);
  }
  const benchmark = extractJsonTail(result.stdout || "");

  const finalReport = {
    ok: evalReport?.metrics?.passRate?.rate === 1,
    suite: record.suite,
    mode: "stable_harness",
    completedAt: now(),
    metrics: evalReport.metrics,
    evalReport,
    benchmark,
    reportFiles: {
      evalJson: path.join(reportDir, `${evalPrefix}.json`),
      evalMarkdown: path.join(reportDir, `${evalPrefix}.md`),
    },
  };
  await writeJson(reportPath, finalReport);

  await updateStatus(statusFile, (current) => ({
    ...current,
    status: finalReport.ok ? "completed" : "failed",
    phase: "completed",
    currentStep: 3,
    completedAt: finalReport.completedAt,
    progress: 1,
  }));
}

function realSmokeScenario() {
  return [
    "我们现在在做 OpenClaw 的 ChaunyOMS 插件，先记住几个关键配置：API_BASE=https://qa.example.internal/v2，GATEWAY_PORT=4319，TOKEN_ALIAS=red-fox，SUMMARY_MODEL=minimax/MiniMax-M2.7。",
    "当前问题不是压缩阈值，而是之前出现过上下文回灌：插件自己注入的 durable memory 又被写回 raw。",
    "这轮目标是确认三个点：1. 不再发生 replay pollution 2. contextWindow 跟随真实模型自动识别 3. 真机会话里的 recent_tail 不被伪上下文污染。",
    "当前项目状态：active 是修 ChaunyOMS 真机稳定性，blocker 是 openclaw agent CLI 返回不稳定，next 是在真实界面做长对话测试。",
    "再记一个精确事实：今天测试批次编号是 BATCH-20260426-A7。前端 mock 端口是 8732，但它和 GATEWAY_PORT=4319 不是一回事。",
    "顺便帮我想一下日志面板如果做得更轻一点，信息密度应该怎么平衡。",
    "另外我还在犹豫 deploy 脚本以后是不是改名成 bootstrap-runtime.ps1，这个先不要记成已决定。",
    "现在准确复述我最开始给你的关键配置值，并告诉我 blocker、next step、测试批次编号、gateway 端口和 mock 端口分别是什么。",
  ];
}

async function copyIfPresent(source, target) {
  try {
    await fsp.copyFile(source, target);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function syncAgentAuthState(agentId, logPath) {
  const root = path.join(process.env.USERPROFILE || "", ".openclaw", "agents");
  const mainAgentDir = path.join(root, "main", "agent");
  const testAgentDir = path.join(root, agentId, "agent");
  await fsp.mkdir(testAgentDir, { recursive: true });
  const copied = [];
  for (const fileName of ["auth-state.json", "models.json"]) {
    const source = path.join(mainAgentDir, fileName);
    const target = path.join(testAgentDir, fileName);
    if (await copyIfPresent(source, target)) {
      copied.push(fileName);
    }
  }
  await appendLog(logPath, `synced_agent_auth_state: ${copied.join(", ") || "none"}`);
}

async function runRealSuite(record, statusFile, logPath, reportPath, runtimeReportPath, smokeReportPath) {
  const agentId = process.env.CHAUNYOMS_TEST_AGENT_ID || record.agentId;
  const sessionId = process.env.CHAUNYOMS_TEST_SESSION_ID || record.sessionId;
  const workspaceDir = process.env.CHAUNYOMS_TEST_WORKSPACE_DIR || record.workspaceDir;
  const pluginRoot = path.resolve(__dirname, "..");
  const runtimeReportScript = path.join(pluginRoot, "scripts", "openclaw-runtime-report.cjs");
  const sessionSmokeScript = path.join(pluginRoot, "scripts", "openclaw-session-smoke.cjs");
  const scenario = realSmokeScenario();

  await fsp.mkdir(workspaceDir, { recursive: true });

  await updateStatus(statusFile, (current) => ({
    ...current,
    status: "running",
    phase: "creating_agent",
    startedAt: current.startedAt || now(),
    currentStep: 0,
    totalSteps: scenario.length + 2,
    progress: 0.05,
  }));
  await assertNotCancelled(statusFile);

  let result = runOpenClaw(
    `openclaw agents add ${agentId} --workspace ${quoteForPs(workspaceDir)} --non-interactive --json`,
    120000,
    logPath,
  );
  if (result.status !== 0) {
    throw new Error(`agents add failed: ${String(result.stderr || result.stdout || "").trim()}`);
  }
  await syncAgentAuthState(agentId, logPath);

  for (let index = 0; index < scenario.length; index += 1) {
    await assertNotCancelled(statusFile);
    const message = scenario[index];
    await updateStatus(statusFile, (current) => ({
      ...current,
      phase: "running_cases",
      currentStep: index + 1,
      progress: 0.1 + ((index + 1) / scenario.length) * 0.65,
    }));
    result = runOpenClaw(
      `openclaw agent --agent ${agentId} --session-id ${sessionId} --message ${quoteForPs(message)} --thinking minimal --json --timeout 180`,
      240000,
      logPath,
    );
    await appendLog(logPath, `assistant_reply_step_${index + 1}: ${extractAssistantReply(`${result.stdout || ""}${result.stderr || ""}`).slice(0, 800)}`);
    if (result.status !== 0) {
      throw new Error(`agent turn ${index + 1} failed: ${String(result.stderr || result.stdout || "").trim()}`);
    }
  }

  await updateStatus(statusFile, (current) => ({
    ...current,
    phase: "collecting_reports",
    currentStep: scenario.length + 1,
    progress: 0.85,
  }));
  await assertNotCancelled(statusFile);

  const runtimeReport = runNode(
    runtimeReportScript,
    ["--experimental-sqlite", runtimeReportScript, `--session=${sessionId}`],
    120000,
    logPath,
  );
  if (runtimeReport.status !== 0) {
    throw new Error(`runtime report failed: ${String(runtimeReport.stderr || runtimeReport.stdout || "").trim()}`);
  }
  const runtimeJson = extractJsonTail(runtimeReport.stdout || "");
  await writeJson(runtimeReportPath, runtimeJson);

  const smokeReport = runNode(
    sessionSmokeScript,
    ["--experimental-sqlite", sessionSmokeScript, `--session=${sessionId}`],
    120000,
    logPath,
  );
  if (smokeReport.status !== 0 && !String(smokeReport.stdout || "").trim()) {
    throw new Error(`session smoke failed: ${String(smokeReport.stderr || smokeReport.stdout || "").trim()}`);
  }
  const smokeJson = extractJsonTail(smokeReport.stdout || "");
  await writeJson(smokeReportPath, smokeJson);

  const finalReport = {
    ok: smokeReport.status === 0 && smokeJson.ok === true,
    suite: record.suite,
    mode: record.mode,
    agentId,
    sessionId,
    completedAt: now(),
    runtimeReportPath,
    smokeReportPath,
    smoke: smokeJson,
    runtimeReport: runtimeJson,
  };
  await writeJson(reportPath, finalReport);

  await updateStatus(statusFile, (current) => ({
    ...current,
    status: finalReport.ok ? "completed" : "failed",
    phase: "completed",
    currentStep: scenario.length + 2,
    completedAt: finalReport.completedAt,
    progress: 1,
  }));

  runOpenClaw(
    `openclaw agents delete ${agentId} --force --json`,
    120000,
    logPath,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.statusFile) {
    throw new Error("Missing --status-file");
  }

  const record = await readJson(args.statusFile);
  const logPath = record.logPath;
  const reportPath = record.reportPath;
  const runtimeReportPath = record.runtimeReportPath;
  const smokeReportPath = record.smokeReportPath;
  const suite = String(record.suite || "").trim() || "stable_smoke_v1";

  await fsp.mkdir(record.runDir, { recursive: true });

  try {
    if (suite === "real_smoke_v1") {
      await runRealSuite(record, args.statusFile, logPath, reportPath, runtimeReportPath, smokeReportPath);
      return;
    }

    await runStableSuite(record, args.statusFile, logPath, reportPath);
  } catch (error) {
    const isCancelled = error instanceof CancelledError;
    await writeJson(reportPath, {
      ok: false,
      cancelled: isCancelled,
      suite,
      mode: record.mode,
      failedAt: now(),
      error: error instanceof Error ? error.message : String(error),
    });
    await updateStatus(args.statusFile, (current) => ({
      ...current,
      status: isCancelled ? "cancelled" : "failed",
      phase: isCancelled ? "cancelled" : "failed",
      completedAt: now(),
      progress: 1,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

void main();
