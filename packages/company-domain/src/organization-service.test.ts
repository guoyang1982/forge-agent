import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyService, OrganizationService } from "./index.js";

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

describe("OrganizationService", () => {
  it("hires an employee onto a position in a department", () => {
    const { companies, org } = openServices();
    const company = companies.create({ name: "曜石" });
    const dept = org.createDepartment({ companyId: company.id, name: "产品部" });
    const tmpl = org.createPositionTemplate({
      companyId: company.id,
      name: "Product Director",
      charter: "范围建议权，无发布权",
    });
    const pos = org.createPosition({
      companyId: company.id,
      departmentId: dept.id,
      templateId: tmpl.id,
      title: "产品总监",
    });
    const emp = org.hire({
      companyId: company.id,
      displayName: "方夏",
      positionId: pos.id,
      autonomyLevel: 2,
    });
    expect(org.tree(company.id).employees[0].id).toBe(emp.id);
    expect(org.tree(company.id).employees[0].workspaces).toEqual([]);
    expect(org.tree(company.id).employees[0].memories).toEqual([]);
  });

  it("ensures one vacant 市场调查员 seat under the product department", () => {
    const { companies, org } = openServices();
    const company = companies.create({ name: "曜石" });
    expect(org.ensureMarketResearcherSeat(company.id)).toBeNull();

    org.createDepartment({ companyId: company.id, name: "工程部" });
    const product = org.createDepartment({
      companyId: company.id,
      name: "产品部",
    });
    const first = org.ensureMarketResearcherSeat(company.id);
    expect(first?.title).toBe("市场调查员");
    expect(first?.departmentId).toBe(product.id);
    expect(org.ensureMarketResearcherSeat(company.id)?.id).toBe(first?.id);
    expect(
      org.tree(company.id).positions.filter((position) => position.title === "市场调查员"),
    ).toHaveLength(1);
  });

  it("ensures a complete operating roster even when the company has no departments", () => {
    const { companies, org } = openServices();
    const company = companies.create({ name: "曜石" });

    const first = org.ensureOperatingSeats(company.id);
    expect(first.map((position) => position.title)).toEqual([
      "研发负责人",
      "执行工程师",
      "质量负责人",
      "产品助理",
      "市场调查员",
      "设计师",
      "增长运营",
      "客户支持",
      "财务合规",
    ]);
    expect(org.ensureOperatingSeats(company.id).map((position) => position.id))
      .toEqual(first.map((position) => position.id));
    expect(org.tree(company.id).departments.map((department) => department.name))
      .toEqual(expect.arrayContaining(["产品部", "工程部", "质量部", "运营部"]));
  });

  it("moves existing operating seats into their canonical departments", () => {
    const { companies, org } = openServices();
    const company = companies.create({ name: "曜石" });
    const engineering = org.createDepartment({
      companyId: company.id,
      name: "工程部",
    });
    const misplaced = org.createPosition({
      companyId: company.id,
      departmentId: engineering.id,
      templateId: org.createPositionTemplate({
        companyId: company.id,
        name: "产品助理",
        charter: "规格",
      }).id,
      title: "产品助理",
    });
    org.createPosition({
      companyId: company.id,
      departmentId: engineering.id,
      templateId: org.createPositionTemplate({
        companyId: company.id,
        name: "质量负责人",
        charter: "审查",
      }).id,
      title: "质量负责人",
    });

    const seats = org.ensureOperatingSeats(company.id);
    const product = seats.find((position) => position.title === "产品助理");
    const quality = seats.find((position) => position.title === "质量负责人");
    const productDept = org.tree(company.id).departments.find((department) =>
      department.name === "产品部");
    const qualityDept = org.tree(company.id).departments.find((department) =>
      department.name === "质量部");

    expect(product?.id).toBe(misplaced.id);
    expect(product?.departmentId).toBe(productDept?.id);
    expect(quality?.departmentId).toBe(qualityDept?.id);
  });

  it("binds a talent snapshot and allows multiple writable workspaces", () => {
    const { companies, org } = openServices();
    const company = companies.create({ name: "曜石" });
    const dept = org.createDepartment({ companyId: company.id, name: "产品部" });
    const tmpl = org.createPositionTemplate({
      companyId: company.id,
      name: "Product Director",
      charter: "范围建议权，无发布权",
    });
    const pos = org.createPosition({
      companyId: company.id,
      departmentId: dept.id,
      templateId: tmpl.id,
      title: "产品总监",
    });
    const emp = org.hire({
      companyId: company.id,
      displayName: "方夏",
      positionId: pos.id,
      autonomyLevel: 2,
    });

    org.bindCapability({
      companyId: company.id,
      employeeId: emp.id,
      talentTemplateId: "talent.product-director",
      talentRole: "产品总监",
      skills: ["spec"],
      tools: ["read_file"],
      workspaces: [
        { workspaceId: "ws-app", mode: "write", isDefault: true },
        { workspaceId: "ws-docs", mode: "read", isDefault: false },
      ],
    });

    const bound = org.tree(company.id).employees[0];
    expect(bound.profile).toEqual({
      talentTemplateId: "talent.product-director",
      talentRole: "产品总监",
      skills: ["spec"],
      tools: ["read_file"],
    });
    expect(bound.workspaces).toHaveLength(2);
    expect(bound.workspaces).toEqual(expect.arrayContaining([
      { workspaceId: "ws-app", mode: "write", isDefault: true },
      { workspaceId: "ws-docs", mode: "read", isDefault: false },
    ]));
    org.bindCapability({
      companyId: company.id,
      employeeId: emp.id,
      talentTemplateId: "talent.product-director",
      talentRole: "产品总监",
      skills: [],
      tools: [],
      workspaces: [
        { workspaceId: "ws-a", mode: "write", isDefault: true },
        { workspaceId: "ws-b", mode: "write", isDefault: false },
      ],
    });
    expect(org.tree(company.id).employees[0].workspaces).toEqual(
      expect.arrayContaining([
        { workspaceId: "ws-a", mode: "write", isDefault: true },
        { workspaceId: "ws-b", mode: "write", isDefault: false },
      ]),
    );
    org.bindCapability({
      companyId: company.id,
      employeeId: emp.id,
      talentTemplateId: "talent.product-director",
      talentRole: "产品总监",
      skills: [],
      tools: [],
      modelProfileId: "ibrain",
      workspaces: [{ workspaceId: "ws-a", mode: "write", isDefault: true }],
    });
    expect(org.tree(company.id).employees[0].profile).toEqual({
      talentTemplateId: "talent.product-director",
      talentRole: "产品总监",
      skills: [],
      tools: [],
      modelProfileId: "ibrain",
    });
    expect(() =>
      org.bindCapability({
        companyId: company.id,
        employeeId: emp.id,
        talentTemplateId: "talent.product-director",
        talentRole: "产品总监",
        skills: [],
        tools: [],
        workspaces: [
          { workspaceId: "ws-a", mode: "write", isDefault: true },
          { workspaceId: "ws-b", mode: "write", isDefault: true },
        ],
      }),
    ).toThrow(/at most one default workspace/);
    expect(() =>
      org.hire({
        companyId: company.id,
        displayName: "重复",
        positionId: pos.id,
        autonomyLevel: 2,
      }),
    ).toThrow(/position already occupied/);
  });
});

function openServices(): {
  companies: CompanyService;
  org: OrganizationService;
} {
  const root = mkdtempSync(join(tmpdir(), "forge-company-domain-"));
  fixtureRoots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);
  return {
    companies: new CompanyService(store.db, clock),
    org: new OrganizationService(store.db, clock),
  };
}
