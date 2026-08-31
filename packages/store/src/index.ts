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
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new Error("busyTimeoutMs must be a non-negative integer");
    }

    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.pragma("journal_mode = WAL");
      db.pragma(`busy_timeout = ${busyTimeoutMs}`);
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
