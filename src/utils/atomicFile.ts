import { copyFile, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

const writeQueues = new Map<string, Promise<void>>();

export interface AtomicWriteOptions {
  keepBackup?: boolean;
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => writeFileAtomically(filePath, content, options));
  writeQueues.set(filePath, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(filePath) === next) {
      writeQueues.delete(filePath);
    }
  }
}

async function writeFileAtomically(
  filePath: string,
  content: string,
  options: AtomicWriteOptions,
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );

  await mkdir(dir, { recursive: true });
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (options.keepBackup) {
    try {
      await copyFile(filePath, `${filePath}.bak`);
    } catch {
      // Missing first-run files do not need backups.
    }
  }

  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}
