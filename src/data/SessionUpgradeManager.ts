import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { LoggerLike } from "../types";

export interface UpgradeChange {
  storeKey: string;
  from: number;
  to: number;
}

interface UpgradePathSet {
  label: string;
  sourcePath: string;
  snapshotRelativePath: string;
}

interface UpgradeRunArgs {
  dataDir: string;
  paths: UpgradePathSet[];
  pendingMigrations: UpgradeChange[];
  pendingRegistryUpgrades: UpgradeChange[];
  apply: () => Promise<{
    migrations: UpgradeChange[];
    registryUpgrades: UpgradeChange[];
  }>;
  validate: () => Promise<void>;
}

interface UpgradeSnapshotManifest {
  snapshotId: string;
  createdAt: string;
  paths: Array<{
    label: string;
    sourcePath: string;
    snapshotPath: string;
    existed: boolean;
  }>;
}

interface UpgradeReport {
  snapshotId: string;
  startedAt: string;
  finishedAt?: string;
  status: "pending" | "completed" | "rolled_back";
  pendingMigrations: UpgradeChange[];
  pendingRegistryUpgrades: UpgradeChange[];
  appliedMigrations: UpgradeChange[];
  appliedRegistryUpgrades: UpgradeChange[];
  rollbackReason?: string;
  validation: {
    ok: boolean;
    error?: string;
  };
}

export class SessionUpgradeManager {
  constructor(private readonly logger: LoggerLike) {}

  async runProtectedUpgrade(args: UpgradeRunArgs): Promise<void> {
    if (args.pendingMigrations.length === 0 && args.pendingRegistryUpgrades.length === 0) {
      return;
    }

    const snapshotId = this.buildSnapshotId();
    const upgradeRoot = path.join(args.dataDir, "_upgrades");
    const snapshotRoot = path.join(upgradeRoot, "snapshots", snapshotId);
    const reportPath = path.join(upgradeRoot, "reports", `${snapshotId}.json`);
    await mkdir(path.dirname(reportPath), { recursive: true });

    const report: UpgradeReport = {
      snapshotId,
      startedAt: new Date().toISOString(),
      status: "pending",
      pendingMigrations: args.pendingMigrations,
      pendingRegistryUpgrades: args.pendingRegistryUpgrades,
      appliedMigrations: [],
      appliedRegistryUpgrades: [],
      validation: {
        ok: false,
      },
    };
    await this.writeReport(reportPath, report);

    const manifest = await this.createSnapshot(snapshotRoot, args.paths);
    this.logger.info("session_upgrade_snapshot_created", {
      snapshotId,
      pathCount: manifest.paths.length,
      pendingMigrations: args.pendingMigrations,
      pendingRegistryUpgrades: args.pendingRegistryUpgrades,
    });

    try {
      const applied = await args.apply();
      report.appliedMigrations = applied.migrations;
      report.appliedRegistryUpgrades = applied.registryUpgrades;

      await args.validate();
      report.validation = { ok: true };
      report.status = "completed";
      report.finishedAt = new Date().toISOString();
      await this.writeManifest(snapshotRoot, manifest);
      await this.writeReport(reportPath, report);
      this.logger.info("session_upgrade_completed", {
        snapshotId,
        appliedMigrations: applied.migrations,
        appliedRegistryUpgrades: applied.registryUpgrades,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.restoreSnapshot(snapshotRoot, manifest);
      report.validation = { ok: false, error: message };
      report.status = "rolled_back";
      report.rollbackReason = message;
      report.finishedAt = new Date().toISOString();
      await this.writeManifest(snapshotRoot, manifest);
      await this.writeReport(reportPath, report);
      this.logger.error("session_upgrade_rolled_back", {
        snapshotId,
        error: message,
      });
      throw new Error(`Session data upgrade failed and was rolled back: ${message}`);
    }
  }

  private async createSnapshot(
    snapshotRoot: string,
    paths: UpgradePathSet[],
  ): Promise<UpgradeSnapshotManifest> {
    await mkdir(snapshotRoot, { recursive: true });
    const manifest: UpgradeSnapshotManifest = {
      snapshotId: path.basename(snapshotRoot),
      createdAt: new Date().toISOString(),
      paths: [],
    };

    for (const entry of paths) {
      const existed = await this.exists(entry.sourcePath);
      const snapshotPath = path.join(snapshotRoot, entry.snapshotRelativePath);
      if (existed) {
        await mkdir(path.dirname(snapshotPath), { recursive: true });
        await cp(entry.sourcePath, snapshotPath, { recursive: true });
      }
      manifest.paths.push({
        label: entry.label,
        sourcePath: entry.sourcePath,
        snapshotPath,
        existed,
      });
    }

    return manifest;
  }

  private async restoreSnapshot(
    snapshotRoot: string,
    manifest: UpgradeSnapshotManifest,
  ): Promise<void> {
    for (const entry of manifest.paths) {
      if (await this.exists(entry.sourcePath)) {
        await rm(entry.sourcePath, { recursive: true, force: true });
      }
      if (!entry.existed) {
        continue;
      }
      await mkdir(path.dirname(entry.sourcePath), { recursive: true });
      await cp(entry.snapshotPath, entry.sourcePath, { recursive: true });
    }
    await this.writeManifest(snapshotRoot, manifest);
  }

  private async writeManifest(snapshotRoot: string, manifest: UpgradeSnapshotManifest): Promise<void> {
    await writeFile(
      path.join(snapshotRoot, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  private async writeReport(reportPath: string, report: UpgradeReport): Promise<void> {
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  }

  private buildSnapshotId(): string {
    return `upgrade-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  }

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await stat(targetPath);
      return true;
    } catch {
      return false;
    }
  }
}
