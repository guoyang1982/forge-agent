import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompanyService,
  OrganizationService,
  WorkService,
  bindCompanyBudgetAccount,
  bindProjectWorkspaceGroup,
} from "@forge/company-domain";
import { ForgeStore } from "@forge/store";
import { WorkspaceGroupService } from "@forge/workspace";
import { createRequirementResearchWorkflow } from "@forge/workflows";
import { buildCompanyResearchStepGovernance } from "./company-workflow-governance.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const clock = { now: () => "2026-09-11T12:00:00.000Z" };
const BRANCHES = ["user-research", "market-research", "code-data-research", "risk-research"];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface FixtureOptions {
  missingProfile?: boolean;
  missingVersion?: boolean;
  writeGrant?: boolean;
  noBudget?: boolean;
  noGrant?: boolean;
  inactive?: boolean;
  group?: boolean;
}

function researchGovFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-research-gov-"));
  const store = ForgeStore.open({ dbPath: join(root, "data.db"), migrationsDir, owner: "test" });
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companies = new CompanyService(store.db, clock);
  const org = new OrganizationService(store.db, clock);
  const work = new WorkService(store.db, clock);
  const groups = new WorkspaceGroupService(store.db);
  const company = companies.create({ name: "曜石" });

  const department = org.createDepartment({ companyId: company.id, name: "研究部" });
  const template = org.createPositionTemplate({ companyId: company.id, name: "研究员", charter: "research" });
  const position = org.createPosition({
    companyId: company.id,
    departmentId: department.id,
    templateId: template.id,
    title: "研究员",
  });
  const employee = org.hire({
    companyId: company.id,
    displayName: "研究员甲",
    positionId: position.id,
    autonomyLevel: 2,
  });

  const wsPath = join(root, "ws-a");
  const otherPath = join(root, "ws-b");
  mkdirSync(wsPath);
  mkdirSync(otherPath);
  groups.registerWorkspace({ id: "ws-a", rootPath: wsPath });
  groups.registerWorkspace({ id: "ws-b", rootPath: otherPath });
  org.bindCapability({
    companyId: company.id,
    employeeId: employee.id,
    talentTemplateId: "tpl",
    talentRole: "researcher",
    skills: [],
    tools: [],
    ...(options.missingProfile ? {} : { agentProfileId: "profile-1" }),
    ...(options.missingProfile || options.missingVersion
      ? {}
      : { agentProfileVersionId: "profile-1-v3" }),
    workspaces: options.noGrant
      ? []
      : [
          { workspaceId: "ws-b", mode: "write", isDefault: false },
          { workspaceId: "ws-a", mode: options.writeGrant ? "write" : "read", isDefault: true },
        ],
  });
  if (options.inactive) {
    store.db
      .prepare(`UPDATE company_employments SET status = 'inactive' WHERE employee_id = ?`)
      .run(employee.id);
  }
  const goal = work.createGoal({ companyId: company.id, title: "G", ownerId: employee.id });
  const project = work.createProject({ companyId: company.id, goalId: goal.id, title: "P" });
  if (!options.noBudget) {
    bindCompanyBudgetAccount(store.db, {
      companyId: company.id,
      accountId: "acct-1",
      createdAt: clock.now(),
    });
  }
  if (options.group) {
    const group = groups.createGroup({ name: "proj" });
    groups.bindWorkspace({
      groupId: group.id,
      workspaceId: "ws-b",
      rootPath: otherPath,
      mode: "write",
    });
    bindProjectWorkspaceGroup(store.db, {
      companyId: company.id,
      projectId: project.id,
      groupId: group.id,
      createdAt: clock.now(),
    });
  }
  const briefId = "brief-1";
  const definition = createRequirementResearchWorkflow({ briefId });
  const assignments = Object.fromEntries(definition.steps.map((step) => [step.id, employee.id]));
  return {
    db: store.db,
    companyId: company.id,
    projectId: project.id,
    briefId,
    definition,
    assignments,
    employeeId: employee.id,
    wsPath,
    otherPath,
  };
}

function build(fx: ReturnType<typeof researchGovFixture>, extra: { budgetAmountMinor?: number } = {}) {
  return buildCompanyResearchStepGovernance({
    db: fx.db,
    companyId: fx.companyId,
    projectId: fx.projectId,
    definition: fx.definition,
    assignments: fx.assignments,
    ...extra,
  });
}

describe("buildCompanyResearchStepGovernance", () => {
  it("forces every research branch workspace to read mode", () => {
    const fx = researchGovFixture({ writeGrant: true });
    const gov = build(fx);
    for (const id of BRANCHES) expect(gov[id]!.workspace.mode).toBe("read");
    for (const step of fx.definition.steps) expect(gov[step.id]!.workspace.mode).toBe("read");
  });

  it("returns profile, workspace, resource and budget for each step", () => {
    const fx = researchGovFixture();
    const gov = build(fx, { budgetAmountMinor: 25 });
    expect(Object.keys(gov).sort()).toEqual(fx.definition.steps.map((s) => s.id).sort());
    expect(gov["user-research"]).toEqual({
      profileId: "profile-1",
      profileVersionId: "profile-1-v3",
      action: "agent.run",
      resource: { kind: "workspace", id: "ws-a" },
      risk: "low",
      workspace: { id: "ws-a", rootPath: fx.wsPath, mode: "read" },
      budget: { accountId: "acct-1", amountMinor: 25 },
    });
    expect(gov.synthesis!.workspace).toEqual(gov["user-research"]!.workspace);
    expect(gov["research-gate"]!.workspace.mode).toBe("read");
  });

  it("defaults budget amount to 50000 minor units", () => {
    const gov = build(researchGovFixture());
    expect(gov["user-research"]!.budget.amountMinor).toBe(50_000);
  });

  it("prefers a grant inside the project workspace group", () => {
    const fx = researchGovFixture({ group: true });
    const gov = build(fx);
    expect(gov["user-research"]!.workspace).toEqual({ id: "ws-b", rootPath: fx.otherPath, mode: "read" });
  });

  it("rejects missing agent profile on assignee", () => {
    const fx = researchGovFixture({ missingProfile: true });
    expect(() => build(fx)).toThrow(/profile/);
  });

  it("rejects an assignee with a profile but no published version", () => {
    expect(() => build(researchGovFixture({ missingVersion: true }))).toThrow(/profile/);
  });

  it("rejects inactive employment", () => {
    expect(() => build(researchGovFixture({ inactive: true }))).toThrow(/active/);
  });

  it("rejects missing company budget account", () => {
    expect(() => build(researchGovFixture({ noBudget: true }))).toThrow(/budget/);
  });

  it("rejects an assignee without any workspace grant", () => {
    expect(() => build(researchGovFixture({ noGrant: true }))).toThrow(/workspace/);
  });

  it("rejects steps without an assignment and unknown employees", () => {
    const fx = researchGovFixture();
    const { synthesis: _omitted, ...rest } = fx.assignments;
    expect(() => build({ ...fx, assignments: rest })).toThrow(/synthesis/);
    expect(() => build({ ...fx, assignments: { ...fx.assignments, synthesis: "emp_nope" } })).toThrow(/employee/);
  });

  it("rejects a project outside the company", () => {
    const fx = researchGovFixture();
    expect(() => build({ ...fx, projectId: "project_nope" })).toThrow(/project/);
  });

  it("rejects invalid budget amounts", () => {
    const fx = researchGovFixture();
    expect(() => build(fx, { budgetAmountMinor: 0 })).toThrow(/budget/);
    expect(() => build(fx, { budgetAmountMinor: 1.5 })).toThrow(/budget/);
  });
});
