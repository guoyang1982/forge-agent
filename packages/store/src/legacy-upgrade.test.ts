import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createCoreV1Fixture } from "../../../apps/daemon/test-fixtures/core-v1-data.js";
import * as backupData from "../../../scripts/core-v2/backup-data.js";
import { ForgeStore } from "./index.js";

const fixtureRoots: string[] = [];
const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Core v1 database upgrade", () => {
  it("adopts migrations 001-008 without losing legacy session or memory rows", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-core-v1-upgrade-"));
    fixtureRoots.push(root);
    const fixture = createCoreV1Fixture({ root, migrationsDir });

    let store: ForgeStore | undefined;
    expect(() => {
      store = ForgeStore.open(fixture.options);
    }).not.toThrow();
    try {
      expect(
        store!.db.prepare("SELECT content FROM messages WHERE id = 1").pluck().get(),
      ).toBe(fixture.messageContent);
      expect(
        store!.db
          .prepare("SELECT project_id, content FROM memories WHERE id = 'legacy-memory'")
          .get(),
      ).toEqual({
        project_id: fixture.projectId,
        content: fixture.memoryContent,
      });
      expect(
        store!.db
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .pluck()
          .all(),
      ).toEqual([
        "001_init.sql",
        "002_memory_project_id.sql",
        "003_automations.sql",
        "004_channels.sql",
        "005_workspace_checkpoints.sql",
        "006_session_dispatch_plans.sql",
        "007_session_events.sql",
        "008_mobile_devices.sql",
        "009_core_execution.sql",
        "010_core_events.sql",
        "011_core_workspaces.sql",
        "012_core_policy_approvals.sql",
        "013_core_usage_budget.sql",
        "014_core_evidence.sql",
        "015_core_agent_profiles.sql",
        "016_core_assets_workflows.sql",
        "017_core_knowledge_memory.sql",
        "018_core_connectors.sql",
        "019_automation_durable_links.sql",
        "020_execution_idempotency_state.sql",
        "021_automation_recovery.sql",
        "022_outbox_delivery_leases.sql",
        "023_workspace_canonical_root_unique.sql",
        "024_core_remediation.sql",
      ]);
    } finally {
      store?.close();
    }
  });

  it("remediates duplicate workflow trigger references before migration 019", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-core-v1-duplicate-occurrence-"));
    fixtureRoots.push(root);
    const fixture = createCoreV1Fixture({ root, migrationsDir });
    const partialMigrationsDir = join(root, "migrations-through-018");
    mkdirSync(partialMigrationsDir);
    for (const name of readdirSync(migrationsDir).sort()) {
      if (name >= "019_automation_durable_links.sql") break;
      copyFileSync(join(migrationsDir, name), join(partialMigrationsDir, name));
    }

    ForgeStore.open({
      ...fixture.options,
      migrationsDir: partialMigrationsDir,
    }).close();

    const db = new Database(fixture.options.dbPath);
    try {
      db.exec(`
        INSERT INTO core_workflow_versions (
          id, workflow_id, version, definition_json, created_at
        ) VALUES (
          'wf-version-dup', 'workflow:dup', 1, '{}', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO core_runs (
          id, state, spec_json, correlation_id, requested_by_json,
          acting_subject_json, objective, policy_context_json, created_at, updated_at
        ) VALUES (
          'run-canonical', 'succeeded', '{}', 'corr-canonical',
          '{"kind":"human","id":"local-user"}',
          '{"kind":"agent_profile","id":"profile-1"}',
          'duplicate remediation fixture', '{}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO core_workflow_instances (
          id, workflow_id, workflow_version_id, run_id, state, trigger_kind,
          trigger_ref, input_json, created_at, updated_at
        ) VALUES
          ('instance-canonical', 'workflow:dup', 'wf-version-dup', 'run-canonical',
           'succeeded', 'manual', 'occurrence:1', '{}',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('instance-duplicate', 'workflow:dup', 'wf-version-dup', NULL,
           'failed', 'manual', 'occurrence:1', '{}',
           '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      `);
    } finally {
      db.close();
    }

    const store = ForgeStore.open(fixture.options);
    try {
      expect(
        store.db
          .prepare(
            `SELECT id, trigger_ref AS triggerRef
             FROM core_workflow_instances
             WHERE workflow_id = 'workflow:dup'
             ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: "instance-canonical", triggerRef: "occurrence:1" },
        {
          id: "instance-duplicate",
          triggerRef: "occurrence:1:remediated:instance-duplicate",
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("restores a verified v1 backup into a clean directory and upgrades it", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-core-v1-restore-"));
    fixtureRoots.push(root);
    const fixture = createCoreV1Fixture({ root, migrationsDir });
    const backup = await backupData.backupForgeData({
      dataDir: fixture.dataDir,
      outputDir: join(root, "backups"),
    });
    const restoreForgeDataBackup = (
      backupData as unknown as {
        restoreForgeDataBackup?: (input: {
          manifestPath: string;
          restoreDir: string;
        }) => Promise<{ restoreDir: string }>;
      }
    ).restoreForgeDataBackup;
    expect(restoreForgeDataBackup).toBeTypeOf("function");
    if (!restoreForgeDataBackup) return;

    const restoreDir = join(root, "restored-core-v1-data");
    const restored = await restoreForgeDataBackup({
      manifestPath: backup.manifestPath,
      restoreDir,
    });
    expect(restored.restoreDir).toBe(realpathSync(restoreDir));
    expect(JSON.parse(readFileSync(join(restoreDir, "config.json"), "utf8"))).toEqual({
      ui: { theme: "dark" },
    });

    const store = ForgeStore.open({
      ...fixture.options,
      dbPath: join(restoreDir, "data.db"),
    });
    try {
      expect(
        store.db.prepare("SELECT content FROM messages WHERE id = 1").pluck().get(),
      ).toBe(fixture.messageContent);
    } finally {
      store.close();
    }
  });
});
