import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompanyService,
  OrganizationService,
  WorkService,
} from "./index.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];
const stores: ForgeStore[] = [];
const clock = {
  now: () => "2026-09-09T00:00:00.000Z",
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WorkService", () => {
  it("writes intent.md after creating a work item when artifactRoot is set", () => {
    const { company, employee, work, artifactRoot } = openFixture({
      artifactRoot: true,
    });

    const item = work.createWorkItem({
      companyId: company.id,
      type: "implementation",
      title: "团队版窗格最大化",
      problem: "给 SSH 客户端出团队版：窗格一键最大化",
      expectedOutcome: "可一键最大化窗格",
      ownerId: employee.id,
    });

    const intent = work
      .listArtifacts(item.id)
      .find((artifact) => artifact.kind === "intent");
    const relative = `${company.id}/work/${item.id}/intent.md`;
    expect(intent?.workspacePath).toBe(relative);
    expect(
      readFileSync(
        join(artifactRoot, company.id, "work", item.id, "intent.md"),
        "utf8",
      ),
    ).toBe(item.problem);
    expect(
      readFileSync(
        join(artifactRoot, company.id, "work", item.id, "spec.md"),
        "utf8",
      ),
    ).toContain(item.expectedOutcome);
    expect(
      readFileSync(
        join(artifactRoot, company.id, "work", item.id, "plan.md"),
        "utf8",
      ),
    ).toContain("实施计划");
  });

  it("does not write files when artifactRoot is omitted", () => {
    const { company, employee, work, artifactRoot } = openFixture();

    work.createWorkItem({
      companyId: company.id,
      type: "implementation",
      title: "t",
      problem: "p",
      expectedOutcome: "o",
      ownerId: employee.id,
    });

    expect(existsSync(join(artifactRoot, company.id))).toBe(false);
  });

  it("registers a demand as a draft work item with intent artifact", () => {
    const { company, employee, work } = openFixture();

    const item = work.createWorkItem({
      companyId: company.id,
      type: "implementation",
      title: "团队版窗格最大化",
      problem: "给 SSH 客户端出团队版：窗格一键最大化",
      expectedOutcome: "可一键最大化窗格",
      ownerId: employee.id,
    });

    expect(item.state).toBe("draft");
    expect(item.risk).toBe("low");
    expect(item.autonomyLevel).toBe(2);
    const artifacts = work.listArtifacts(item.id);
    const intent = artifacts.find((artifact) => artifact.kind === "intent");
    const spec = artifacts.find((artifact) => artifact.kind === "spec");
    const plan = artifacts.find((artifact) => artifact.kind === "plan");
    expect(intent?.status).toBe("draft");
    expect(intent?.content).toContain("一键最大化");
    expect(spec?.status).toBe("draft");
    expect(spec?.content).toContain(item.expectedOutcome);
    expect(plan?.status).toBe("draft");
    expect(plan?.content).toContain(item.title);
    expect(intent?.contentHash).toBe(
      createHash("sha256").update(item.problem, "utf8").digest("hex"),
    );
  });

  it("creates a project under an existing goal", () => {
    const { company, employee, work } = openFixture();

    const goal = work.createGoal({
      companyId: company.id,
      title: "提升团队版体验",
      ownerId: employee.id,
    });
    const project = work.createProject({
      companyId: company.id,
      goalId: goal.id,
      title: "SSH 团队版",
    });

    expect(goal).toMatchObject({
      companyId: company.id,
      title: "提升团队版体验",
      ownerId: employee.id,
      version: 1,
    });
    expect(project).toMatchObject({
      companyId: company.id,
      goalId: goal.id,
      title: "SSH 团队版",
      version: 1,
    });
  });

  it("hangs a work item on a project and inherits the goal", () => {
    const { company, employee, work } = openFixture();
    const goal = work.createGoal({
      companyId: company.id,
      title: "提升团队版体验",
      ownerId: employee.id,
    });
    const project = work.createProject({
      companyId: company.id,
      goalId: goal.id,
      title: "SSH 团队版",
    });

    const item = work.createWorkItem({
      companyId: company.id,
      projectId: project.id,
      type: "implementation",
      title: "窗格最大化",
      problem: "一键最大化",
      expectedOutcome: "可最大化",
      ownerId: employee.id,
    });

    expect(item.projectId).toBe(project.id);
    expect(item.goalId).toBe(goal.id);
    expect(() =>
      work.createWorkItem({
        companyId: company.id,
        projectId: "project_missing",
        type: "implementation",
        title: "x",
        problem: "p",
        expectedOutcome: "o",
        ownerId: employee.id,
      }),
    ).toThrow(/project not found/);
    expect(() =>
      work.createProject({
        companyId: company.id,
        goalId: "goal_missing",
        title: "孤儿项目",
      }),
    ).toThrow(/goal not found/);
  });
});

function openFixture(options?: { artifactRoot?: boolean }): {
  company: ReturnType<CompanyService["create"]>;
  employee: ReturnType<OrganizationService["hire"]>;
  work: WorkService;
  artifactRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "forge-company-domain-"));
  const artifactRoot = join(root, "company");
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
  const department = org.createDepartment({
    companyId: company.id,
    name: "产品部",
  });
  const template = org.createPositionTemplate({
    companyId: company.id,
    name: "Product Director",
    charter: "范围建议权，无发布权",
  });
  const position = org.createPosition({
    companyId: company.id,
    departmentId: department.id,
    templateId: template.id,
    title: "产品总监",
  });
  const employee = org.hire({
    companyId: company.id,
    displayName: "方夏",
    positionId: position.id,
    autonomyLevel: 2,
  });

  return {
    company,
    employee,
    work: new WorkService(
      store.db,
      clock,
      options?.artifactRoot ? { artifactRoot } : undefined,
    ),
    artifactRoot,
  };
}
