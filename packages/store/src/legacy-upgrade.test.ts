import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      ]);
    } finally {
      store?.close();
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
