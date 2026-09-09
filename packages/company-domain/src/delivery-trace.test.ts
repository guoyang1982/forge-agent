import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyService } from "./company-service.js";
import { buildDeliveryTrace, canMarkDelivered } from "./delivery-trace.js";
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

describe("delivery trace", () => {
  it("omits delivery until spec plan and run exist", () => {
    const { db, item, work } = openFixture();

    const trace = buildDeliveryTrace(db, item.id);

    expect(trace).toEqual({
      workItemId: item.id,
      runIds: [],
      artifactIds: work.listArtifacts(item.id).map(({ id }) => id),
      validationIds: [],
    });
    expect(canMarkDelivered(trace)).toBe(false);
  });

  it("is complete after accepted spec, plan, and linked run", () => {
    const { db, gates, item, employee, work } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "先实现状态切换，再补快捷键",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    gates.linkRun({
      workItemId: item.id,
      runId: "run_delivery_1",
      planArtifactId: plan.id,
    });
    db.prepare(
      `INSERT INTO core_validations (
        id, run_id, validator_id, layer, status, severity,
        evidence_ids_json, summary, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "validation_delivery_1",
      "run_delivery_1",
      employee.id,
      "result",
      "passed",
      "info",
      "[]",
      "Delivery output verified",
      "{}",
      clock.now(),
    );

    const trace = buildDeliveryTrace(db, item.id);

    expect(trace).toEqual({
      workItemId: item.id,
      specVersion: 1,
      planVersion: 1,
      runIds: ["run_delivery_1"],
      artifactIds: work.listArtifacts(item.id).map(({ id }) => id),
      validationIds: ["validation_delivery_1"],
    });
    expect(canMarkDelivered(trace)).toBe(true);
  });

  it("uses only currently accepted artifact versions and non-empty runs", () => {
    const { db, gates, item, employee } = openFixture();
    const specV1 = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "v1",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: specV1.id, actorId: employee.id });
    const specV2 = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "v2",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: specV2.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "plan",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    gates.linkRun({
      workItemId: item.id,
      runId: "",
      planArtifactId: plan.id,
    });

    const trace = buildDeliveryTrace(db, item.id);

    expect(trace.specVersion).toBe(2);
    expect(trace.planVersion).toBe(1);
    expect(trace.runIds).toEqual([]);
    expect(canMarkDelivered(trace)).toBe(false);
  });
});

function openFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-delivery-trace-"));
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
    db: store.db,
    employee,
    gates: new WorkGates(store.db, clock),
    item,
    work,
  };
}
