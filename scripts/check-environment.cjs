#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");

function serializeVectorFloat32(vector) {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => {
    view.setFloat32(index * 4, Number.isFinite(value) ? value : 0, true);
  });
  return bytes;
}

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

function checkVectorExtensionLoad(vectorExtensionPath, vectorExtensionEntryPoint) {
  if (!vectorExtensionPath) {
    return null;
  }
  if (!existsSync(vectorExtensionPath)) {
    return {
      name: "vector_extension_load",
      ok: false,
      required: false,
      message: `Configured vector extension does not exist: ${vectorExtensionPath}`,
    };
  }
  try {
    const sqlite = require("node:sqlite");
    if (!sqlite.DatabaseSync) {
      throw new Error("node_sqlite_database_unavailable");
    }
    const db = new sqlite.DatabaseSync(":memory:");
    try {
      if (typeof db.enableLoadExtension !== "function" || typeof db.loadExtension !== "function") {
        throw new Error("sqlite_load_extension_unavailable");
      }
      db.enableLoadExtension(true);
      if (vectorExtensionEntryPoint) {
        db.loadExtension(vectorExtensionPath, vectorExtensionEntryPoint);
      } else {
        db.loadExtension(vectorExtensionPath);
      }
      db.enableLoadExtension(false);
      const row = db.prepare("SELECT vec_distance_cosine(?, ?) AS distance")
        .get(serializeVectorFloat32([1, 0]), serializeVectorFloat32([1, 0]));
      const distance = Number(row && row.distance);
      if (!Number.isFinite(distance) || Math.abs(distance) > 0.0001) {
        throw new Error("sqlite_vec_probe_failed");
      }
      return {
        name: "vector_extension_load",
        ok: true,
        required: false,
        message: "Configured SQLite vector extension loaded and passed vec_distance_cosine probe.",
      };
    } finally {
      try {
        if (typeof db.enableLoadExtension === "function") {
          db.enableLoadExtension(false);
        }
      } catch {
        // The connection is closing; loading is optional and isolated.
      }
      db.close();
    }
  } catch (error) {
    return {
      name: "vector_extension_load",
      ok: false,
      required: false,
      message: `Configured vector extension failed to load/probe: ${error && error.message ? error.message : String(error)}`,
    };
  }
}

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const vectorExtensionPath = process.env.OMS_VECTOR_EXTENSION_PATH || "";
const vectorExtensionEntryPoint = process.env.OMS_VECTOR_EXTENSION_ENTRY_POINT || "";
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
const vectorExtensionLoad = checkVectorExtensionLoad(vectorExtensionPath, vectorExtensionEntryPoint);
if (vectorExtensionLoad) {
  checks.push(vectorExtensionLoad);
}
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
