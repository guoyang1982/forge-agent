import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "./index.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const roots: string[] = [];
const openStores: ForgeStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function openMigratedFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-company-delivery-"));
  roots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  openStores.push(store);
  return { db: store.db };
}

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .pluck()
    .all() as string[];
}

function tableSql(db: Database.Database, name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { sql: string } | undefined;
  return row?.sql ?? "";
}

function indexSql(db: Database.Database, name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) as { sql: string } | undefined;
  return row?.sql ?? "";
}

function seedCompanyWorkItem(db: Database.Database) {
  db.prepare(
    "INSERT INTO company_companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run("company-1", "Forge One", "2026-09-09", "2026-09-09");
  db.prepare(
    "INSERT INTO company_employees (id, company_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("employee-1", "company-1", "Owner", "2026-09-09", "2026-09-09");
  db.prepare(
    `INSERT INTO company_work_items (
      id, company_id, type, title, problem, expected_outcome, owner_id,
      state, risk, autonomy_level, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "work-1",
    "company-1",
    "implementation",
    "Research intake",
    "Problem unclear",
    "Brief exists",
    "employee-1",
    "draft",
    "low",
    2,
    "2026-09-09",
    "2026-09-09",
  );
}

describe("Company delivery migrations", () => {
  it("creates delivery loop tables with explicit claim classes", () => {
    const { db } = openMigratedFixture();
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        "company_research_briefs",
        "company_research_questions",
        "company_research_claims",
        "company_stage_gates",
        "company_release_candidates",
        "company_feedback_items",
      ]),
    );
    expect(tableSql(db, "company_research_claims")).toContain(
      "'fact','inference','hypothesis','unknown'",
    );
    expect(tableSql(db, "company_stage_gates")).toContain(
      "impact TEXT NOT NULL DEFAULT ''",
    );
    expect(indexSql(db, "idx_company_stage_gates_lookup")).toContain(
      "company_stage_gates(company_id, project_id, gate_kind, decided_at)",
    );
  });

  it("rejects cross-company research brief references", () => {
    const { db } = openMigratedFixture();
    seedCompanyWorkItem(db);
    db.prepare(
      "INSERT INTO company_companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("company-2", "Forge Two", "2026-09-09", "2026-09-09");

    expect(() =>
      db
        .prepare(
          `INSERT INTO company_research_briefs (
            id, company_id, work_item_id, version, normalized_problem,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "brief-cross-company",
          "company-2",
          "work-1",
          1,
          "Mismatch",
          "2026-09-09",
          "2026-09-09",
        ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("allows stage gates without a project", () => {
    const { db } = openMigratedFixture();
    seedCompanyWorkItem(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO company_stage_gates (
            id, company_id, project_id, gate_kind, outcome,
            input_version_refs_json, decision_json, impact, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "gate-research-only",
          "company-1",
          null,
          "research",
          "stopped",
          '["brief:work-1:1"]',
          '{"decidedBy":{"kind":"employee","id":"employee-1"},"rationale":"Research complete"}',
          "No project scope yet",
          "2026-09-09",
        ),
    ).not.toThrow();
  });

  it("rejects invalid research claim classifications", () => {
    const { db } = openMigratedFixture();
    seedCompanyWorkItem(db);
    db.prepare(
      `INSERT INTO company_research_briefs (
        id, company_id, work_item_id, version, normalized_problem,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("brief-1", "company-1", "work-1", 1, "Problem", "2026-09-09", "2026-09-09");

    expect(() =>
      db
        .prepare(
          `INSERT INTO company_research_claims (
            id, company_id, brief_id, text, classification,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "claim-invalid",
          "company-1",
          "brief-1",
          "Unverified guess",
          "speculation",
          "2026-09-09",
          "2026-09-09",
        ),
    ).toThrow(/CHECK constraint failed/);
  });
});
