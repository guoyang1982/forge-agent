import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  it("rewrites spec.md on the second upsert and after accept", () => {
    const { gates, item, companyId, artifactRoot, employee } = openFixture({
      artifactRoot: true,
    });
    const first = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化",
      actorId: employee.id,
    });
    expect(first.workspacePath).toBe(
      `${companyId}/work/${item.id}/spec.md`,
    );
    const v2 = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化 + 徽章",
      actorId: employee.id,
    });
    const specPath = join(
      artifactRoot,
      companyId,
      "work",
      item.id,
      "spec.md",
    );

    expect(readFileSync(specPath, "utf8")).toBe("范围：最大化 + 徽章");
    rmSync(specPath);
    const accepted = gates.acceptArtifact({
      artifactId: v2.id,
      actorId: employee.id,
    });
    expect(readFileSync(specPath, "utf8")).toBe("范围：最大化 + 徽章");
    expect(accepted.workspacePath).toBe(
      `${companyId}/work/${item.id}/spec.md`,
    );
    expect(gates.getArtifact(v2.id).workspacePath).toBe(
      `${companyId}/work/${item.id}/spec.md`,
    );
  });

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

  it("dispatches after accepting the spec", () => {
    const { gates, item, employee } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });

    const dispatched = gates.dispatch({
      workItemId: item.id,
      assigneeId: employee.id,
      actorId: employee.id,
    });

    expect(dispatched.state).toBe("ready");
    expect(dispatched.assigneeId).toBe(employee.id);
  });

  it("updates the live draft in place until it is accepted", () => {
    const { gates, item, employee, work } = openFixture();
    const first = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化",
      actorId: employee.id,
    });
    const edited = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化 + 快捷键",
      actorId: employee.id,
    });

    expect(edited.id).toBe(first.id);
    expect(edited.version).toBe(1);
    expect(edited.content).toBe("范围：最大化 + 快捷键");
    expect(edited.contentHash).not.toBe(first.contentHash);
    expect(
      work.listArtifacts(item.id).filter((artifact) => artifact.kind === "spec"),
    ).toHaveLength(1);

    gates.acceptArtifact({ artifactId: edited.id, actorId: employee.id });
    const next = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化 + 快捷键 + 徽章",
      actorId: employee.id,
    });
    expect(next.version).toBe(2);
    expect(next.id).not.toBe(first.id);
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

  it("supersedes the previous accepted artifact of the same kind", () => {
    const { gates, item, employee } = openFixture();
    const first = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: first.id, actorId: employee.id });
    const second = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化 + 徽章",
      actorId: employee.id,
    });

    gates.acceptArtifact({ artifactId: second.id, actorId: employee.id });

    expect(gates.getArtifact(first.id).status).toBe("superseded");
    expect(gates.getArtifact(second.id).status).toBe("accepted");
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

  it("returns the accepted plan after spec and plan acceptance", () => {
    const { gates, item, employee } = openFixture();
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

    expect(gates.assertImplementationRunAllowed(item.id)).toEqual(
      gates.getArtifact(plan.id),
    );
  });

  it("blocks the parent and creates a fix child carrying the reason", () => {
    const { db, gates, item, employee, work } = openFixture();
    const reason = "验收发现快捷键冲突";

    const child = gates.pauseForFix({
      workItemId: item.id,
      reason,
      ownerId: employee.id,
    });

    const parent = db
      .prepare("SELECT state FROM company_work_items WHERE id = ?")
      .get(item.id) as { state: string };
    const intent = work
      .listArtifacts(child.id)
      .find((artifact) => artifact.kind === "intent");
    expect(parent.state).toBe("blocked");
    expect(child).toMatchObject({
      parentId: item.id,
      type: "fix",
    });
    expect(intent?.content).toBe(reason);
  });

  it("copies accepted spec and plan onto the fix child as drafts", () => {
    const { gates, item, employee, work } = openFixture();
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
      content: "先改窗格再补快捷键",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    const reason = "快捷键冲突，需改绑定";

    const child = gates.pauseForFix({
      workItemId: item.id,
      reason,
      ownerId: employee.id,
    });
    const artifacts = work.listArtifacts(child.id);
    const childSpec = artifacts.find((artifact) => artifact.kind === "spec");
    const childPlan = artifacts.find((artifact) => artifact.kind === "plan");

    expect(childSpec).toMatchObject({ status: "draft" });
    expect(childPlan).toMatchObject({ status: "draft" });
    expect(childSpec?.content).toContain("范围：最大化");
    expect(childSpec?.content).toContain(reason);
    expect(childPlan?.content).toContain("先改窗格再补快捷键");
    expect(childPlan?.content).toContain(reason);
  });

  it("marks the work item in_progress when a run id is linked", () => {
    const { gates, item, employee, db } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "实现",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });

    gates.linkRun({
      workItemId: item.id,
      runId: "run_live_1",
      planArtifactId: plan.id,
    });

    expect(
      db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(item.id),
    ).toEqual({ state: "in_progress" });
  });

  it("moves a linked run to waiting_approval on success and blocked on failure", () => {
    const { gates, item, employee, db } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "实现",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    gates.linkRun({
      workItemId: item.id,
      runId: "run_live_1",
      planArtifactId: plan.id,
    });

    gates.onRunTerminal({ runId: "run_live_1", outcome: "succeeded" });
    expect(
      db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(item.id),
    ).toEqual({ state: "waiting_approval" });
    expect(
      db.prepare(
        `SELECT validator_id AS validatorId, status
        FROM core_validations WHERE run_id = ? AND validator_id = 'company.self_check'`,
      ).get("run_live_1"),
    ).toEqual({ validatorId: "company.self_check", status: "passed" });
  });

  it("opens a fix when a succeeded run already has a blocking failed validation", () => {
    const { gates, item, employee, db } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "实现",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    gates.linkRun({
      workItemId: item.id,
      runId: "run_bad_check",
      planArtifactId: plan.id,
    });
    db.prepare(
      `INSERT INTO core_validations (
        id, run_id, validator_id, layer, status, severity,
        evidence_ids_json, summary, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "validation_blocking_fail",
      "run_bad_check",
      "company.tests",
      "result",
      "failed",
      "blocking",
      "[]",
      "测试未过",
      "{}",
      "2026-09-09T00:00:00.000Z",
    );

    gates.onRunTerminal({ runId: "run_bad_check", outcome: "succeeded" });

    expect(
      db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(item.id),
    ).toEqual({ state: "blocked" });
    expect(
      db.prepare(
        "SELECT title FROM company_work_items WHERE parent_id = ?",
      ).get(item.id),
    ).toEqual({ title: `Fix: ${item.title}` });
  });

  it("moves a linked run to blocked on failure", () => {
    const { gates, item, employee, db } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "实现",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    gates.linkRun({
      workItemId: item.id,
      runId: "run_fail_1",
      planArtifactId: plan.id,
    });

    gates.onRunTerminal({ runId: "run_fail_1", outcome: "failed" });
    expect(
      db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(item.id),
    ).toEqual({ state: "blocked" });
    expect(
      db.prepare(
        `SELECT title, type, parent_id AS parentId, state
        FROM company_work_items WHERE parent_id = ?`,
      ).get(item.id),
    ).toEqual({
      title: `Fix: ${item.title}`,
      type: "fix",
      parentId: item.id,
      state: "draft",
    });
  });

  it("reuses an open fix child instead of opening another", () => {
    const { gates, item, employee, db } = openFixture();
    const first = gates.pauseForFix({
      workItemId: item.id,
      reason: "第一次失败",
      ownerId: employee.id,
    });
    const second = gates.pauseForFix({
      workItemId: item.id,
      reason: "再次暂停",
      ownerId: employee.id,
    });

    expect(second.id).toBe(first.id);
    expect(
      (db.prepare(
        "SELECT COUNT(*) AS count FROM company_work_items WHERE parent_id = ?",
      ).get(item.id) as { count: number }).count,
    ).toBe(1);
  });

  it("completes an approved item and its blocked parent", () => {
    const { gates, item, employee, db } = openFixture();
    const child = gates.pauseForFix({
      workItemId: item.id,
      reason: "验收未过",
      ownerId: employee.id,
    });

    const closed = gates.completeDelivery(child.id);

    expect(closed).toMatchObject({
      id: child.id,
      state: "completed",
      parentId: item.id,
    });
    expect(
      db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(item.id),
    ).toEqual({ state: "completed" });
  });

  it("ignores a stale terminal event after a newer run is linked", () => {
    const { gates, item, employee, db } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "实现",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    gates.linkRun({
      workItemId: item.id,
      runId: "run_a",
      planArtifactId: plan.id,
    });

    gates.onRunTerminal({ runId: "run_a", outcome: "failed" });
    expect(
      db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(item.id),
    ).toEqual({ state: "blocked" });

    db.prepare(
      "UPDATE company_run_links SET created_at = ? WHERE run_id = ?",
    ).run("2026-09-08T00:00:00.000Z", "run_a");
    gates.linkRun({
      workItemId: item.id,
      runId: "run_b",
      planArtifactId: plan.id,
    });
    expect(
      db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(item.id),
    ).toEqual({ state: "in_progress" });

    gates.onRunTerminal({ runId: "run_a", outcome: "failed" });
    expect(
      db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(item.id),
    ).toEqual({ state: "in_progress" });
  });

  it("treats a filled placeholder as newer than older completed links", () => {
    const { gates, item, employee, db } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "实现",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    gates.linkRun({
      workItemId: item.id,
      runId: "run_old",
      planArtifactId: plan.id,
    });
    gates.onRunTerminal({ runId: "run_old", outcome: "failed" });
    db.prepare(
      `INSERT INTO company_run_links
        (id, company_id, work_item_id, run_id, plan_artifact_id, created_at)
      VALUES (?, ?, ?, '', ?, ?)`,
    ).run(
      "run_link_placeholder",
      item.companyId,
      item.id,
      plan.id,
      "2026-09-01T00:00:00.000Z",
    );

    gates.linkRun({
      workItemId: item.id,
      runId: "run_new",
      planArtifactId: plan.id,
    });
    gates.onRunTerminal({ runId: "run_new", outcome: "succeeded" });

    expect(
      db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(item.id),
    ).toEqual({ state: "waiting_approval" });
  });

  it("writes the fix child intent after pauseForFix", () => {
    const { gates, item, employee, work, artifactRoot, companyId } = openFixture(
      { artifactRoot: true },
    );
    const reason = "验收发现快捷键冲突";

    const child = gates.pauseForFix({
      workItemId: item.id,
      reason,
      ownerId: employee.id,
    });

    const intent = work
      .listArtifacts(child.id)
      .find((artifact) => artifact.kind === "intent");
    expect(intent?.workspacePath).toBe(
      `${companyId}/work/${child.id}/intent.md`,
    );
    expect(
      readFileSync(
        join(artifactRoot, companyId, "work", child.id, "intent.md"),
        "utf8",
      ),
    ).toBe(reason);
  });
});

function openFixture(options?: { artifactRoot?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "forge-work-gates-"));
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
  const artifactOptions = options?.artifactRoot ? { artifactRoot } : undefined;
  const work = new WorkService(store.db, clock, artifactOptions);
  const item = work.createWorkItem({
    companyId: company.id,
    type: "implementation",
    title: "团队版窗格最大化",
    problem: "给 SSH 客户端出团队版：窗格一键最大化",
    expectedOutcome: "可一键最大化窗格",
    ownerId: employee.id,
  });

  return {
    artifactRoot,
    companyId: company.id,
    db: store.db,
    employee,
    gates: new WorkGates(store.db, clock, artifactOptions),
    item,
    work,
  };
}
