import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "./index.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openMigrated() {
  const root = mkdtempSync(join(tmpdir(), "forge-company-p0-"));
  roots.push(root);
  return ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
}

const workItemStates = [
  "draft",
  "ready",
  "in_progress",
  "waiting_input",
  "waiting_approval",
  "blocked",
  "submitted",
  "verifying",
  "accepted",
  "rejected",
  "completed",
  "cancelled",
] as const;

describe("Company P0 migrations", () => {
  it("creates company org work and artifact tables", () => {
    const store = openMigrated();
    try {
      const names = store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'company_%' ORDER BY name",
        )
        .pluck()
        .all();
      expect(names).toEqual(
        expect.arrayContaining([
          "company_companies",
          "company_departments",
          "company_position_templates",
          "company_positions",
          "company_employees",
          "company_employments",
          "company_reporting_lines",
          "company_goals",
          "company_projects",
          "company_project_teams",
          "company_work_items",
          "company_work_dependencies",
          "company_handoffs",
          "company_work_artifacts",
          "company_decisions",
          "company_run_links",
        ]),
      );
    } finally {
      store.close();
    }
  });

  it("rejects cross-company work artifact references", () => {
    const store = openMigrated();
    try {
      const insertCompany = store.db.prepare(
        "INSERT INTO company_companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      );
      insertCompany.run("company-1", "Forge One", "2026-09-09", "2026-09-09");
      insertCompany.run("company-2", "Forge Two", "2026-09-09", "2026-09-09");
      store.db
        .prepare(
          "INSERT INTO company_employees (id, company_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("employee-1", "company-1", "Owner", "2026-09-09", "2026-09-09");
      store.db
        .prepare(
          `INSERT INTO company_work_items (
            id, company_id, type, title, problem, expected_outcome, owner_id,
            state, risk, autonomy_level, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "work-1",
          "company-1",
          "implementation",
          "Build schema",
          "Schema missing",
          "Schema exists",
          "employee-1",
          "draft",
          "low",
          2,
          "2026-09-09",
          "2026-09-09",
        );

      expect(() =>
        store.db
          .prepare(
            `INSERT INTO company_work_artifacts (
              id, company_id, work_item_id, kind, version, status, content,
              content_hash, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "artifact-cross-company",
            "company-2",
            "work-1",
            "plan",
            1,
            "draft",
            "{}",
            "hash-cross-company",
            "2026-09-09",
            "2026-09-09",
          ),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      store.close();
    }
  });

  it("enforces unique work artifact versions", () => {
    const store = openMigrated();
    try {
      store.db
        .prepare(
          "INSERT INTO company_companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("company-1", "Forge", "2026-09-09", "2026-09-09");
      store.db
        .prepare(
          "INSERT INTO company_employees (id, company_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("employee-1", "company-1", "Owner", "2026-09-09", "2026-09-09");
      store.db
        .prepare(
          `INSERT INTO company_work_items (
            id, company_id, type, title, problem, expected_outcome, owner_id,
            state, risk, autonomy_level, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "work-1",
          "company-1",
          "implementation",
          "Build schema",
          "Schema missing",
          "Schema exists",
          "employee-1",
          "draft",
          "low",
          2,
          "2026-09-09",
          "2026-09-09",
        );

      const insertArtifact = store.db.prepare(
        `INSERT INTO company_work_artifacts (
          id, company_id, work_item_id, kind, version, status, content,
          content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertArtifact.run(
        "artifact-1",
        "company-1",
        "work-1",
        "plan",
        1,
        "draft",
        "{}",
        "hash-1",
        "2026-09-09",
        "2026-09-09",
      );

      expect(() =>
        insertArtifact.run(
          "artifact-2",
          "company-1",
          "work-1",
          "plan",
          1,
          "draft",
          "{}",
          "hash-2",
          "2026-09-09",
          "2026-09-09",
        ),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      store.close();
    }
  });

  it("accepts exactly the WorkItemState values", () => {
    const store = openMigrated();
    try {
      store.db
        .prepare(
          "INSERT INTO company_companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("company-1", "Forge", "2026-09-09", "2026-09-09");
      store.db
        .prepare(
          "INSERT INTO company_employees (id, company_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("employee-1", "company-1", "Owner", "2026-09-09", "2026-09-09");
      const insertWorkItem = store.db.prepare(
        `INSERT INTO company_work_items (
          id, company_id, type, title, problem, expected_outcome, owner_id,
          state, risk, autonomy_level, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const state of workItemStates) {
        expect(() =>
          insertWorkItem.run(
            `work-${state}`,
            "company-1",
            "implementation",
            "Build schema",
            "Schema missing",
            "Schema exists",
            "employee-1",
            state,
            "low",
            2,
            "2026-09-09",
            "2026-09-09",
          ),
        ).not.toThrow();
      }
      expect(() =>
        insertWorkItem.run(
          "work-invalid",
          "company-1",
          "implementation",
          "Build schema",
          "Schema missing",
          "Schema exists",
          "employee-1",
          "unknown",
          "low",
          2,
          "2026-09-09",
          "2026-09-09",
        ),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      store.close();
    }
  });
});
