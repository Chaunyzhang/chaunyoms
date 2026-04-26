import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { BridgeConfig, LoggerLike } from "../types";

export type OmsTestRunStatus =
  | "created"
  | "running"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

export interface OmsTestRunRecord {
  id: string;
  suite: string;
  mode: "new_agent";
  status: OmsTestRunStatus;
  phase: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  currentStep: number;
  totalSteps: number;
  progress: number;
  agentId: string;
  sessionId: string;
  workspaceDir: string;
  runDir: string;
  logPath: string;
  reportPath: string;
  runtimeReportPath: string;
  smokeReportPath: string;
  metadata: {
    pluginDataDir: string;
    memoryVaultDir: string;
    workspaceRoot: string;
    requestedByAgent: string;
    requestedBySession: string;
  };
  pid?: number;
  cancelRequested?: boolean;
  cancellationReason?: string;
  error?: string;
}

export class OmsTestService {
  constructor(private readonly getLogger: () => LoggerLike) {}

  async start(
    config: BridgeConfig,
    options: {
      suite?: string;
    } = {},
  ): Promise<OmsTestRunRecord> {
    const suite = options.suite?.trim() || "stable_smoke_v1";
    const id = `oms-test-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const runDir = path.join(config.dataDir, "test-runs", id);
    const workspaceRoot = path.join(config.dataDir, "test-workspaces");
    const workspaceDir = path.join(workspaceRoot, id);
    const agentId = `chaunyoms-test-${id.slice(-8)}`;
    const sessionId = `${id}-session`;
    const logPath = path.join(runDir, "run.log");
    const reportPath = path.join(runDir, "report.json");
    const runtimeReportPath = path.join(runDir, "runtime-report.json");
    const smokeReportPath = path.join(runDir, "session-smoke.json");
    const statusPath = this.getStatusPath(config, id);

    await mkdir(runDir, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });

    const record: OmsTestRunRecord = {
      id,
      suite,
      mode: "new_agent",
      status: "created",
      phase: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentStep: 0,
      totalSteps: 8,
      progress: 0,
      agentId,
      sessionId,
      workspaceDir,
      runDir,
      logPath,
      reportPath,
      runtimeReportPath,
      smokeReportPath,
      metadata: {
        pluginDataDir: config.dataDir,
        memoryVaultDir: config.memoryVaultDir,
        workspaceRoot,
        requestedByAgent: config.agentId,
        requestedBySession: config.sessionId,
      },
    };

    await this.writeRunRecord(statusPath, record);
    const pid = this.spawnWorker(config, record, statusPath);
    const updatedRecord = {
      ...record,
      pid,
      updatedAt: new Date().toISOString(),
    };
    await this.writeRunRecord(statusPath, updatedRecord);
    return updatedRecord;
  }

  async get(config: BridgeConfig, id: string): Promise<OmsTestRunRecord | null> {
    const statusPath = this.getStatusPath(config, id);
    try {
      const raw = await readFile(statusPath, "utf8");
      return JSON.parse(raw) as OmsTestRunRecord;
    } catch {
      return null;
    }
  }

  async list(config: BridgeConfig, limit = 20): Promise<OmsTestRunRecord[]> {
    const root = path.join(config.dataDir, "test-runs");
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const records: OmsTestRunRecord[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const record = await this.get(config, entry.name);
        if (record) {
          records.push(record);
        }
      }
      return records
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, Math.max(1, limit));
    } catch {
      return [];
    }
  }

  async readResult(config: BridgeConfig, id: string): Promise<Record<string, unknown> | null> {
    const record = await this.get(config, id);
    if (!record) {
      return null;
    }
    const result = await this.readJsonIfPresent(record.reportPath);
    const runtimeReport = await this.readJsonIfPresent(record.runtimeReportPath);
    const smokeReport = await this.readJsonIfPresent(record.smokeReportPath);
    return {
      run: record,
      result,
      runtimeReport,
      smokeReport,
    };
  }

  async cancel(
    config: BridgeConfig,
    id: string,
    reason = "cancel_requested",
  ): Promise<OmsTestRunRecord | null> {
    const record = await this.get(config, id);
    if (!record) {
      return null;
    }
    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
      return record;
    }
    const updated: OmsTestRunRecord = {
      ...record,
      status: "cancelling",
      phase: "cancelling",
      cancelRequested: true,
      cancellationReason: reason,
      updatedAt: new Date().toISOString(),
    };
    await this.writeRunRecord(this.getStatusPath(config, id), updated);
    this.getLogger().warn("oms_test_cancel_requested", {
      runId: id,
      pid: record.pid,
      reason,
    });
    return updated;
  }

  private getStatusPath(config: BridgeConfig, id: string): string {
    return path.join(config.dataDir, "test-runs", id, "status.json");
  }

  private async writeRunRecord(filePath: string, record: OmsTestRunRecord): Promise<void> {
    await writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
  }

  private spawnWorker(config: BridgeConfig, record: OmsTestRunRecord, statusPath: string): number | undefined {
    const pluginRoot = path.resolve(__dirname, "..", "..", "..");
    const workerPath = path.join(pluginRoot, "scripts", "openclaw-real-test-worker.cjs");
    const child = spawn(
      process.execPath,
      [
        "--experimental-sqlite",
        workerPath,
        "--status-file",
        statusPath,
      ],
      {
        cwd: pluginRoot,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          CHAUNYOMS_TEST_AGENT_ID: record.agentId,
          CHAUNYOMS_TEST_SESSION_ID: record.sessionId,
          CHAUNYOMS_TEST_SUITE: record.suite,
          CHAUNYOMS_TEST_DATA_DIR: config.dataDir,
          CHAUNYOMS_TEST_MEMORY_VAULT_DIR: config.memoryVaultDir,
          CHAUNYOMS_TEST_WORKSPACE_DIR: record.workspaceDir,
          CHAUNYOMS_TEST_RUN_DIR: record.runDir,
        },
      },
    );
    child.unref();
    this.getLogger().info("oms_test_worker_spawned", {
      runId: record.id,
      pid: child.pid,
      suite: record.suite,
      agentId: record.agentId,
      sessionId: record.sessionId,
    });
    return child.pid;
  }

  private async readJsonIfPresent(filePath: string): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
