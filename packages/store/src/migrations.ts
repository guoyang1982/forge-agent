import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MigrationRunnerOptions {
  migrationsDir: string;
  owner: "daemon" | "test";
}

interface AppliedMigration {
  version: string;
  checksum: string;
}

interface MigrationFile {
  version: string;
  checksum: string;
  sql: string;
}

const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL
  )
`;

export class MigrationRunner {
  constructor(
    private readonly db: Database.Database,
    private readonly options: MigrationRunnerOptions,
  ) {}

  applyPending(): void {
    assertMigrationOwner(this.options.owner);
    this.db.exec(BOOTSTRAP_SQL);
    for (const migration of readMigrations(this.options.migrationsDir)) {
      this.applyMigration(migration);
    }
  }

  private applyMigration(migration: MigrationFile): void {
    const apply = this.db.transaction(() => {
      const applied = this.db
        .prepare(
          "SELECT version, checksum FROM schema_migrations WHERE version = ?",
        )
        .get(migration.version) as AppliedMigration | undefined;
      if (applied) {
        if (applied.checksum !== migration.checksum) {
          throw new Error(
            `migration checksum mismatch for ${migration.version}`,
          );
        }
        return;
      }

      const startedAt = performance.now();
      if (migration.version === "001_init.sql") {
        adoptLegacyMemoryProjectId(this.db);
      }
      if (migration.version === "019_automation_durable_links.sql") {
        remediateDuplicateWorkflowOccurrences(this.db);
      }
      if (migration.sql.trim()) this.db.exec(migration.sql);
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      this.db
        .prepare(
          `INSERT INTO schema_migrations
            (version, checksum, applied_at, duration_ms)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          migration.version,
          migration.checksum,
          new Date().toISOString(),
          durationMs,
        );
    });
    apply.immediate();
  }
}

function remediateDuplicateWorkflowOccurrences(db: Database.Database): void {
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'core_workflow_instances'",
    )
    .get() as { name: string } | undefined;
  if (!table) return;

  const duplicateGroups = db
    .prepare(
      `SELECT workflow_id AS workflowId, trigger_ref AS triggerRef
       FROM core_workflow_instances
       WHERE trigger_ref IS NOT NULL
       GROUP BY workflow_id, trigger_ref
       HAVING COUNT(*) > 1`,
    )
    .all() as Array<{ workflowId: string; triggerRef: string }>;

  const listGroup = db.prepare(
    `SELECT id, run_id AS runId, created_at AS createdAt
     FROM core_workflow_instances
     WHERE workflow_id = ? AND trigger_ref = ?
     ORDER BY CASE WHEN run_id IS NULL THEN 1 ELSE 0 END, created_at ASC, id ASC`,
  );
  const renameDuplicate = db.prepare(
    `UPDATE core_workflow_instances
     SET trigger_ref = ?, updated_at = ?
     WHERE id = ?`,
  );

  const now = new Date().toISOString();
  for (const group of duplicateGroups) {
    const rows = listGroup.all(group.workflowId, group.triggerRef) as Array<{
      id: string;
      runId: string | null;
      createdAt: string;
    }>;
    for (const row of rows.slice(1)) {
      renameDuplicate.run(`${group.triggerRef}:remediated:${row.id}`, now, row.id);
    }
  }
}

function adoptLegacyMemoryProjectId(db: Database.Database): void {
  const memoryTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'",
    )
    .get() as { name: string } | undefined;
  if (!memoryTable) return;

  const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("project_id")) {
    db.exec("ALTER TABLE memories ADD COLUMN project_id TEXT");
  }
  if (names.has("session_scope")) {
    db.exec(
      "UPDATE memories SET project_id = session_scope WHERE project_id IS NULL",
    );
  }
}

function readMigrations(migrationsDir: string): MigrationFile[] {
  if (!existsSync(migrationsDir)) {
    throw new Error(`migrations directory not found: ${migrationsDir}`);
  }
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort()
    .map((version) => {
      const source = readFileSync(join(migrationsDir, version));
      return {
        version,
        checksum: createHash("sha256").update(source).digest("hex"),
        sql: source.toString("utf8"),
      };
    });
}

function assertMigrationOwner(owner: string): asserts owner is "daemon" | "test" {
  if (owner !== "daemon" && owner !== "test") {
    throw new Error(`invalid migration owner: ${owner}`);
  }
}
