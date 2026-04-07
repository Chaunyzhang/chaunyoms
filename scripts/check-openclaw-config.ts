import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type JsonObject = Record<string, unknown>;

interface CheckIssue {
  key: string;
  expected: string;
  actual: string;
}

function parseArgs(argv: string[]): { fix: boolean; restore: boolean } {
  const fix = argv.includes("--fix");
  const restore = argv.includes("--restore");
  return { fix, restore };
}

function getConfigPaths(): {
  openclawDir: string;
  configPath: string;
  backupDir: string;
  backupPath: string;
} {
  const home = os.homedir();
  const openclawDir = path.join(home, ".openclaw");
  const configPath = path.join(openclawDir, "openclaw.json");
  const backupDir = path.join(openclawDir, "config-backup");
  const backupPath = path.join(backupDir, "openclaw.json");
  return { openclawDir, configPath, backupDir, backupPath };
}

async function readJson(filePath: string): Promise<JsonObject> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as JsonObject;
}

async function writeJson(filePath: string, data: JsonObject): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function ensureObject(root: JsonObject, key: string): Record<string, unknown> {
  const value = root[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  root[key] = created;
  return created;
}

function ensureArray(root: JsonObject, key: string): unknown[] {
  const value = root[key];
  if (Array.isArray(value)) {
    return value;
  }
  const created: unknown[] = [];
  root[key] = created;
  return created;
}

function checkConfig(config: JsonObject): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const plugins = (config.plugins ?? {}) as JsonObject;
  const slots = (plugins.slots ?? {}) as JsonObject;
  if (slots.contextEngine !== "chaunyoms") {
    issues.push({
      key: "plugins.slots.contextEngine",
      expected: "chaunyoms",
      actual: String(slots.contextEngine ?? "(missing)"),
    });
  }

  const entries = (plugins.entries ?? {}) as JsonObject;
  const chaunyoms = (entries.chaunyoms ?? {}) as JsonObject;
  if (chaunyoms.enabled !== true) {
    issues.push({
      key: "plugins.entries.chaunyoms.enabled",
      expected: "true",
      actual: String(chaunyoms.enabled ?? "(missing)"),
    });
  }
  const pluginConfig = (chaunyoms.config ?? {}) as JsonObject;
  if (Object.keys(pluginConfig).length === 0) {
    issues.push({
      key: "plugins.entries.chaunyoms.config",
      expected: "object (plugin config should live here, not top-level)",
      actual: "(missing or empty)",
    });
  }

  const agents = (config.agents ?? {}) as JsonObject;
  const defaults = (agents.defaults ?? {}) as JsonObject;
  const memorySearch = (defaults.memorySearch ?? {}) as JsonObject;
  const extraPaths = Array.isArray(memorySearch.extraPaths)
    ? (memorySearch.extraPaths as unknown[])
    : [];
  const hasSharedDataPath = extraPaths.some(
    (value) =>
      typeof value === "string" &&
      value.toLowerCase().includes("c:\\openclaw-data"),
  );
  if (!hasSharedDataPath) {
    issues.push({
      key: "agents.defaults.memorySearch.extraPaths",
      expected: 'contains "C:\\openclaw-data"',
      actual: JSON.stringify(extraPaths),
    });
  }

  const memorySearchReady =
    memorySearch.enabled === true &&
    Boolean(
      memorySearch.provider ??
        memorySearch.profile ??
        memorySearch.model ??
        memorySearch.embedModel ??
        memorySearch.baseUrl ??
        memorySearch.endpoint,
    );
  if (!memorySearchReady) {
    issues.push({
      key: "agents.defaults.memorySearch",
      expected: "enabled and provider/model-style config present for embeddings retrieval",
      actual: JSON.stringify(memorySearch),
    });
  }

  return issues;
}

function applyFixes(config: JsonObject): JsonObject {
  const plugins = ensureObject(config, "plugins");
  const slots = ensureObject(plugins, "slots");
  slots.contextEngine = "chaunyoms";
  const entries = ensureObject(plugins, "entries");
  const pluginEntry = ensureObject(entries, "chaunyoms");
  pluginEntry.enabled = true;
  ensureObject(pluginEntry, "config");

  const agents = ensureObject(config, "agents");
  const defaults = ensureObject(agents, "defaults");
  const memorySearch = ensureObject(defaults, "memorySearch");
  const extraPaths = ensureArray(memorySearch, "extraPaths");
  const hasSharedDataPath = extraPaths.some(
    (value) =>
      typeof value === "string" &&
      value.toLowerCase().includes("c:\\openclaw-data"),
  );
  if (!hasSharedDataPath) {
    extraPaths.push("C:\\openclaw-data");
  }

  return config;
}

async function ensureBackup(configPath: string, backupPath: string) {
  await mkdir(path.dirname(backupPath), { recursive: true });
  await copyFile(configPath, backupPath);
}

async function main(): Promise<void> {
  const { fix, restore } = parseArgs(process.argv.slice(2));
  const { configPath, backupPath } = getConfigPaths();

  if (restore) {
    await copyFile(backupPath, configPath);
    console.log(`[chaunyoms-check] restored config from backup: ${backupPath}`);
    return;
  }

  const config = await readJson(configPath);
  const issues = checkConfig(config);
  if (issues.length === 0) {
    console.log("[chaunyoms-check] config is healthy");
    return;
  }

  console.log("[chaunyoms-check] config issues:");
  for (const issue of issues) {
    console.log(
      `- ${issue.key}: expected ${issue.expected}, actual ${issue.actual}`,
    );
  }

  if (!fix) {
    process.exitCode = 1;
    return;
  }

  await ensureBackup(configPath, backupPath);
  const fixed = applyFixes(config);
  await writeJson(configPath, fixed);
  console.log(`[chaunyoms-check] fixed and saved config: ${configPath}`);
  console.log(`[chaunyoms-check] backup updated: ${backupPath}`);
}

void main().catch((error) => {
  console.error(
    `[chaunyoms-check] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
