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
  createDeliveryProject,
  getProjectWorkspaceGroupId,
  type CreateDeliveryProjectInput,
  type Employee,
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

describe("createDeliveryProject", () => {
  it("requires an independent validation owner", () => {
    const fixture = openFixture();
    const input = validDeliveryProjectInput(fixture);
    input.assignments = input.assignments.filter(
      (assignment) => assignment.responsibility !== "validation",
    );

    expect(() => createDeliveryProject(fixture.db, clock, input)).toThrow(
      "independent validation owner required",
    );
  });

  it("requires product architecture and implementation owners", () => {
    const fixture = openFixture();

    for (const [responsibility, message] of [
      ["product", "product owner required"],
      ["architecture", "architecture owner required"],
      ["implementation", "implementation owner required"],
    ] as const) {
      const input = validDeliveryProjectInput(fixture);
      input.assignments = input.assignments.filter(
        (assignment) => assignment.responsibility !== responsibility,
      );
      expect(() => createDeliveryProject(fixture.db, clock, input)).toThrow(message);
    }
  });

  it("rejects an implementation owner acting as validator", () => {
    const fixture = openFixture();
    const input = validDeliveryProjectInput(fixture);
    const implementation = input.assignments.find(
      (assignment) => assignment.responsibility === "implementation",
    )!;
    const validation = input.assignments.find(
      (assignment) => assignment.responsibility === "validation",
    )!;
    validation.employeeId = implementation.employeeId;

    expect(() => createDeliveryProject(fixture.db, clock, input)).toThrow(
      "independent validation owner required",
    );
  });

  it("requires every implementation stream to have a workspace binding", () => {
    const fixture = openFixture();
    const input = validDeliveryProjectInput(fixture);
    const implementation = input.assignments.find(
      (assignment) => assignment.responsibility === "implementation",
    )!;
    implementation.workspaceBindingId = " ";

    expect(() => createDeliveryProject(fixture.db, clock, input)).toThrow(
      /workspace binding required/i,
    );
  });

  it("makes research read-only and only implementation writable", () => {
    const fixture = openFixture();
    const project = createDeliveryProject(
      fixture.db,
      clock,
      validDeliveryProjectInput(fixture),
    );

    expect(
      project.assignments.map(({ responsibility, accessMode }) => ({
        responsibility,
        accessMode,
      })),
    ).toEqual([
      { responsibility: "product", accessMode: "read" },
      { responsibility: "architecture", accessMode: "read" },
      { responsibility: "research", accessMode: "read" },
      { responsibility: "implementation", accessMode: "write" },
      { responsibility: "implementation", accessMode: "write" },
      { responsibility: "validation", accessMode: "read" },
    ]);
  });

  it("rejects employees from another company", () => {
    const fixture = openFixture();
    const otherEmployee = hireEmployees(
      fixture.companies,
      fixture.org,
      "另一家公司",
      ["Outsider"],
    ).employees[0]!;
    const input = validDeliveryProjectInput(fixture);
    input.assignments[0]!.employeeId = otherEmployee.id;

    expect(() => createDeliveryProject(fixture.db, clock, input)).toThrow(
      /employee does not belong to company/i,
    );
  });

  it("rejects two implementation streams writing the same workspace", () => {
    const fixture = openFixture();
    const input = validDeliveryProjectInput(fixture);
    const implementations = input.assignments.filter(
      (assignment) => assignment.responsibility === "implementation",
    );
    implementations[1]!.workspaceBindingId =
      implementations[0]!.workspaceBindingId;

    expect(() => createDeliveryProject(fixture.db, clock, input)).toThrow(
      /workspace binding conflict/i,
    );
  });

  it("creates assignment work items and binds the workspace group", () => {
    const fixture = openFixture();
    const input = validDeliveryProjectInput(fixture);

    const project = createDeliveryProject(fixture.db, clock, input);

    expect(project).toMatchObject({
      companyId: fixture.companyId,
      projectId: fixture.projectId,
      groupId: "group-delivery",
      milestones: ["scope-approved", "integrated-validation"],
    });
    expect(project.assignments).toHaveLength(input.assignments.length);
    expect(
      project.assignments.every(
        (assignment) =>
          assignment.workspaceBindingId && assignment.workItemId,
      ),
    ).toBe(true);
    expect(getProjectWorkspaceGroupId(fixture.db, fixture.projectId)).toBe(
      "group-delivery",
    );

    const workItems = fixture.db
      .prepare(
        `SELECT id, project_id AS projectId, type
         FROM company_work_items
         WHERE company_id = ? AND project_id = ?`,
      )
      .all(fixture.companyId, fixture.projectId) as Array<{
      id: string;
      projectId: string;
      type: string;
    }>;
    expect(workItems).toHaveLength(input.assignments.length);
    const workItemTypes = new Map(
      workItems.map((item) => [item.id, item.type]),
    );
    expect(
      project.assignments.map((assignment) =>
        workItemTypes.get(assignment.workItemId),
      ),
    ).toEqual(["intent", "intent", "research", "implementation", "implementation", "intent"]);
  });
});

