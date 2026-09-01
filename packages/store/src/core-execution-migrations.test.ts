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

describe("Core execution and event migrations", () => {
  it("creates execution and event tables with required indexes", () => {
    const store = openMigratedFixture();
    try {
      expect(tableNames(store.db)).toEqual(
        expect.arrayContaining([
          "core_runs",
          "core_steps",
          "core_step_dependencies",
          "core_attempts",
          "core_step_waits",
          "core_idempotency_records",
          "core_events",
          "core_outbox",
          "core_event_cursors",
          "core_eval_suites",
          "core_eval_runs",
          "core_eval_case_results",
        ]),
      );
      expect(indexNames(store.db)).toEqual(
        expect.arrayContaining([
          "idx_core_runs_state",
          "idx_core_steps_run_state",
          "idx_core_attempts_run_step",
          "idx_core_events_sequence",
          "idx_core_events_run",
          "idx_core_outbox_pending",
        ]),
      );
    } finally {
      store.close();
    }
  });

  it("records migrations 009 and 010 exactly once", () => {
    const options = freshStoreOptions();
    ForgeStore.open(options).close();
    const reopened = ForgeStore.open(options);
    try {
      expect(
        reopened.db
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .pluck()
          .all(),
      ).toEqual(
        expect.arrayContaining(["009_core_execution.sql", "010_core_events.sql"]),
      );
      expect(
        reopened.db
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version IN (?, ?)",
          )
          .get("009_core_execution.sql", "010_core_events.sql"),
      ).toEqual({ count: 2 });
    } finally {
      reopened.close();
    }
  });

  it("enforces unique attempt numbers and idempotency keys", () => {
    const store = openMigratedFixture();
    try {
      store.db.exec(`
        INSERT INTO core_runs (
          id, state, spec_json, correlation_id, requested_by_json,
          policy_context_json, created_at, updated_at
        ) VALUES (
          'run-1', 'queued', '{}', 'corr-1', '{}', '{}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO core_steps (
          id, run_id, kind, state, depends_on_json, input_json,
          retry_json, timeout_ms, created_at, updated_at
        ) VALUES (
          'step-1', 'run-1', 'legacy.run', 'pending', '[]', '{}',
          '{"maxAttempts":1,"backoffMs":0,"maxBackoffMs":0}', 60000,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO core_attempts (
          id, run_id, step_id, attempt_number, state, input_json,
          created_at, updated_at
        ) VALUES (
          'attempt-1', 'run-1', 'step-1', 1, 'created', '{}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO core_idempotency_records (
          idempotency_key, run_id, step_id, attempt_id, created_at
        ) VALUES (
          'idem-1', 'run-1', 'step-1', 'attempt-1',
          '2026-01-01T00:00:00.000Z'
        );
      `);

      expect(() =>
        store.db.exec(`
          INSERT INTO core_attempts (
            id, run_id, step_id, attempt_number, state, input_json,
            created_at, updated_at
          ) VALUES (
            'attempt-2', 'run-1', 'step-1', 1, 'created', '{}',
            '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
          );
        `),
      ).toThrow(/UNIQUE constraint failed/i);

      expect(() =>
        store.db.exec(`
          INSERT INTO core_idempotency_records (
            idempotency_key, run_id, step_id, attempt_id, created_at
          ) VALUES (
            'idem-1', 'run-1', 'step-1', 'attempt-1',
            '2026-01-01T00:00:02.000Z'
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
  const root = mkdtempSync(join(tmpdir(), "forge-core-exec-migrations-"));
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

function indexNames(db: ForgeStore["db"]): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .pluck()
    .all() as string[];
}
