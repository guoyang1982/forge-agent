import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "./index.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("tenant scope migration", () => {
  it("moves legacy company and unscoped records into explicit isolation boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-tenant-migration-"));
    fixtureRoots.push(root);
    const oldMigrations = join(root, "old-migrations");
    mkdirSync(oldMigrations);
    for (const name of readdirSync(migrationsDir)) {
      if (name.endsWith(".sql") && name < "027_") {
        copyFileSync(join(migrationsDir, name), join(oldMigrations, name));
      }
    }
    const dbPath = join(root, "data.db");
    const legacy = ForgeStore.open({
      dbPath,
      migrationsDir: oldMigrations,
      owner: "test",
    });
    legacy.db.exec(`
      INSERT INTO core_knowledge_sources (
        id, name, source_kind, access_scope_json, created_at, updated_at
      ) VALUES
        ('knowledge-company', 'company', 'document', '{"companyId":"company-a"}', '2026-01-01', '2026-01-01'),
        ('knowledge-local', 'local', 'document', '{}', '2026-01-01', '2026-01-01');
      INSERT INTO core_memory_candidates (
        id, scope_json, claim, source_kind, source_ref,
        decision, created_at
      ) VALUES
        ('memory-company', '{"companyId":"company-a","employeeId":"e1"}', 'company', 'test', 'test', 'pending', '2026-01-01'),
        ('memory-local', '{"employeeId":"e1"}', 'local', 'test', 'test', 'pending', '2026-01-01');
    `);
    legacy.close();

    const upgraded = ForgeStore.open({ dbPath, migrationsDir, owner: "test" });
    try {
      expect(readJson(upgraded, "core_knowledge_sources", "access_scope_json")).toEqual([
        {
          id: "knowledge-company",
          scope: { tenantId: "company-a", organizationId: "company-a" },
        },
        { id: "knowledge-local", scope: { tenantId: "local" } },
      ]);
      expect(readJson(upgraded, "core_memory_candidates", "scope_json")).toEqual([
        {
          id: "memory-company",
          scope: {
            tenantId: "company-a",
            organizationId: "company-a",
            employeeId: "e1",
          },
        },
        {
          id: "memory-local",
          scope: { tenantId: "local", employeeId: "e1" },
        },
      ]);
    } finally {
      upgraded.close();
    }
  });
});

function readJson(
  store: ForgeStore,
  table: "core_knowledge_sources" | "core_memory_candidates",
  column: "access_scope_json" | "scope_json",
) {
  const rows = store.db
    .prepare(`SELECT id, ${column} AS scopeJson FROM ${table} ORDER BY id`)
    .all() as Array<{ id: string; scopeJson: string }>;
  return rows.map((row) => ({ id: row.id, scope: JSON.parse(row.scopeJson) }));
}
