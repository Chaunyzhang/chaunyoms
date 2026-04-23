import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionUpgradeManager } from "../data/SessionUpgradeManager";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chaunyoms-upgrade-protection-"));
  const targetFile = path.join(dir, "state.json");
  await mkdir(dir, { recursive: true });
  await writeFile(targetFile, JSON.stringify({ version: 1 }), "utf8");

  const manager = new SessionUpgradeManager({
    info(): void {},
    warn(): void {},
    error(): void {},
  });

  await manager.runProtectedUpgrade({
    dataDir: dir,
    paths: [
      {
        label: "state",
        sourcePath: targetFile,
        snapshotRelativePath: "state.json",
      },
    ],
    pendingMigrations: [{ storeKey: "raw_messages", from: 1, to: 2 }],
    pendingRegistryUpgrades: [],
    apply: async () => {
      await writeFile(targetFile, JSON.stringify({ version: 2 }), "utf8");
      return {
        migrations: [{ storeKey: "raw_messages", from: 1, to: 2 }],
        registryUpgrades: [],
      };
    },
    validate: async () => {
      const content = JSON.parse(await readFile(targetFile, "utf8")) as { version: number };
      assert(content.version === 2, "expected upgraded version during validation");
    },
  });

  const successContent = JSON.parse(await readFile(targetFile, "utf8")) as { version: number };
  assert(successContent.version === 2, "expected successful upgrade to persist new file content");

  let rollbackTriggered = false;
  try {
    await manager.runProtectedUpgrade({
      dataDir: dir,
      paths: [
        {
          label: "state",
          sourcePath: targetFile,
          snapshotRelativePath: "state.json",
        },
      ],
      pendingMigrations: [{ storeKey: "summaries", from: 1, to: 2 }],
      pendingRegistryUpgrades: [],
      apply: async () => {
        await writeFile(targetFile, JSON.stringify({ version: 3 }), "utf8");
        return {
          migrations: [{ storeKey: "summaries", from: 1, to: 2 }],
          registryUpgrades: [],
        };
      },
      validate: async () => {
        throw new Error("forced validation failure");
      },
    });
  } catch (error) {
    rollbackTriggered = /rolled back/i.test(String(error));
  }

  assert(rollbackTriggered, "expected upgrade manager to surface rollback failure");
  const rolledBackContent = JSON.parse(await readFile(targetFile, "utf8")) as { version: number };
  assert(rolledBackContent.version === 2, "expected rollback to restore pre-upgrade snapshot");

  const reportsDir = path.join(dir, "_upgrades", "reports");
  const snapshotDir = path.join(dir, "_upgrades", "snapshots");
  const reportNames = await (await import("node:fs/promises")).readdir(reportsDir);
  const snapshotNames = await (await import("node:fs/promises")).readdir(snapshotDir);
  assert(reportNames.length >= 2, "expected upgrade reports to be written");
  assert(snapshotNames.length >= 2, "expected snapshot directories to be written");

  console.log("test-upgrade-protection passed");
}

void main();
