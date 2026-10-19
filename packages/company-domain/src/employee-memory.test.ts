import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyService } from "./company-service.js";
import {
  recallEmployeeMemories,
  rememberEmployeeMemory,
} from "./employee-memory.js";
import { OrganizationService } from "./organization-service.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];
const stores: ForgeStore[] = [];
const clock = { now: () => "2026-09-11T04:00:00.000Z" };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("employee memory", () => {
  it("recalls only the notes hung on that employee", () => {
    const { db, companyId, assignee, reviewer } = openEmployees();
    rememberEmployeeMemory(db, clock, {
      companyId,
      employeeId: assignee.id,
      kind: "gate",
      content: "驳回：还原比例仍错",
      evidenceRefs: ["validation_1"],
      sourceWorkItemId: "work_1",
    });
    rememberEmployeeMemory(db, clock, {
      companyId,
      employeeId: reviewer.id,
      kind: "lesson",
      content: "验收时先看移动端还原",
    });

    expect(recallEmployeeMemories(db, companyId, assignee.id)).toEqual([
      expect.objectContaining({
        employeeId: assignee.id,
        kind: "gate",
        content: "驳回：还原比例仍错",
        evidenceRefs: ["validation_1"],
        sourceWorkItemId: "work_1",
      }),
    ]);
    expect(recallEmployeeMemories(db, companyId, reviewer.id).map((row) => row.content))
      .toEqual(["验收时先看移动端还原"]);
  });
});

function openEmployees() {
  const root = mkdtempSync(join(tmpdir(), "forge-emp-mem-"));
  fixtureRoots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);
  const companies = new CompanyService(store.db, clock);
  const org = new OrganizationService(store.db, clock);
  const company = companies.create({ name: "曜石" });
  const department = org.createDepartment({ companyId: company.id, name: "研发" });
  const template = org.createPositionTemplate({
    companyId: company.id,
    name: "Engineer",
    charter: "实现",
  });
  const engineer = org.createPosition({
    companyId: company.id,
    departmentId: department.id,
    templateId: template.id,
    title: "执行工程师",
  });
  const quality = org.createPosition({
    companyId: company.id,
    departmentId: department.id,
    templateId: template.id,
    title: "质量负责人",
  });
  const assignee = org.hire({
    companyId: company.id,
    displayName: "苏衡",
    positionId: engineer.id,
    autonomyLevel: 2,
  });
  const reviewer = org.hire({
    companyId: company.id,
    displayName: "沈清",
    positionId: quality.id,
    autonomyLevel: 2,
  });
  return { db: store.db, companyId: company.id, assignee, reviewer };
}
