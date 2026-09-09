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
