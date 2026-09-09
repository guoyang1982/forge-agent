import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyService } from "./company-service.js";
import { OrganizationService } from "./organization-service.js";
import { WorkGates } from "./work-gates.js";
import { WorkService } from "./work-service.js";

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

describe("WorkGates", () => {
  it("rejects dispatch without an accepted spec", () => {
    const { gates, item, employee } = openFixture();

    expect(() =>
      gates.dispatch({
        workItemId: item.id,
        assigneeId: employee.id,
        actorId: employee.id,
      }),
    ).toThrow(/spec not accepted/);
  });

  it("does not mutate an accepted spec", () => {
    const { gates, item, employee } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });

    const v2 = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化 + 徽章",
      actorId: employee.id,
    });

    expect(v2.version).toBe(spec.version + 1);
    expect(gates.getArtifact(spec.id).status).toBe("accepted");
    expect(gates.getArtifact(spec.id).content).toBe("范围：最大化");
  });

  it("rejects implementation run without accepted plan", () => {
    const { gates, item, employee } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });

    expect(() => gates.assertImplementationRunAllowed(item.id)).toThrow(
      /plan not accepted/,
    );
  });
});

function openFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-work-gates-"));
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
  const work = new WorkService(store.db, clock);
  const item = work.createWorkItem({
    companyId: company.id,
    type: "implementation",
    title: "团队版窗格最大化",
    problem: "给 SSH 客户端出团队版：窗格一键最大化",
    expectedOutcome: "可一键最大化窗格",
    ownerId: employee.id,
  });

  return {
    employee,
    gates: new WorkGates(store.db, clock),
    item,
  };
}
