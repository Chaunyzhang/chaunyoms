import { homedir } from "node:os";
import path from "node:path";

function nonEmptyEnv(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function getOpenClawHomeDir(): string {
  return nonEmptyEnv("OPENCLAW_HOME") ?? path.join(homedir(), ".openclaw");
}

export function getOpenClawConfigPath(): string {
  return path.join(getOpenClawHomeDir(), "openclaw.json");
}

export function getDefaultSharedDataDir(): string {
  const explicit =
    nonEmptyEnv("OPENCLAW_SHARED_DATA_DIR") ??
    nonEmptyEnv("OPENCLAW_DATA_DIR");
  if (explicit) {
    return explicit;
  }

  const xdgDataHome = nonEmptyEnv("XDG_DATA_HOME");
  if (xdgDataHome) {
    return path.join(xdgDataHome, "openclaw");
  }

  if (process.platform === "win32") {
    const localAppData = nonEmptyEnv("LOCALAPPDATA") ?? nonEmptyEnv("APPDATA");
    if (localAppData) {
      return path.join(localAppData, "OpenClaw");
    }
  }

  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "OpenClaw");
  }

  return path.join(getOpenClawHomeDir(), "data");
}

export function getDefaultWorkspaceDir(): string {
  return nonEmptyEnv("OPENCLAW_WORKSPACE_DIR") ??
    path.join(getOpenClawHomeDir(), "workspace");
}
