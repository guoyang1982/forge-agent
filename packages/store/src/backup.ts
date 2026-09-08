import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface BackupManifest {
  createdAt: string;
  sourcePath: string;
  targetPath: string;
  bytes: number;
  sha256: string;
}

export async function backupDatabase(
  db: Database.Database,
  sourcePathInput: string,
  targetPathInput: string,
): Promise<BackupManifest> {
  const sourcePath = resolve(sourcePathInput);
  const targetPath = resolve(targetPathInput);
  if (sourcePath === targetPath) {
    throw new Error("backup target must differ from the source database");
  }
  if (existsSync(targetPath)) {
    throw new Error(`backup target already exists: ${targetPath}`);
  }

  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await db.backup(targetPath);
    const info = await stat(targetPath);
    return {
      createdAt: new Date().toISOString(),
      sourcePath,
      targetPath,
      bytes: info.size,
      sha256: await sha256File(targetPath),
    };
  } catch (error) {
    await rm(targetPath, { force: true });
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
