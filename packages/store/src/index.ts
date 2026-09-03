import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  backupDatabase,
  type BackupManifest,
} from "./backup.js";
import {
  MigrationRunner,
  type MigrationRunnerOptions,
} from "./migrations.js";

export type { Database } from "better-sqlite3";
export { MigrationRunner, type MigrationRunnerOptions } from "./migrations.js";
export { type BackupManifest } from "./backup.js";

export interface ForgeStoreOptions extends MigrationRunnerOptions {
  dbPath: string;
  busyTimeoutMs?: number;
}

export function openNonMigratingDatabase(
  dbPathInput: string,
  busyTimeoutMs = 5000,
): Database.Database {
  const dbPath = resolveRequiredPath(dbPathInput, "database path");
  assertBusyTimeout(busyTimeoutMs);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    db.pragma("foreign_keys = ON");
    assertForeignKeysEnabled(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export class ForgeStore {
  private constructor(
    readonly db: Database.Database,
    private readonly dbPath: string,
  ) {}

  static open(options: ForgeStoreOptions): ForgeStore {
    const dbPath = resolveRequiredPath(options.dbPath, "database path");
    const migrationsDir = resolveRequiredPath(
      options.migrationsDir,
      "migrations directory",
    );
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    const db = openNonMigratingDatabase(dbPath, busyTimeoutMs);
    try {
      new MigrationRunner(db, {
        migrationsDir,
        owner: options.owner,
      }).applyPending();
      return new ForgeStore(db, dbPath);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  backup(targetPath: string): Promise<BackupManifest> {
    return backupDatabase(this.db, this.dbPath, targetPath);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

function resolveRequiredPath(input: string, label: string): string {
  if (!input.trim()) throw new Error(`${label} is required`);
  return resolve(input);
}

function assertBusyTimeout(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("busyTimeoutMs must be a non-negative integer");
  }
}

export function assertForeignKeysEnabled(db: Database.Database): void {
  const enabled = db.pragma("foreign_keys", { simple: true });
  if (enabled !== 1) {
    throw new Error("foreign_keys must be enabled on every database connection");
  }
}