type Fixture = {
  db: Database.Database;
  companies: CompanyService;
  org: OrganizationService;
  companyId: string;
  projectId: string;
  employees: Record<string, Employee>;
};

function openFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "forge-delivery-project-"));
  fixtureRoots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);

  const companies = new CompanyService(store.db, clock);
  const org = new OrganizationService(store.db, clock);
  const hired = hireEmployees(companies, org, "曜石", [
    "Product",
    "Architect",
    "Researcher",
    "Frontend",
    "Backend",
    "Validator",
  ]);
  const work = new WorkService(store.db, clock);
  const goal = work.createGoal({
    companyId: hired.companyId,
    title: "提升交付质量",
    ownerId: hired.employees[0]!.id,
  });
  const project = work.createProject({
    companyId: hired.companyId,
    goalId: goal.id,
    title: "交付工作台",
  });

  return {
    db: store.db,
    companies,
    org,
    companyId: hired.companyId,
    projectId: project.id,
    employees: Object.fromEntries(
      hired.employees.map((employee) => [employee.displayName, employee]),
    ),
  };
}

function hireEmployees(
  companies: CompanyService,
  org: OrganizationService,
  companyName: string,
  names: string[],
): { companyId: string; employees: Employee[] } {
  const company = companies.create({ name: companyName });
  const department = org.createDepartment({
    companyId: company.id,
    name: "交付部",
  });
  const template = org.createPositionTemplate({
    companyId: company.id,
    name: "Delivery",
    charter: "交付职责",
  });
  const employees = names.map((name) => {
    const position = org.createPosition({
      companyId: company.id,
      departmentId: department.id,
      templateId: template.id,
      title: name,
    });
    return org.hire({
      companyId: company.id,
      displayName: name,
      positionId: position.id,
      autonomyLevel: 2,
    });
  });
  return { companyId: company.id, employees };
}

function validDeliveryProjectInput(fixture: Fixture): CreateDeliveryProjectInput {
  return {
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    groupId: "group-delivery",
    approvedScope: {
      title: "交付工作台",
      problem: "需求到交付缺少闭环",
      expectedOutcome: "建立可验证交付闭环",
    },
    milestones: ["scope-approved", "integrated-validation"],
    assignments: [
      {
        employeeId: fixture.employees.Product!.id,
        responsibility: "product",
        workspaceBindingId: "workspace:product",
      },
      {
        employeeId: fixture.employees.Architect!.id,
        responsibility: "architecture",
        workspaceBindingId: "workspace:architecture",
      },
      {
        employeeId: fixture.employees.Researcher!.id,
        responsibility: "research",
        workspaceBindingId: "workspace:research",
      },
      {
        employeeId: fixture.employees.Frontend!.id,
        responsibility: "implementation",
        workspaceBindingId: "workspace:frontend",
      },
      {
        employeeId: fixture.employees.Backend!.id,
        responsibility: "implementation",
        workspaceBindingId: "workspace:backend",
      },
      {
        employeeId: fixture.employees.Validator!.id,
        responsibility: "validation",
        workspaceBindingId: "workspace:validation",
      },
    ],
  };
}
