import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore, type ForgeStoreOptions } from "./index.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Core governance migrations", () => {
  it("creates governance tables and single active lease constraint", () => {
    const store = openMigratedFixture();
    try {
      expect(tableNames(store.db)).toEqual(
        expect.arrayContaining([
          "core_workspace_groups",
          "core_workspace_leases",
          "core_policy_versions",
          "core_approvals",
          "core_budget_reservations",
          "core_artifacts",
          "core_validations",
          "core_agent_profile_versions",
        ]),
      );
      expect(indexSql(store.db, "uq_core_workspace_active_write_lease")).toContain(
        "released_at IS NULL",
      );
      expect(indexSql(store.db, "uq_core_workspace_active_write_lease")).toContain(
        "mode = 'write'",
      );
    } finally {
      store.close();
    }
  });

  it("records migrations 011 through 015 exactly once", () => {
    const options = freshStoreOptions();
    ForgeStore.open(options).close();
    const reopened = ForgeStore.open(options);
    try {
      const versions = reopened.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .pluck()
        .all() as string[];
      expect(versions).toEqual(
        expect.arrayContaining([
          "011_core_workspaces.sql",
          "012_core_policy_approvals.sql",
          "013_core_usage_budget.sql",
          "014_core_evidence.sql",
          "015_core_agent_profiles.sql",
        ]),
      );
      expect(
        reopened.db
          .prepare(
            `SELECT COUNT(*) AS count FROM schema_migrations
             WHERE version IN (?, ?, ?, ?, ?)`,
          )
          .get(
            "011_core_workspaces.sql",
            "012_core_policy_approvals.sql",
            "013_core_usage_budget.sql",
            "014_core_evidence.sql",
            "015_core_agent_profiles.sql",
          ),
      ).toEqual({ count: 5 });
    } finally {
      reopened.close();
    }
  });

  it("rejects negative budget reservation amounts", () => {
    const store = openMigratedFixture();
    try {
      store.db.exec(`
        INSERT INTO core_budget_accounts (
          id, name, currency, created_at, updated_at
        ) VALUES (
          'account-1', 'default', 'USD',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
      `);
      expect(() =>
        store.db.exec(`
          INSERT INTO core_budget_reservations (
            id, account_id, run_id, amount_minor, currency, state,
            expires_at, created_at
          ) VALUES (
            'res-1', 'account-1', 'run-1', -1, 'USD', 'reserved',
            '2026-01-01T01:00:00.000Z', '2026-01-01T00:00:00.000Z'
          );
        `),
      ).toThrow(/CHECK constraint failed/i);
    } finally {
      store.close();
    }
  });

  it("enforces a single active write lease per workspace", () => {
    const store = openMigratedFixture();
    try {
      store.db.exec(`
        INSERT INTO core_workspaces (
          id, root_path, canonical_root_path, created_at, updated_at
        ) VALUES (
          'ws-1', '/tmp/frontend', '/tmp/frontend',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO core_workspace_leases (
          id, workspace_id, run_id, mode, root_path,
          acquired_at, expires_at
        ) VALUES (
          'lease-1', 'ws-1', 'run-a', 'write', '/tmp/frontend',
          '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'
        );
      `);
      expect(() =>
        store.db.exec(`
          INSERT INTO core_workspace_leases (
            id, workspace_id, run_id, mode, root_path,
            acquired_at, expires_at
          ) VALUES (
            'lease-2', 'ws-1', 'run-b', 'write', '/tmp/frontend',
            '2026-01-01T00:00:01.000Z', '2026-01-01T01:00:01.000Z'
          );
        `),
      ).toThrow(/UNIQUE constraint failed/i);
    } finally {
      store.close();
    }
  });
});

function openMigratedFixture(): ForgeStore {
  return ForgeStore.open(freshStoreOptions());
}

function freshStoreOptions(): ForgeStoreOptions {
  const root = mkdtempSync(join(tmpdir(), "forge-governance-migrations-"));
  fixtureRoots.push(root);
  const dataDir = join(root, "data");
  return {
    dbPath: join(dataDir, "data.db"),
    migrationsDir,
    owner: "test",
  };
}

function tableNames(db: ForgeStore["db"]): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all() as string[];
}

function indexSql(db: ForgeStore["db"], name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) as { sql: string } | undefined;
  return row?.sql ?? "";
}
