import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyService } from "../company-service.js";
import { OrganizationService } from "../organization-service.js";
import { WorkService } from "../work-service.js";
import type { DecideStageGateInput, StageGateNextAction } from "./stage-gate.js";
import { StageGateService } from "./stage-gate.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const roots: string[] = [];
const stores: ForgeStore[] = [];
const clock = { now: () => "2026-09-11T07:00:00.000Z" };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("StageGateService", () => {
  it("rejects a decision when an input version changed", () => {
    const { gates, companyId } = fixture();

    expect(() =>
      gates.decide(
        decision({ companyId, inputVersionRefs: ["brief:v1"] }),
        ["brief:v2"],
      ),
    ).toThrow("gate inputs changed");
  });

  it("compares input versions without depending on order", () => {
    const { gates, companyId } = fixture();

    expect(
      gates.decide(
        decision({ companyId, inputVersionRefs: ["brief:v1", "claims:v3"] }),
        ["claims:v3", "brief:v1"],
      ).nextAction,
    ).toBe("enter_product_definition");
  });

  it("stops after research without creating a development work item", () => {
    const { gates, companyId, store } = fixture();

    const result = gates.decide(
      decision({ companyId, outcome: "stopped" }),
      ["brief:v1"],
    );

    expect(result.nextAction).toBe("close_research_project");
    expect(
      store.db.prepare("SELECT COUNT(*) AS count FROM company_work_items").get(),
    ).toEqual({ count: 0 });
  });

  it.each([
    ["research", "approved", "enter_product_definition"],
    ["scope", "approved", "create_development_work_items"],
    ["technical", "approved", "create_development_work_items"],
    ["release", "approved", "call_deployment_connector"],
    ["scope", "rejected", "none"],
    ["technical", "changes_requested", "none"],
    ["release", "stopped", "none"],
  ] as const)(
    "maps %s/%s to %s",
    (gate, outcome, nextAction) => {
      const { gates, companyId, projectId } = fixture(true);

      const result = gates.decide(
        decision({ companyId, projectId, gate, outcome }),
        ["brief:v1"],
      );

      expect(result.nextAction).toBe<StageGateNextAction>(nextAction);
    },
  );

  it("persists immutable decisions and returns the latest for a project gate", () => {
    const { gates, companyId, projectId } = fixture(true);
    gates.decide(
      decision({
        id: "gate-scope-1",
        companyId,
        projectId,
        gate: "scope",
        outcome: "changes_requested",
        decidedAt: "2026-09-11T07:00:00.000Z",
      }),
      ["brief:v1"],
    );
    const latest = gates.decide(
      decision({
        id: "gate-scope-2",
        companyId,
        projectId,
        gate: "scope",
        decidedAt: "2026-09-11T08:00:00.000Z",
      }),
      ["brief:v1"],
    );

    expect(gates.getLatest(projectId, "scope")).toEqual(latest);
    expect(Object.isFrozen(latest)).toBe(true);
    expect(Object.isFrozen(latest.inputVersionRefs)).toBe(true);
    expect(() =>
      gates.decide(
        decision({ id: "gate-scope-2", companyId, projectId, gate: "scope" }),
        ["brief:v1"],
      ),
    ).toThrow();
    expect(
      gates.getLatest(projectId, "release"),
    ).toBeNull();
  });
});

function decision(
  overrides: Partial<DecideStageGateInput> = {},
): DecideStageGateInput {
  return {
    id: "gate-research-1",
    companyId: "company-1",
    gate: "research",
    outcome: "approved",
    inputVersionRefs: ["brief:v1"],
    decidedBy: { kind: "human", id: "owner-1" },
    rationale: "Evidence is sufficient",
    impact: "Proceed",
    decidedAt: "2026-09-11T07:00:00.000Z",
    ...overrides,
  };
}

function fixture(withProject = false) {
  const root = mkdtempSync(join(tmpdir(), "forge-stage-gate-"));
  roots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);
  const companies = new CompanyService(store.db, clock);
  const company = companies.create({ name: "Forge" });
  let projectId: string | undefined;
  if (withProject) {
    const org = new OrganizationService(store.db, clock);
    const department = org.createDepartment({ companyId: company.id, name: "Product" });
    const template = org.createPositionTemplate({
      companyId: company.id,
      name: "Owner",
      charter: "Decide",
    });
    const position = org.createPosition({
      companyId: company.id,
      departmentId: department.id,
      templateId: template.id,
      title: "Owner",
    });
    const owner = org.hire({
      companyId: company.id,
      displayName: "Owner",
      positionId: position.id,
      autonomyLevel: 2,
    });
    const work = new WorkService(store.db, clock);
    const goal = work.createGoal({
      companyId: company.id,
      title: "Ship",
      ownerId: owner.id,
    });
    projectId = work.createProject({
      companyId: company.id,
      goalId: goal.id,
      title: "Delivery",
    }).id;
  }
  return {
    store,
    companyId: company.id,
    projectId,
    gates: new StageGateService(store.db),
  };
}
