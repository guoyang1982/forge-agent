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

describe("Core assets and connectors migrations", () => {
  it("creates versioned workflow knowledge and connector tables", () => {
    const store = openMigratedFixture();
    try {
      expect(tableNames(store.db)).toEqual(
        expect.arrayContaining([
          "core_workflow_versions",
          "core_workflow_instances",
          "core_knowledge_sources",
          "core_memory_candidates",
          "core_connectors",
          "core_connector_actions",
          "core_assets",
          "core_asset_versions",
          "core_asset_dependencies",
        ]),
      );
    } finally {
      store.close();
    }
  });

  it("connector account schema contains credential_ref but no secret column", () => {
    const store = openMigratedFixture();
    try {
      const columns = tableColumns(store.db, "core_connector_accounts");
      expect(columns).toContain("credential_ref");
      expect(columns.some((name) => /secret|token|password|api_key/i.test(name))).toBe(
        false,
      );
    } finally {
      store.close();
    }
  });

  it("records migrations 016 through 018 exactly once", () => {
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
          "016_core_assets_workflows.sql",
          "017_core_knowledge_memory.sql",
          "018_core_connectors.sql",
        ]),
      );
      expect(
        reopened.db
          .prepare(
            `SELECT COUNT(*) AS count FROM schema_migrations
             WHERE version IN (?, ?, ?)`,
          )
          .get(
            "016_core_assets_workflows.sql",
            "017_core_knowledge_memory.sql",
            "018_core_connectors.sql",
          ),
      ).toEqual({ count: 3 });
    } finally {
      reopened.close();
    }
  });

  it("enforces unique workflow versions per workflow id", () => {
    const store = openMigratedFixture();
    try {
      store.db.exec(`
        INSERT INTO core_workflow_versions (
          id, workflow_id, version, definition_json, created_at
        ) VALUES (
          'wf-v1', 'workflow-1', 1, '{}', '2026-01-01T00:00:00.000Z'
        );
      `);
      expect(() =>
        store.db.exec(`
          INSERT INTO core_workflow_versions (
            id, workflow_id, version, definition_json, created_at
          ) VALUES (
            'wf-v2', 'workflow-1', 1, '{}', '2026-01-01T00:00:00.000Z'
          );
        `),
      ).toThrow(/UNIQUE constraint failed/i);
    } finally {
      store.close();
    }
  });

  it("deduplicates connector actions by account and idempotency key", () => {
    const store = openMigratedFixture();
    try {
      store.db.exec(`
        INSERT INTO core_connectors (
          id, name, adapter_kind, created_at, updated_at
        ) VALUES (
          'connector-1', 'mock', 'mock',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO core_connector_accounts (
          id, connector_id, name, credential_ref, created_at, updated_at
        ) VALUES (
          'account-1', 'connector-1', 'default', 'cred://mock/default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO core_connector_actions (
          id, connector_id, connector_account_id, action, state,
          idempotency_key, created_at, updated_at
        ) VALUES (
          'action-1', 'connector-1', 'account-1', 'publish', 'proposed',
          'once', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
      `);
      expect(() =>
        store.db.exec(`
          INSERT INTO core_connector_actions (
            id, connector_id, connector_account_id, action, state,
            idempotency_key, created_at, updated_at
          ) VALUES (
            'action-2', 'connector-1', 'account-1', 'publish', 'proposed',
            'once', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
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
  const root = mkdtempSync(join(tmpdir(), "forge-assets-connectors-migrations-"));
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

function tableColumns(db: ForgeStore["db"], table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}
