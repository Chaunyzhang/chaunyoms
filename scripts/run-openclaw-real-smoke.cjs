const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const args = process.argv.slice(2);
  const hit = args.find((arg) => arg === name || arg.startsWith(prefix));
  if (!hit) return fallback;
  if (hit === name) {
    const index = args.indexOf(hit);
    return args[index + 1] ?? fallback;
  }
  return hit.slice(prefix.length);
}

function runNode(args, timeoutMs, cwd) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${args[0]} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const caseFile = path.resolve(
    repoRoot,
    argValue("--case-file", path.join("src", "tests", "fixtures", "openclaw-real-filter-smoke-case.md")),
  );
  const outDir = path.resolve(
    repoRoot,
    argValue("--out-dir", path.join("artifacts", "evals", `real-openclaw-smoke-${Date.now()}`)),
  );
  await fsp.mkdir(outDir, { recursive: true });

  runNode([
    path.join("scripts", "run-openclaw-acp-harness.mjs"),
    "--case-file",
    path.relative(repoRoot, caseFile),
    "--out-dir",
    path.relative(repoRoot, outDir),
  ], 600000, repoRoot);

  const harnessPath = path.join(
    outDir,
    `${path.basename(caseFile, path.extname(caseFile))}.json`,
  );
  const harnessReport = JSON.parse(await fsp.readFile(harnessPath, "utf8"));
  const sessionSelector = harnessReport.sessionKey;

  const runtimeReportResult = runNode([
    "--experimental-sqlite",
    path.join("scripts", "openclaw-runtime-report.cjs"),
    `--session=${sessionSelector}`,
  ], 20000, repoRoot);
  const smokeReportResult = runNode([
    "--experimental-sqlite",
    path.join("scripts", "openclaw-session-smoke.cjs"),
    `--session=${sessionSelector}`,
  ], 20000, repoRoot);

  const runtimeReport = JSON.parse(String(runtimeReportResult.stdout || "{}"));
  const smokeReport = JSON.parse(String(smokeReportResult.stdout || "{}"));
  const lastTurnResult = Array.isArray(harnessReport.results) && harnessReport.results.length > 0
    ? harnessReport.results[harnessReport.results.length - 1]
    : null;
  const finalAssistantReply =
    typeof lastTurnResult?.assistantReply === "string"
      ? lastTurnResult.assistantReply.trim()
      : "";
  const previousNonEmptyAssistantReply = [...(harnessReport.results || [])]
    .reverse()
    .map((item) => item.assistantReply)
    .find((value) => typeof value === "string" && value.trim().length > 0) ?? "";

  const report = {
    createdAt: new Date().toISOString(),
    caseFile: path.relative(repoRoot, caseFile),
    outDir: path.relative(repoRoot, outDir),
    sessionKey: harnessReport.sessionKey,
    realSessionId: harnessReport.realSessionId,
    finalAssistantReply,
    lastTurnAssistantReply: finalAssistantReply,
    previousNonEmptyAssistantReply,
    harnessReport,
    runtimeReport,
    smokeReport,
  };

  const reportPath = path.join(outDir, "report.json");
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  if (!finalAssistantReply) {
    throw new Error(`Final turn assistant reply was empty for case ${path.relative(repoRoot, caseFile)}. Previous non-empty reply: ${previousNonEmptyAssistantReply || "(none)"}`);
  }
  process.stdout.write(`${JSON.stringify({ reportPath, realSessionId: harnessReport.realSessionId }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
