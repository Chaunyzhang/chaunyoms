#!/usr/bin/env node
const { spawnSync } = require("node:child_process");

function checkNodeSqlite() {
  try {
    const sqlite = require("node:sqlite");
    if (!sqlite.DatabaseSync) {
      return {
        name: "node_sqlite",
        ok: false,
        required: true,
        message: "node:sqlite loaded but DatabaseSync is unavailable.",
        loadExtensionAvailable: false,
      };
    }
    const db = new sqlite.DatabaseSync(":memory:");
    try {
      return {
        name: "node_sqlite",
        ok: true,
        required: true,
        message: "node:sqlite DatabaseSync is available.",
        loadExtensionAvailable: typeof db.enableLoadExtension === "function" &&
          typeof db.loadExtension === "function",
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      name: "node_sqlite",
      ok: false,
      required: true,
      message: `node:sqlite unavailable: ${error && error.message ? error.message : String(error)}`,
      loadExtensionAvailable: false,
    };
  }
}

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const vectorExtensionPath = process.env.OMS_VECTOR_EXTENSION_PATH || "";
const nodeVersion = process.versions.node;
const nodeMajor = Number(nodeVersion.split(".")[0] || 0);
const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["-v"], {
  encoding: "utf8",
});
const npmFromUserAgent = /npm\/([^\s]+)/.exec(process.env.npm_config_user_agent || "")?.[1];
const npmVersion = npm.status === 0 ? String(npm.stdout).trim() : npmFromUserAgent;
const sqlite = checkNodeSqlite();
const checks = [
  {
    name: "node_version",
    ok: nodeMajor >= 24,
    required: true,
    message: nodeMajor >= 24
      ? `Node ${nodeVersion} supports the OMS SQLite runtime target.`
      : `Node ${nodeVersion} is below the OMS target; use Node 24+ for node:sqlite.`,
  },
  {
    name: "npm_version",
    ok: Boolean(npmVersion),
    required: false,
    message: npmVersion
      ? `npm ${npmVersion} detected.`
      : "npm was not found on PATH; installation docs should explain host setup.",
  },
  {
    name: sqlite.name,
    ok: sqlite.ok,
    required: sqlite.required,
    message: sqlite.message,
  },
  {
    name: "sqlite_load_extension_api",
    ok: sqlite.loadExtensionAvailable,
    required: false,
    message: sqlite.loadExtensionAvailable
      ? "SQLite loadExtension API is available for optional vector extensions."
      : "SQLite loadExtension API is unavailable; RAG can still use brute-force fallback.",
  },
  {
    name: "vector_extension_config",
    ok: vectorExtensionPath.length > 0,
    required: false,
    message: vectorExtensionPath
      ? `OMS_VECTOR_EXTENSION_PATH configured: ${vectorExtensionPath}`
      : "OMS_VECTOR_EXTENSION_PATH is not set; sqlite_vec will degrade to brute-force when RAG is enabled.",
  },
];
const warnings = checks.filter((check) => !check.required && !check.ok).map((check) => check.message);
const blocking = checks.filter((check) => check.required && !check.ok);
const report = {
  ok: blocking.length === 0 && (!strict || warnings.length === 0),
  nodeVersion,
  npmVersion,
  checks,
  warnings,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  process.exit(1);
}
