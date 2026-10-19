import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompanyService,
  OrganizationService,
  WorkService,
  acceptBrief,
  assessIntake,
  type IntakeInput,
} from "../index.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];
const stores: ForgeStore[] = [];
const clock = {
  now: () => "2026-09-11T00:00:00.000Z",
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function validIntake(): IntakeInput {
  return {
    problem: "  转化低  ",
    targetUser: "SMB 运营",
    expectedOutcome: "注册到付费转化率提升 10%",
    constraints: ["must ship in Q4"],
  };
}

describe("assessIntake", () => {
  it("creates a ready brief when problem user and outcome are present", () => {
    expect(assessIntake(validIntake())).toMatchObject({
      ready: true,
      missingFields: [],
    });
  });

  it("asks only for material missing fields", () => {
    expect(
      assessIntake({ problem: "转化低", targetUser: "", expectedOutcome: "" }),
    ).toMatchObject({
      ready: false,
      missingFields: ["targetUser", "expectedOutcome"],
    });
  });

  it("treats whitespace-only required fields as missing", () => {
    expect(
      assessIntake({
        problem: "   ",
        targetUser: "ops",
        expectedOutcome: "outcome",
      }),
    ).toMatchObject({
      ready: false,
      missingFields: ["problem"],
    });
  });

  it("normalizes problem whitespace", () => {
    expect(assessIntake(validIntake()).normalizedProblem).toBe("转化低");
  });

  it("throws when any required string exceeds 4000 characters", () => {
    const huge = "x".repeat(4001);
    expect(() =>
      assessIntake({
        problem: huge,
        targetUser: "user",
        expectedOutcome: "outcome",
      }),
    ).toThrow(/intake too large/i);
  });

  it("marks conflicting must / must-not constraints as not ready", () => {
    const result = assessIntake({
      problem: "转化低",
      targetUser: "SMB",
      expectedOutcome: "提升转化",
      constraints: ["must use React", "must not use React"],
    });
    expect(result.ready).toBe(false);
    expect(result.researchQuestions.some((q) => /conflict/i.test(q))).toBe(true);
  });

  it("includes suggested stop conditions when ready", () => {
    const result = assessIntake(validIntake());
    expect(result.suggestedStopConditions.length).toBeGreaterThan(0);
  });
});

describe("acceptBrief", () => {
  it("persists a versioned research brief for a work item", () => {
    const { db, company, workItem } = openWorkItemFixture();

    const first = acceptBrief(db, clock, {
      companyId: company.id,
      workItemId: workItem.id,
      ...validIntake(),
    });
    const second = acceptBrief(db, clock, {
      companyId: company.id,
      workItemId: workItem.id,
      ...validIntake(),
      expectedOutcome: "转化率提升 15%",
    });

    expect(first).toMatchObject({
      companyId: company.id,
      workItemId: workItem.id,
      version: 1,
      ready: true,
      normalizedProblem: "转化低",
    });
    expect(second.version).toBe(2);
    expect(second.expectedOutcome).toBe("转化率提升 15%");

    const rows = db
      .prepare(
        `SELECT version, ready FROM company_research_briefs
         WHERE company_id = ? AND work_item_id = ? ORDER BY version`,
      )
      .all(company.id, workItem.id) as Array<{ version: number; ready: number }>;
    expect(rows).toEqual([
      { version: 1, ready: 1 },
      { version: 2, ready: 1 },
    ]);
  });

  it("stores ready as 0 when intake is incomplete", () => {
    const { db, company, workItem } = openWorkItemFixture();

    const brief = acceptBrief(db, clock, {
      companyId: company.id,
      workItemId: workItem.id,
      problem: "转化低",
      targetUser: "",
      expectedOutcome: "",
    });

    expect(brief.ready).toBe(false);
    const row = db
      .prepare(
        "SELECT ready FROM company_research_briefs WHERE id = ? AND company_id = ?",
      )
      .get(brief.id, company.id) as { ready: number };
    expect(row.ready).toBe(0);
  });
});

function openWorkItemFixture(): {
  db: Database.Database;
  company: ReturnType<CompanyService["create"]>;
  workItem: ReturnType<WorkService["createWorkItem"]>;
} {
  const root = mkdtempSync(join(tmpdir(), "forge-intake-"));
  fixtureRoots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);

  const companies = new CompanyService(store.db, clock);
  const org = new OrganizationService(store.db, clock);
  const work = new WorkService(store.db, clock);
  const company = companies.create({ name: "曜石" });
  const department = org.createDepartment({
    companyId: company.id,
    name: "产品部",
  });
  const template = org.createPositionTemplate({
    companyId: company.id,
    name: "Product Director",
    charter: "范围建议权",
  });
  const position = org.createPosition({
    companyId: company.id,
    departmentId: department.id,
    templateId: template.id,
    title: "产品总监",
  });
  const employee = org.hire({
    companyId: company.id,
    displayName: "Alex",
    positionId: position.id,
    autonomyLevel: 2,
  });
  const workItem = work.createWorkItem({
    companyId: company.id,
    type: "research",
    title: "Intake",
    problem: "placeholder",
    expectedOutcome: "brief",
    ownerId: employee.id,
  });

  return { db: store.db, company, workItem };
}
