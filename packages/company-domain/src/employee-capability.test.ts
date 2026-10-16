import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import {
  capabilityNeedsTemplateFill,
  resolveEmployeeCapability,
  toDraftTalentPack,
} from "./employee-capability.js";
import { CompanyService } from "./company-service.js";
import { OrganizationService } from "./organization-service.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];
const stores: ForgeStore[] = [];
const clock = { now: () => "2026-09-11T00:00:00.000Z" };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("employee capability", () => {
  it("reads the snapshot hung on the employee, not an empty template", () => {
    const capability = resolveEmployeeCapability({
      talentTemplateId: "talent.engineer",
      talentRole: "执行工程师",
      skills: ["实现"],
      tools: ["edit"],
      qualityGates: ["有测试证据"],
      methodology: ["先复现再改"],
      systemPrompt: "只做已接受计划。",
      agentProfileId: "profile_1",
      agentProfileVersionId: "profile_ver_1",
    });
    expect(capability).toMatchObject({
      role: "执行工程师",
      qualityGates: ["有测试证据"],
      methodology: ["先复现再改"],
      systemPrompt: "只做已接受计划。",
      agentProfileId: "profile_1",
      agentProfileVersionId: "profile_ver_1",
    });
    expect(capabilityNeedsTemplateFill(capability)).toBe(false);
    expect(toDraftTalentPack(capability).systemPrompt).toBe("只做已接受计划。");
    expect(capabilityNeedsTemplateFill(resolveEmployeeCapability({
      talentTemplateId: "talent.engineer",
      talentRole: "执行工程师",
      skills: ["实现"],
      tools: ["edit"],
    }))).toBe(true);
  });

  it("persists the capability snapshot when binding and upgrades it on rebind", () => {
    const { org, employee, companyId } = openEmployee();
    org.bindCapability({
      companyId,
      employeeId: employee.id,
      talentTemplateId: "talent.engineer",
      talentRole: "执行工程师",
      skills: ["实现"],
      tools: ["edit"],
      systemPrompt: "只做已接受计划。",
      methodology: ["先复现再改"],
      qualityGates: ["有测试证据"],
      agentProfileId: "profile_1",
      agentProfileVersionId: "ver_1",
    });
    expect(org.tree(companyId).employees[0].profile).toMatchObject({
      systemPrompt: "只做已接受计划。",
      methodology: ["先复现再改"],
      qualityGates: ["有测试证据"],
      agentProfileId: "profile_1",
      agentProfileVersionId: "ver_1",
    });

    org.bindCapability({
      companyId,
      employeeId: employee.id,
      talentTemplateId: "talent.engineer",
      talentRole: "执行工程师",
      skills: ["实现", "自测"],
      tools: ["edit"],
      systemPrompt: "先写失败测试。",
      methodology: ["红绿重构"],
      qualityGates: ["测试先红"],
      agentProfileId: "profile_1",
      agentProfileVersionId: "ver_2",
    });
    const rebound = org.tree(companyId).employees[0].profile;
    expect(rebound?.systemPrompt).toBe("先写失败测试。");
    expect(rebound?.agentProfileVersionId).toBe("ver_2");
    expect(rebound?.skills).toEqual(["实现", "自测"]);
  });
});

function openEmployee() {
  const root = mkdtempSync(join(tmpdir(), "forge-emp-cap-"));
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
    charter: "实现已接受计划",
  });
  const position = org.createPosition({
    companyId: company.id,
    departmentId: department.id,
    templateId: template.id,
    title: "执行工程师",
  });
  const employee = org.hire({
    companyId: company.id,
    displayName: "苏衡",
    positionId: position.id,
    autonomyLevel: 2,
  });
  return { org, employee, companyId: company.id };
}
