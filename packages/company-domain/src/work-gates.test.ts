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
    gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化",
      actorId: employee.id,
    });
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
    gates.acceptArtifact({ artifactId: v2.id, actorId: employee.id });
    expect(readFileSync(specPath, "utf8")).toBe("范围：最大化 + 徽章");
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
