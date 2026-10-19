import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentProfileStore } from "@forge/agent-profile";
import {
  CompanyService,
  StageGateService,
  OrganizationService,
  WorkGates,
  WorkService,
  acceptBrief,
} from "@forge/company-domain";
import { ArtifactService } from "@forge/evidence";
import { ExecutionStore } from "@forge/execution";
import { BudgetLedgerService } from "@forge/usage-ledger";
import { WorkspaceGroupService, WorkspaceLeaseService } from "@forge/workspace";
import { DAEMON_COMPANY_METHODS } from "@forge/protocol";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { TypedRouter } from "../host/router.js";
import type { ForgeDaemonContext } from "./context.js";
import { createCompanyModule } from "./company-module.js";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "migrations",
);
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("company module", () => {
  it("exposes workflow templates as unavailable when no production capability provider exists", async () => {
    const { router } = companyRouterFixture();
    const result = await router.handleUntyped("company.workflows.capabilities", {}, rpcContext());
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ workflowId: "forge.company.requirement-research", runnable: false }),
      expect.objectContaining({ workflowId: "forge.company.product-delivery", runnable: false }),
    ]));
  });

  it("exposes the latest ready research brief id on research work items only", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const item = company.work.createWorkItem({ companyId: created.id, type: "research", title: "调研", problem: "p", expectedOutcome: "o", ownerId: owner.id });
    const before = await router.handleUntyped("company.workItems.list", { companyId: created.id }, rpcContext()) as Array<Record<string, unknown>>;
    expect(before[0]).not.toHaveProperty("researchBriefId");
    const brief = acceptBrief(store.db, { now: () => "2026-09-09T09:00:00.000Z" }, {
      companyId: created.id, workItemId: item.id, problem: "转化低", targetUser: "SMB", expectedOutcome: "明确是否研发",
    });
    const after = await router.handleUntyped("company.workItems.list", { companyId: created.id }, rpcContext()) as Array<Record<string, unknown>>;
    expect(after[0]).toMatchObject({ id: item.id, researchBriefId: brief.id });
  });

  it("creates a ready research brief when a research work item is created over RPC", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const item = await router.handleUntyped("company.workItems.create", {
      companyId: created.id, type: "research", title: "调研", problem: "  转化   低 ",
      targetUser: "SMB 运营", expectedOutcome: "明确是否研发", constraints: "预算有限，两周内",
      ownerId: owner.id,
    }, rpcContext()) as { id: string };
    const list = await router.handleUntyped("company.workItems.list", { companyId: created.id }, rpcContext()) as Array<Record<string, unknown>>;
    const row = store.db.prepare(
      "SELECT id, ready, target_user AS targetUser, normalized_problem AS problem, constraints_json AS constraints FROM company_research_briefs WHERE work_item_id = ?",
    ).all(item.id) as Array<{ id: string; ready: number; targetUser: string; problem: string; constraints: string }>;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ ready: 1, targetUser: "SMB 运营", problem: "转化 低" });
    expect(JSON.parse(row[0].constraints)).toEqual(["预算有限", "两周内"]);
    expect(list[0]).toMatchObject({ id: item.id, researchBriefId: row[0].id });
  });

  it("rejects research work item creation without targetUser and leaves nothing behind", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    for (const targetUser of [undefined, "   "]) {
      await expect(router.handleUntyped("company.workItems.create", {
        companyId: created.id, type: "research", title: "调研", problem: "p",
        expectedOutcome: "o", ownerId: owner.id, ...(targetUser === undefined ? {} : { targetUser }),
      }, rpcContext())).rejects.toThrow(/targetUser/);
    }
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM company_work_items").get()).toEqual({ n: 0 });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM company_research_briefs").get()).toEqual({ n: 0 });
  });

  it("does not require targetUser or create briefs for non-research work items", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const item = await router.handleUntyped("company.workItems.create", {
      companyId: created.id, type: "implementation", title: "开发", problem: "p",
      expectedOutcome: "o", ownerId: owner.id,
    }, rpcContext()) as { id: string };
    expect(item.id).toBeTruthy();
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM company_research_briefs").get()).toEqual({ n: 0 });
  });

  it("previews only artifacts produced by this company's linked task", async () => {
    const { router, company, artifacts } = companyRouterFixture();
    const created = company.companies.create({ name: "结果预览" });
    const owner = hireEmployee(company, created.id);
    const item = company.work.createWorkItem({ companyId: created.id, type: "research", title: "调研", problem: "可行吗", expectedOutcome: "报告", ownerId: owner.id });
    const plan = company.gates.upsertDraft({ workItemId: item.id, kind: "plan", content: "调研计划", actorId: owner.id });
    company.gates.acceptArtifact({ artifactId: plan.id, actorId: owner.id });
    company.gates.linkRun({ workItemId: item.id, runId: "preview-run", planArtifactId: plan.id });
    await artifacts.register({ id: "report-preview", producerRunId: "preview-run", mediaType: "text/markdown", content: Buffer.from("# 结论\n建议先验证。"), accessScope: { companyId: created.id } });
    await artifacts.register({ id: "unrelated-report", producerRunId: "another-run", mediaType: "text/markdown", content: Buffer.from("不可见") });
    const params = { companyId: created.id, workItemId: item.id, outputId: "report-preview" };
    const result = await router.handleUntyped("company.workOutputs.read", params, rpcContext());
    expect(result).toMatchObject({ previewable: true, content: "# 结论\n建议先验证。" });
    await expect(router.handleUntyped("company.workOutputs.read", { ...params, companyId: "another-company" }, rpcContext())).rejects.toThrow();
    await expect(router.handleUntyped("company.workOutputs.read", { ...params, outputId: "unrelated-report" }, rpcContext())).rejects.toThrow();
  });

  it("previews only workspace files written by this company's linked task", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "文件预览" });
    const owner = hireEmployee(company, created.id);
    const item = company.work.createWorkItem({
      companyId: created.id,
      type: "research",
      title: "调研",
      problem: "可行吗",
      expectedOutcome: "报告",
      ownerId: owner.id,
    });
    const plan = company.gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "调研计划",
      actorId: owner.id,
    });
    company.gates.acceptArtifact({ artifactId: plan.id, actorId: owner.id });
    store.db.prepare(
      `INSERT INTO core_runs (id, state, spec_json, correlation_id, requested_by_json, created_at, updated_at)
      VALUES ('file-run', 'succeeded', '{}', 'file-run', '{}', '2026-09-09T09:00:00.000Z', '2026-09-09T09:00:00.000Z')`,
    ).run();
    company.gates.linkRun({ workItemId: item.id, runId: "file-run", planArtifactId: plan.id });
    store.db.prepare(
      `INSERT INTO core_events (event_id, event_type, envelope_json, occurred_at, run_id)
      VALUES ('evt-file', 'agent.event', ?, '2026-09-09T09:00:00.000Z', 'file-run')`,
    ).run(JSON.stringify({
      data: { type: "tool_start", name: "write_file", args: { path: "docs/00.md", content: "# 结论" } },
    }));
    const params = { companyId: created.id, workItemId: item.id, path: "docs/00.md" };
    const result = await router.handleUntyped("company.workFiles.read", params, rpcContext());
    expect(result).toMatchObject({ previewable: true, content: "# 结论", path: "docs/00.md" });
    await expect(router.handleUntyped("company.workFiles.read", { ...params, companyId: "another-company" }, rpcContext())).rejects.toThrow();
    await expect(router.handleUntyped("company.workFiles.read", { ...params, path: "docs/missing.md" }, rpcContext())).rejects.toThrow();
    await expect(router.handleUntyped("company.workFiles.read", { ...params, path: "../outside.md" }, rpcContext())).rejects.toThrow();
  });

  it("registers every company protocol method", () => {
    const { router } = companyRouterFixture();

    expect(router.methods()).toEqual(
      expect.arrayContaining(Object.values(DAEMON_COMPANY_METHODS)),
    );
  });

  it("registers company.create and returns the company", async () => {
    const { router } = companyRouterFixture();

    const result = await router.handleUntyped(
      "company.create",
      { name: "曜石" },
      rpcContext(),
    );

    expect(result).toMatchObject({ name: "曜石" });
    const tree = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.ORGANIZATION_TREE,
      { companyId: (result as { id: string }).id },
      rpcContext(),
    ) as {
      employees: Array<{ displayName: string; positionId: string }>;
      positions: Array<{ id: string; title: string }>;
    };
    expect(tree.positions.map((position) => position.title)).toEqual(expect.arrayContaining([
      "研发负责人",
      "执行工程师",
      "质量负责人",
      "产品助理",
      "市场调查员",
      "设计师",
      "增长运营",
      "客户支持",
      "财务合规",
    ]));
    expect(tree.employees.map((employee) => employee.displayName)).toEqual(expect.arrayContaining([
      "林川",
      "苏衡",
      "沈清",
      "乔麦",
      "闻启",
      "顾言",
      "韩舟",
      "叶宁",
      "沈律",
    ]));
  });

  it("keeps organization.tree read-only and seeds via ensureCrew", async () => {
    const { router, company } = companyRouterFixture({
      projects: [{ id: "ws-app", name: "app", cwd: "/Users/me/app" }],
    });
    const created = company.companies.create({ name: "曜石" });
    company.org.createDepartment({
      companyId: created.id,
      name: "产品部",
    });

    const before = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.ORGANIZATION_TREE,
      { companyId: created.id },
      rpcContext(),
    ) as { positions: Array<{ title: string }>; employees: unknown[] };
    expect(before.positions).toEqual([]);
    expect(before.employees).toEqual([]);

    const seeded = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.ORGANIZATION_ENSURE_CREW,
      { companyId: created.id, workspaceId: "ws-app" },
      rpcContext(),
    ) as {
      positions: Array<{ title: string; departmentId: string }>;
      employees: Array<{ displayName: string; workspaces: Array<{ workspaceId: string }> }>;
      departments: Array<{ id: string; name: string }>;
    };
    expect(seeded.positions.map((position) => position.title)).toContain("市场调查员");
    expect(seeded.employees.map((employee) => employee.displayName)).toContain("闻启");
    expect(seeded.employees.every((employee) =>
      employee.workspaces.some((grant) => grant.workspaceId === "ws-app"),
    )).toBe(true);
    const product = seeded.departments.find((department) => department.name === "产品部");
    expect(
      seeded.positions.find((position) => position.title === "市场调查员")?.departmentId,
    ).toBe(product?.id);
  });

  it("grants a default write workspace to employees that lack one", async () => {
    const { router, company } = companyRouterFixture({
      projects: [{ id: "ws-docs", name: "docs", cwd: "/Users/me/docs" }],
    });
    const created = company.companies.create({ name: "曜石" });
    await router.handleUntyped(
      DAEMON_COMPANY_METHODS.ORGANIZATION_ENSURE_CREW,
      { companyId: created.id },
      rpcContext(),
    );
    const granted = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.EMPLOYEES_GRANT_DEFAULT_WORKSPACE,
      { companyId: created.id, workspaceId: "ws-docs" },
      rpcContext(),
    ) as { updated: number; workspaceId: string };
    expect(granted).toMatchObject({ updated: 9, workspaceId: "ws-docs" });
    const again = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.EMPLOYEES_GRANT_DEFAULT_WORKSPACE,
      { companyId: created.id, workspaceId: "ws-docs" },
      rpcContext(),
    ) as { updated: number };
    expect(again.updated).toBe(0);
  });

  it("registers a shared project into core_workspaces when granting a real path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "forge-company-ws-grant-"));
    fixtureRoots.push(cwd);
    const { router, company, store } = companyRouterFixture({
      projects: [{ id: "1789031917157-e22fb", name: "公司测试目录", cwd }],
    });
    const created = company.companies.create({ name: "曜石" });
    await router.handleUntyped(
      DAEMON_COMPANY_METHODS.ORGANIZATION_ENSURE_CREW,
      { companyId: created.id, workspaceId: "1789031917157-e22fb" },
      rpcContext(),
    );

    expect(
      store.db.prepare(`SELECT id, root_path AS rootPath FROM core_workspaces WHERE id = ?`)
        .get("1789031917157-e22fb"),
    ).toEqual({ id: "1789031917157-e22fb", rootPath: cwd });
    expect(
      store.db.prepare(
        `SELECT COUNT(*) AS n FROM company_employee_workspaces
         WHERE company_id = ? AND workspace_id = ?`,
      ).get(created.id, "1789031917157-e22fb"),
    ).toEqual({ n: 9 });
  });

  it("decides and reads the latest versioned delivery gate", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const goal = company.work.createGoal({
      companyId: created.id,
      title: "发布",
      ownerId: owner.id,
    });
    const project = company.work.createProject({
      companyId: created.id,
      goalId: goal.id,
      title: "产品交付",
    });

    const item = company.work.createWorkItem({ companyId: created.id, projectId: project.id, type: "intent", title: "scope", problem: "scope", expectedOutcome: "spec", ownerId: owner.id });
    const spec = company.gates.upsertDraft({ workItemId: item.id, kind: "spec", content: "approved scope", actorId: owner.id });
    company.gates.acceptArtifact({ artifactId: spec.id, actorId: owner.id });
    new StageGateService(store.db).decide({ id: "research-prerequisite", companyId: created.id, projectId: project.id, gate: "research", outcome: "approved", inputVersionRefs: ["verified-research"], decidedBy: { kind: "employee", id: owner.id }, rationale: "Evidence", impact: "Proceed", decidedAt: "2026-09-11T07:00:00.000Z" }, ["verified-research"]);
    const snapshot = await router.handleUntyped(DAEMON_COMPANY_METHODS.DELIVERY_GATES_SNAPSHOT, { companyId: created.id, projectId: project.id, gate: "scope" }, rpcContext()) as { inputVersionRefs: string[]; ready: boolean };
    expect(snapshot.ready).toBe(true);
    const request = { id: "gate-scope-1", companyId: created.id, projectId: project.id, gate: "scope", outcome: "approved", inputVersionRefs: snapshot.inputVersionRefs, decidedBy: { kind: "employee", id: owner.id }, rationale: "Reviewed", impact: "Proceed" };
    const decided = await router.handleUntyped(DAEMON_COMPANY_METHODS.DELIVERY_GATES_DECIDE, request, rpcContext());
    expect(decided).toMatchObject({ id: request.id, nextAction: "create_development_work_items" });
    await expect(router.handleUntyped(DAEMON_COMPANY_METHODS.DELIVERY_GATES_DECIDE, request, rpcContext())).resolves.toEqual(decided);
    await expect(router.handleUntyped(DAEMON_COMPANY_METHODS.DELIVERY_GATES_DECIDE, { ...request, rationale: "changed" }, rpcContext())).rejects.toThrow();
    await expect(router.handleUntyped(DAEMON_COMPANY_METHODS.DELIVERY_GATES_LATEST, { projectId: project.id, gate: "scope" }, rpcContext())).resolves.toEqual(decided);
    await expect(router.handleUntyped(DAEMON_COMPANY_METHODS.DELIVERY_GATES_DECIDE, { ...request, id: "forged", inputVersionRefs: ["forged"], currentInputVersionRefs: ["forged"] }, rpcContext())).rejects.toMatchObject({ fault: { message: "gate inputs changed" } });
    await expect(router.handleUntyped(DAEMON_COMPANY_METHODS.DELIVERY_GATES_DECIDE, { ...request, id: "human", decidedBy: { kind: "human", id: owner.id } }, rpcContext())).rejects.toThrow();
  });

  it("resumes the matching research-gate step wait after a research decision", async () => {
    const { router, company, store, executionStore, wake } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const goal = company.work.createGoal({ companyId: created.id, title: "G", ownerId: owner.id });
    const project = company.work.createProject({ companyId: created.id, goalId: goal.id, title: "P" });
    const item = company.work.createWorkItem({ companyId: created.id, projectId: project.id, type: "research", title: "r", problem: "p", expectedOutcome: "o", ownerId: owner.id });
    const now = "2026-09-09T09:00:00.000Z";
    store.db.prepare("UPDATE company_work_items SET state = 'completed' WHERE id = ?").run(item.id);
    store.db.prepare(`INSERT INTO core_runs (id, state, spec_json, correlation_id, requested_by_json, created_at, updated_at) VALUES ('research-run', 'succeeded', '{}', 'r', '{}', ?, ?)`).run(now, now);
    store.db.prepare(`INSERT INTO company_run_links (id, company_id, work_item_id, run_id, created_at) VALUES ('research-link', ?, ?, 'research-run', ?)`).run(created.id, item.id, now);
    store.db.prepare(`INSERT INTO core_artifacts (id, producer_run_id, media_type, sha256, content_ref, size_bytes, created_at) VALUES ('research-report', 'research-run', 'text/markdown', 'hash1', 'report-ref', 10, ?)`).run(now);

    const waitRun = (runId: string, ref: string) => {
      executionStore.createRun({
        id: runId,
        requestedBy: { kind: "human", id: "u" },
        actingSubject: { kind: "agent_profile", id: "p" },
        objective: "wait",
        correlationId: runId,
        policyContext: {},
        steps: [{ id: "gate", kind: "requirement-research.gate", dependsOn: [], input: {}, retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 }, timeoutMs: 1000 }],
      }, now);
      const claimed = executionStore.claimNextStep(runId, "w", now)!;
      return executionStore.enterStepWait(claimed.id, "manual_review", { kind: "manual_review", reason: ref }, now);
    };
    const matching = waitRun("wf-run-1", `company-stage-gate:research:${project.id}`);
    const other = waitRun("wf-run-2", "company-stage-gate:research:other-project");

    const snapshot = await router.handleUntyped(DAEMON_COMPANY_METHODS.DELIVERY_GATES_SNAPSHOT, { companyId: created.id, projectId: project.id, gate: "research" }, rpcContext()) as { inputVersionRefs: string[]; ready: boolean };
    expect(snapshot.ready).toBe(true);
    const request = { id: "gate-research-1", companyId: created.id, projectId: project.id, gate: "research", outcome: "approved", inputVersionRefs: snapshot.inputVersionRefs, decidedBy: { kind: "employee", id: owner.id }, rationale: "Reviewed", impact: "Proceed" };
    await router.handleUntyped(DAEMON_COMPANY_METHODS.DELIVERY_GATES_DECIDE, request, rpcContext());

    expect(executionStore.getStep("wf-run-1", "gate")?.state).toBe("runnable");
    expect(executionStore.getLatestResolvedWait("wf-run-1", "gate")?.payload).toMatchObject({ decisionId: "gate-research-1", outcome: "approved" });
    expect(executionStore.getActiveWait("wf-run-2", "gate")?.id).toBe(other);
    expect(executionStore.getActiveWait("wf-run-1", "gate")).toBeNull();
    expect(matching).toBeTruthy();
    expect(wake.calls).toBe(1);
    // Idempotent re-decide must not fail on the already-resolved wait.
    await router.handleUntyped(DAEMON_COMPANY_METHODS.DELIVERY_GATES_DECIDE, request, rpcContext());
    expect(wake.calls).toBe(1);
  });

  it("onboards an employee with a talent snapshot and no workspace grants", async () => {
    const { router, company } = companyRouterFixture({
      models: [{ id: "ibrain", name: "gpt-5.5", provider: "openai" }],
    });
    const created = company.companies.create({ name: "曜石" });
    const department = company.org.createDepartment({
      companyId: created.id,
      name: "产品部",
    });
    const template = company.org.createPositionTemplate({
      companyId: created.id,
      name: "Product",
      charter: "规格",
    });
    const position = company.org.createPosition({
      companyId: created.id,
      departmentId: department.id,
      templateId: template.id,
      title: "产品总监",
    });

    const options = await router.handleUntyped(
      "company.employees.onboardOptions",
      { companyId: created.id },
      rpcContext(),
    ) as {
      positions: Array<{ id: string; occupied: boolean }>;
      workspaces: unknown[];
      models: Array<{ id: string; name: string }>;
    };
    expect(options.positions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: position.id, occupied: false })]),
    );
    expect(options.workspaces).toEqual([]);
    expect(options.models).toEqual([
      expect.objectContaining({ id: "ibrain", name: "gpt-5.5" }),
    ]);

    const hired = await router.handleUntyped(
      "company.employees.onboard",
      {
        companyId: created.id,
        displayName: "乔麦",
        positionId: position.id,
        talentTemplateId: "talent.product-director",
        modelProfileId: "ibrain",
      },
      rpcContext(),
    ) as { id: string; profile: { talentRole: string; modelProfileId?: string } };

    expect(hired.profile.talentRole).toBe("talent.product-director");
    expect(hired.profile.modelProfileId).toBe("ibrain");
    expect(company.org.tree(created.id).employees[0].profile?.talentTemplateId)
      .toBe("talent.product-director");
    expect(company.org.tree(created.id).employees[0].profile?.modelProfileId)
      .toBe("ibrain");
  });

  it("does not keep a hired employee when workspace grants are invalid", async () => {
    const { router, company } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const department = company.org.createDepartment({
      companyId: created.id,
      name: "产品部",
    });
    const template = company.org.createPositionTemplate({
      companyId: created.id,
      name: "Product",
      charter: "规格",
    });
    const position = company.org.createPosition({
      companyId: created.id,
      departmentId: department.id,
      templateId: template.id,
      title: "产品总监",
    });

    await expect(
      router.handleUntyped(
        "company.employees.onboard",
        {
          companyId: created.id,
          displayName: "乔麦",
          positionId: position.id,
          talentTemplateId: "talent.product-director",
          workspaces: [{ workspaceId: "missing-ws", mode: "write" }],
        },
        rpcContext(),
      ),
    ).rejects.toMatchObject({
      fault: { code: "INVALID_REQUEST", message: "workspace not found" },
    });

    expect(company.org.tree(created.id).employees).toEqual([]);
  });

  it("binds employee workspaces using the project folder path", async () => {
    const { router, company, store } = companyRouterFixture({
      projects: [{ id: "p-docs", name: "Documents", cwd: "/tmp/Documents" }],
    });
    const created = company.companies.create({ name: "曜石" });
    const department = company.org.createDepartment({
      companyId: created.id,
      name: "工程部",
    });
    const template = company.org.createPositionTemplate({
      companyId: created.id,
      name: "Engineer",
      charter: "Build",
    });
    const position = company.org.createPosition({
      companyId: created.id,
      departmentId: department.id,
      templateId: template.id,
      title: "工程师",
    });
    const hired = company.org.hire({
      companyId: created.id,
      displayName: "林川",
      positionId: position.id,
      autonomyLevel: 2,
    });
    store.db.exec(`
      INSERT INTO core_workspaces (
        id, root_path, canonical_root_path, label, created_at, updated_at
      ) VALUES (
        'automation-workspace:docs',
        '/tmp/Documents',
        '/tmp/Documents',
        'Documents',
        '2026-09-09T09:00:00.000Z',
        '2026-09-09T09:00:00.000Z'
      );
      INSERT INTO sessions (id, cwd, created_at) VALUES
        ('ses_docs', '/tmp/Documents', '2026-09-09T09:00:02.000Z');
    `);

    const bound = await router.handleUntyped(
      "company.employees.bind",
      {
        companyId: created.id,
        employeeId: hired.id,
        talentTemplateId: "engineering-software-architect",
        workspaces: [{ workspaceId: "/tmp/Documents", mode: "write", isDefault: true }],
      },
      rpcContext(),
    ) as { workspaces: Array<{ workspaceId: string; isDefault: boolean }> };

    expect(bound.workspaces).toEqual([
      { workspaceId: "automation-workspace:docs", mode: "write", isDefault: true },
    ]);
  });

  it("lists current workbench projects instead of removed session folders", async () => {
    const { router, company, store } = companyRouterFixture({
      projects: [
        { id: "p-keep", name: "keep-app", cwd: "/Users/me/keep-app" },
        { id: "p-docs", name: "文档库", cwd: "/Users/me/docs" },
      ],
    });
    const created = company.companies.create({ name: "曜石" });
    store.db.exec(`
      INSERT INTO core_workspaces (
        id, root_path, canonical_root_path, label, created_at, updated_at
      ) VALUES
        (
          'automation-workspace:game',
          '/Users/me/removed-game',
          '/Users/me/removed-game',
          'Automation 执行一次写个新的小游戏',
          '2026-09-09T09:00:00.000Z',
          '2026-09-09T09:00:00.000Z'
        ),
        (
          'ws-docs',
          '/Users/me/docs',
          '/Users/me/docs',
          '文档库',
          '2026-09-09T09:00:01.000Z',
          '2026-09-09T09:00:01.000Z'
        ),
        (
          'ws-keep',
          '/Users/me/keep-app',
          '/Users/me/keep-app',
          'keep-app',
          '2026-09-09T09:00:02.000Z',
          '2026-09-09T09:00:02.000Z'
        );
      INSERT INTO sessions (id, cwd, created_at) VALUES
        ('ses_removed', '/Users/me/removed-game', '2026-09-09T09:00:03.000Z'),
        ('ses_old', '/Users/me/old-app', '2026-09-09T09:00:04.000Z');
    `);

    const options = await router.handleUntyped(
      "company.employees.onboardOptions",
      { companyId: created.id },
      rpcContext(),
    ) as {
      workspaces: Array<{ id: string; rootPath: string; label: string }>;
    };

    expect(options.workspaces).toEqual([
      {
        id: "ws-keep",
        rootPath: "/Users/me/keep-app",
        label: "keep-app",
      },
      {
        id: "ws-docs",
        rootPath: "/Users/me/docs",
        label: "文档库",
      },
    ]);
    expect(options.workspaces.map((item) => item.rootPath).join(" ")).not.toMatch(
      /removed-game|old-app/,
    );
    expect(options.workspaces.map((item) => item.label).join(" ")).not.toMatch(
      /Automation|小游戏/,
    );
  });

  it("hides automation-only folders that were never opened in the workbench", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    store.db.exec(`
      INSERT INTO core_workspaces (
        id, root_path, canonical_root_path, label, created_at, updated_at
      ) VALUES (
        'automation-workspace:news',
        '/tmp/automation-news',
        '/tmp/automation-news',
        'Automation 发送AI最新3条新闻',
        '2026-09-09T09:00:00.000Z',
        '2026-09-09T09:00:00.000Z'
      );
    `);

    const options = await router.handleUntyped(
      "company.employees.onboardOptions",
      { companyId: created.id },
      rpcContext(),
    ) as { workspaces: unknown[] };

    expect(options.workspaces).toEqual([]);
  });

  it("skips placeholder project folders like . and worktrees", async () => {
    const { router, company } = companyRouterFixture({
      projects: [
        { id: "p-dot", name: "dot", cwd: "." },
        {
          id: "p-wt",
          name: "worktree",
          cwd: "/Users/me/forge-agent/.worktrees/core-v2",
        },
        { id: "p-real", name: "forge-agent", cwd: "/Users/me/forge-agent" },
      ],
    });
    const created = company.companies.create({ name: "曜石" });

    const options = await router.handleUntyped(
      "company.employees.onboardOptions",
      { companyId: created.id },
      rpcContext(),
    ) as { workspaces: Array<{ label: string; rootPath: string }> };

    expect(options.workspaces).toEqual([
      {
        id: "p-real",
        rootPath: "/Users/me/forge-agent",
        label: "forge-agent",
      },
    ]);
  });

  it("writes intent.md under the company artifact root on workItems.create", async () => {
    const { router, company, artifactRoot } = companyRouterFixture({
      artifactRoot: true,
    });
    const created = await router.handleUntyped(
      "company.create",
      { name: "曜石" },
      rpcContext(),
    ) as { id: string };
    const emp = hireEmployee(company, created.id);
    const item = await router.handleUntyped(
      "company.workItems.create",
      {
        companyId: created.id,
        type: "implementation",
        title: "团队版窗格最大化",
        problem: "给 SSH 客户端出团队版：窗格一键最大化",
        expectedOutcome: "可一键最大化窗格",
        ownerId: emp.id,
      },
      rpcContext(),
    ) as { id: string };

    expect(
      readFileSync(
        join(artifactRoot, created.id, "work", item.id, "intent.md"),
        "utf8",
      ),
    ).toContain("一键最大化");
  });

  it("drafts spec and plan from the demand when the model is unavailable", async () => {
    const { router, company } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const emp = hireEmployee(company, created.id);
    const item = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "团队版窗格最大化",
      problem: "给 SSH 客户端出团队版：窗格一键最大化",
      expectedOutcome: "可一键最大化窗格",
      ownerId: emp.id,
    });

    const drafted = await router.handleUntyped(
      "company.workArtifacts.draft",
      { workItemId: item.id, drafterId: emp.id, actorId: emp.id },
      rpcContext(),
    ) as { spec: string; plan: string; source: string; drafterId: string };

    expect(drafted.source).toBe("template");
    expect(drafted.drafterId).toBe(emp.id);
    expect(drafted.spec).toContain("可一键最大化窗格");
    expect(drafted.spec).toContain("起草：Owner · Engineer");
    expect(drafted.plan).toContain("实施计划");
  });

  it("drafts spec and plan with the drafter talent pack", async () => {
    const prompts: string[] = [];
    const { router, company } = companyRouterFixture({
      generateDraft: async (prompt) => {
        prompts.push(prompt);
        return '{"spec":"## 范围\\n窗格最大化","plan":"## 步骤\\n先改状态"}';
      },
    });
    const created = company.companies.create({ name: "曜石" });
    const emp = hireEmployee(company, created.id);
    company.org.bindCapability({
      companyId: created.id,
      employeeId: emp.id,
      talentTemplateId: "talent.product",
      talentRole: "产品助理",
      skills: ["需求拆解", "规格写作"],
      tools: [],
      workspaces: [],
    });
    const item = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "团队版窗格最大化",
      problem: "给 SSH 客户端出团队版：窗格一键最大化",
      expectedOutcome: "可一键最大化窗格",
      ownerId: emp.id,
    });

    const drafted = await router.handleUntyped(
      "company.workArtifacts.draft",
      { workItemId: item.id, drafterId: emp.id, actorId: emp.id },
      rpcContext(),
    ) as {
      spec: string;
      plan: string;
      source: string;
      drafterId: string;
      talentRole: string;
    };

    expect(prompts.some((prompt) => prompt.includes("需求拆解"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("产品助理"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("不要照抄需求原文"))).toBe(true);
    expect(drafted.source).toBe("employee");
    expect(drafted.drafterId).toBe(emp.id);
    expect(drafted.talentRole).toBe("产品助理");
    expect(drafted.spec).toContain("窗格最大化");
    expect(drafted.spec).toContain("起草：Owner · Engineer");
  });

  it("drafts with the drafter bound model as the employee brain", async () => {
    const models: Array<string | undefined> = [];
    const { router, company } = companyRouterFixture({
      generateDraft: async (_prompt, model) => {
        models.push(model);
        return '{"spec":"## 范围\\n窗格最大化","plan":"## 步骤\\n先改状态"}';
      },
    });
    const created = company.companies.create({ name: "曜石" });
    const emp = hireEmployee(company, created.id);
    company.org.bindCapability({
      companyId: created.id,
      employeeId: emp.id,
      talentTemplateId: "talent.product",
      talentRole: "产品助理",
      skills: ["需求拆解"],
      tools: [],
      modelProfileId: "ibrain",
      workspaces: [],
    });
    const item = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "团队版窗格最大化",
      problem: "给 SSH 客户端出团队版：窗格一键最大化",
      expectedOutcome: "可一键最大化窗格",
      ownerId: emp.id,
    });

    await router.handleUntyped(
      "company.workArtifacts.draft",
      { workItemId: item.id, drafterId: emp.id, actorId: emp.id },
      rpcContext(),
    );

    expect(models).toEqual(["ibrain"]);
  });

  it("rejects an approval decision made by the work item's assignee", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const department = company.org.createDepartment({
      companyId: created.id,
      name: "Engineering",
    });
    const template = company.org.createPositionTemplate({
      companyId: created.id,
      name: "Engineer",
      charter: "Build",
    });
    const position = company.org.createPosition({
      companyId: created.id,
      departmentId: department.id,
      templateId: template.id,
      title: "Engineer",
    });
    const assignee = company.org.hire({
      companyId: created.id,
      displayName: "Executor",
      positionId: position.id,
      autonomyLevel: 2,
    });
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: assignee.id,
    });
    store.db
      .prepare(
        "UPDATE company_work_items SET assignee_id = ?, state = 'waiting_approval' WHERE id = ?",
      )
      .run(assignee.id, workItem.id);

    const error = await router
      .handleUntyped(
        "company.approvals.decide",
        {
          workItemId: workItem.id,
          actorId: assignee.id,
          decision: "approve",
        },
        rpcContext(),
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/executor cannot approve own work/);
  });

  it("rejects an approval decision for a draft work item", async () => {
    const { router, company } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: owner.id,
    });

    const error = await router
      .handleUntyped(
        DAEMON_COMPANY_METHODS.APPROVALS_DECIDE,
        {
          workItemId: workItem.id,
          actorId: owner.id,
          decision: "approved",
        },
        rpcContext(),
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/not a submission/);
  });

  it("rejects an invalid approval decision", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: owner.id,
    });
    store.db
      .prepare(
        "UPDATE company_work_items SET state = 'submitted' WHERE id = ?",
      )
      .run(workItem.id);

    const error = await router
      .handleUntyped(
        DAEMON_COMPANY_METHODS.APPROVALS_DECIDE,
        {
          workItemId: workItem.id,
          actorId: owner.id,
          decision: "approve",
        },
        rpcContext(),
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/decision must be approved or rejected/);
  });

  it("moves a linked run through independent approval to completed", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const reviewer = hireEmployee(company, created.id);
    const assignee = hireEmployee(company, created.id);
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: reviewer.id,
    });
    const spec = company.gates.upsertDraft({
      workItemId: workItem.id,
      kind: "spec",
      content: "Accepted behavior",
      actorId: reviewer.id,
    });
    company.gates.acceptArtifact({ artifactId: spec.id, actorId: reviewer.id });
    const plan = company.gates.upsertDraft({
      workItemId: workItem.id,
      kind: "plan",
      content: "Implement accepted behavior",
      actorId: reviewer.id,
    });
    company.gates.acceptArtifact({ artifactId: plan.id, actorId: reviewer.id });
    company.gates.dispatch({
      workItemId: workItem.id,
      assigneeId: assignee.id,
      actorId: reviewer.id,
    });

    company.gates.linkRun({
      workItemId: workItem.id,
      runId: "run_accepted_1",
      planArtifactId: plan.id,
    });
    company.gates.onRunTerminal({ runId: "run_accepted_1", outcome: "succeeded" });
    const approvals = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.APPROVALS_LIST,
      { companyId: created.id },
      rpcContext(),
    ) as { pending: Array<{ id: string }> };
    expect(approvals.pending).toEqual([
      expect.objectContaining({ id: workItem.id, state: "waiting_approval" }),
    ]);

    const decision = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.APPROVALS_DECIDE,
      {
        workItemId: workItem.id,
        actorId: reviewer.id,
        decision: "approved",
        reason: "Acceptance checks passed",
      },
      rpcContext(),
    );

    expect(decision).toMatchObject({
      workItemId: workItem.id,
      decision: "approved",
      reason: "Acceptance checks passed",
    });
    expect(
      store.db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(workItem.id),
    ).toEqual({ state: "completed" });
    expect(
      store.db.prepare("SELECT reason FROM company_decisions WHERE work_item_id = ?").get(workItem.id),
    ).toEqual({ reason: "Acceptance checks passed" });
    expect(
      store.db.prepare(
        `SELECT kind, content FROM company_employee_memories
        WHERE employee_id = ? ORDER BY created_at DESC, id DESC`,
      ).all(assignee.id),
    ).toEqual([
      {
        kind: "lesson",
        content: "验收通过：Ship module。Acceptance checks passed",
      },
    ]);
  });

  it("completes a blocked parent when its fix is approved", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const reviewer = hireEmployee(company, created.id);
    const assignee = hireEmployee(company, created.id);
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: reviewer.id,
    });
    store.db
      .prepare(
        "UPDATE company_work_items SET assignee_id = ?, state = 'waiting_approval' WHERE id = ?",
      )
      .run(assignee.id, workItem.id);

    const rejected = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.APPROVALS_DECIDE,
      {
        workItemId: workItem.id,
        actorId: reviewer.id,
        decision: "rejected",
        reason: "Missing acceptance evidence",
      },
      rpcContext(),
    ) as { fixWorkItem: { id: string } };
    store.db
      .prepare(
        "UPDATE company_work_items SET assignee_id = ?, state = 'waiting_approval' WHERE id = ?",
      )
      .run(assignee.id, rejected.fixWorkItem.id);

    await router.handleUntyped(
      DAEMON_COMPANY_METHODS.APPROVALS_DECIDE,
      {
        workItemId: rejected.fixWorkItem.id,
        actorId: reviewer.id,
        decision: "approved",
        reason: "Fix checks passed",
      },
      rpcContext(),
    );

    expect(
      store.db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(rejected.fixWorkItem.id),
    ).toEqual({ state: "completed" });
    expect(
      store.db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(workItem.id),
    ).toEqual({ state: "completed" });
  });

  it("requires and persists rejection reasons while rejecting the item", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const reviewer = hireEmployee(company, created.id);
    const assignee = hireEmployee(company, created.id);
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: reviewer.id,
    });
    store.db
      .prepare(
        "UPDATE company_work_items SET assignee_id = ?, state = 'waiting_approval' WHERE id = ?",
      )
      .run(assignee.id, workItem.id);

    await expect(
      router.handleUntyped(
        DAEMON_COMPANY_METHODS.APPROVALS_DECIDE,
        {
          workItemId: workItem.id,
          actorId: reviewer.id,
          decision: "rejected",
        },
        rpcContext(),
      ),
    ).rejects.toMatchObject({
      fault: { code: "INVALID_REQUEST" },
    });

    await router.handleUntyped(
      DAEMON_COMPANY_METHODS.APPROVALS_DECIDE,
      {
        workItemId: workItem.id,
        actorId: reviewer.id,
        decision: "rejected",
        reason: "Missing acceptance evidence",
      },
      rpcContext(),
    );

    expect(
      store.db
        .prepare(
          `SELECT item.state, decision.reason
          FROM company_work_items AS item
          JOIN company_decisions AS decision ON decision.work_item_id = item.id
          WHERE item.id = ? AND decision.decision = 'rejected'`,
        )
        .get(workItem.id),
    ).toEqual({
      state: "blocked",
      reason: "Missing acceptance evidence",
    });
    expect(
      store.db.prepare(
        `SELECT title, type, parent_id AS parentId, state
        FROM company_work_items
        WHERE parent_id = ?`,
      ).get(workItem.id),
    ).toEqual({
      title: "Fix: Ship module",
      type: "fix",
      parentId: workItem.id,
      state: "draft",
    });
    expect(
      store.db.prepare(
        `SELECT kind, content FROM company_employee_memories
        WHERE employee_id = ? ORDER BY created_at DESC, id DESC`,
      ).all(assignee.id),
    ).toEqual([
      {
        kind: "gate",
        content: "验收驳回：Missing acceptance evidence",
      },
    ]);
  });

  it("creates a durable run for a dispatched work item with a default write workspace", async () => {
    const { router, company, store, wake, executionStore } = companyRouterFixture();
    const { created, workItem, plan, assignee } = seedRunnableWorkItem(company, store);

    const result = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    ) as { workItemId: string; planArtifactId: string; runId: string };

    expect(result).toEqual({
      workItemId: workItem.id,
      planArtifactId: plan.id,
      runId: result.runId,
    });
    expect(result.runId).toBeTruthy();
    expect(
      store.db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(workItem.id),
    ).toEqual({ state: "in_progress" });
    expect(
      store.db
        .prepare("SELECT run_id AS runId FROM company_run_links WHERE work_item_id = ?")
        .get(workItem.id),
    ).toEqual({ runId: result.runId });
    expect(
      store.db.prepare("SELECT id FROM core_runs WHERE id = ?").get(result.runId),
    ).toEqual({ id: result.runId });
    expect(wake.calls).toBe(1);

    const run = executionStore.getRun(result.runId);
    const profileId = company.org.tree(created.id).employees
      .find((entry) => entry.id === assignee.id)?.profile?.agentProfileId;
    expect(profileId).toBeTruthy();
    expect(run?.spec.actingSubject).toEqual({
      kind: "agent_profile",
      id: profileId,
    });
    expect(run?.spec.requestedBy).toEqual({
      kind: "employee",
      id: assignee.id,
    });
    expect(run?.spec.policyContext.companyWorkItemId).toBe(workItem.id);
    expect(run?.spec.policyContext.employeeId).toBe(assignee.id);
    expect(run?.spec.objective).toBe(workItem.title);
    expect(run?.spec.steps[0]?.input).toEqual(
      expect.objectContaining({
        cwd: "/tmp/forge-app",
        autoApply: true,
        companyWorkItemId: workItem.id,
        automationRun: { name: workItem.title },
      }),
    );
  });

  it("requests a run with the assignee bound model", async () => {
    const { router, company, store, executionStore } = companyRouterFixture();
    const { created, workItem, assignee } = seedRunnableWorkItem(company, store);
    company.org.bindCapability({
      companyId: created.id,
      employeeId: assignee.id,
      talentTemplateId: "talent.engineer",
      talentRole: "工程师",
      skills: [],
      tools: [],
      modelProfileId: "ibrain",
      workspaces: [{ workspaceId: "ws-app", mode: "write", isDefault: true }],
    });

    const result = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    ) as { runId: string };

    expect(executionStore.getRun(result.runId)?.spec.steps[0]?.input).toEqual(
      expect.objectContaining({
        runtime: { provider: "forge", model: "ibrain" },
      }),
    );
  });

  it("rejects requestRun when the assignee has no default write workspace", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const reviewer = hireEmployee(company, created.id);
    const assignee = hireEmployee(company, created.id);
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: reviewer.id,
    });
    const spec = company.gates.upsertDraft({
      workItemId: workItem.id,
      kind: "spec",
      content: "Accepted behavior",
      actorId: reviewer.id,
    });
    company.gates.acceptArtifact({ artifactId: spec.id, actorId: reviewer.id });
    const plan = company.gates.upsertDraft({
      workItemId: workItem.id,
      kind: "plan",
      content: "Implement accepted behavior",
      actorId: reviewer.id,
    });
    company.gates.acceptArtifact({ artifactId: plan.id, actorId: reviewer.id });
    company.gates.dispatch({
      workItemId: workItem.id,
      assigneeId: assignee.id,
      actorId: reviewer.id,
    });

    await expect(
      router.handleUntyped(
        DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
        { workItemId: workItem.id },
        rpcContext(),
      ),
    ).rejects.toMatchObject({
      fault: {
        code: "POLICY_DENIED",
        message: "assignee has no default write workspace",
      },
    });
    expect(
      store.db.prepare("SELECT COUNT(*) AS count FROM core_runs").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects a run request without an accepted plan", async () => {
    const { router, company } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: owner.id,
    });

    await expect(
      router.handleUntyped(
        DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
        { workItemId: workItem.id },
        rpcContext(),
      ),
    ).rejects.toMatchObject({
      fault: { code: "POLICY_DENIED", message: "plan not accepted" },
    });
  });

  it("rejects requestRun when the work item has no assignee", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const reviewer = hireEmployee(company, created.id);
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: reviewer.id,
    });
    const spec = company.gates.upsertDraft({
      workItemId: workItem.id,
      kind: "spec",
      content: "Accepted behavior",
      actorId: reviewer.id,
    });
    company.gates.acceptArtifact({ artifactId: spec.id, actorId: reviewer.id });
    const plan = company.gates.upsertDraft({
      workItemId: workItem.id,
      kind: "plan",
      content: "Implement accepted behavior",
      actorId: reviewer.id,
    });
    company.gates.acceptArtifact({ artifactId: plan.id, actorId: reviewer.id });

    await expect(
      router.handleUntyped(
        DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
        { workItemId: workItem.id },
        rpcContext(),
      ),
    ).rejects.toMatchObject({
      fault: { code: "POLICY_DENIED", message: "work item has no assignee" },
    });
    expect(
      store.db.prepare("SELECT COUNT(*) AS count FROM core_runs").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects a second requestRun while the first run is still running", async () => {
    const { router, company, store } = companyRouterFixture();
    const { workItem } = seedRunnableWorkItem(company, store);

    await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    );

    await expect(
      router.handleUntyped(
        DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
        { workItemId: workItem.id },
        rpcContext(),
      ),
    ).rejects.toMatchObject({
      fault: {
        code: "POLICY_DENIED",
        message: "work item already has an active run",
      },
    });
  });

  it("creates distinct durable runs for two dispatched work items", async () => {
    const { router, company, store } = companyRouterFixture();
    const { created, reviewer, assignee, workItem } = seedRunnableWorkItem(
      company,
      store,
    );
    const other = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship other module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: reviewer.id,
    });
    const spec = company.gates.upsertDraft({
      workItemId: other.id,
      kind: "spec",
      content: "Accepted behavior",
      actorId: reviewer.id,
    });
    company.gates.acceptArtifact({ artifactId: spec.id, actorId: reviewer.id });
    const plan = company.gates.upsertDraft({
      workItemId: other.id,
      kind: "plan",
      content: "Implement accepted behavior",
      actorId: reviewer.id,
    });
    company.gates.acceptArtifact({ artifactId: plan.id, actorId: reviewer.id });
    company.gates.dispatch({
      workItemId: other.id,
      assigneeId: assignee.id,
      actorId: reviewer.id,
    });

    const first = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    ) as { runId: string };
    const second = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: other.id },
      rpcContext(),
    ) as { runId: string };

    expect(first.runId).toBeTruthy();
    expect(second.runId).toBeTruthy();
    expect(second.runId).not.toBe(first.runId);
  });

  it("allows requestRun again after onRunTerminal failed", async () => {
    const { router, company, store } = companyRouterFixture();
    const { workItem } = seedRunnableWorkItem(company, store);

    const first = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    ) as { runId: string };
    store.db.prepare("UPDATE core_runs SET state = 'failed' WHERE id = ?").run(first.runId);
    company.gates.onRunTerminal({ runId: first.runId, outcome: "failed" });

    const second = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    ) as { runId: string };

    expect(first.runId).toBeTruthy();
    expect(second.runId).toBeTruthy();
    expect(second.runId).not.toBe(first.runId);
  });

  it("surfaces accepted artifact versions in work item pipeline gates", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: owner.id,
    });
    const spec = company.gates.upsertDraft({
      workItemId: workItem.id,
      kind: "spec",
      content: "Accepted behavior",
      actorId: owner.id,
    });
    company.gates.acceptArtifact({ artifactId: spec.id, actorId: owner.id });
    store.db.prepare(
      `INSERT INTO company_run_links
        (id, company_id, work_item_id, run_id, plan_artifact_id, created_at)
      VALUES
        ('run_link_empty', ?, ?, '', NULL, '2026-09-09T09:00:00.000Z'),
        ('run_link_filled', ?, ?, 'run_123', NULL, '2026-09-09T09:01:00.000Z')`,
    ).run(created.id, workItem.id, created.id, workItem.id);

    const item = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_GET,
      { workItemId: workItem.id },
      rpcContext(),
    );
    const dashboard = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.DASHBOARD_GET,
      { companyId: created.id },
      rpcContext(),
    ) as { pipelines: unknown[] };

    expect(item).toMatchObject({
      specVersion: 1,
      currentGate: "缺 plan",
      runIds: ["run_123"],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      trace: {
        workItemId: workItem.id,
        specVersion: 1,
        runIds: ["run_123"],
        runs: [
          {
            runId: "run_123",
            createdAt: "2026-09-09T09:01:00.000Z",
          },
        ],
        artifactIds: expect.arrayContaining([spec.id]),
        validationIds: [],
      },
    });
    expect(dashboard.pipelines).toEqual([
      expect.objectContaining({
        id: workItem.id,
        specVersion: 1,
        currentGate: "缺 plan",
      }),
    ]);
  });

  it("labels a failed run as waiting for a fix, not a rejection", async () => {
    const { router, company, store } = companyRouterFixture();
    const { workItem } = seedRunnableWorkItem(company, store);
    const first = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    ) as { runId: string };
    store.db.prepare("UPDATE core_runs SET state = 'failed' WHERE id = ?").run(first.runId);
    company.gates.onRunTerminal({ runId: first.runId, outcome: "failed" });

    const item = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_GET,
      { workItemId: workItem.id },
      rpcContext(),
    );

    expect(item).toMatchObject({
      state: "blocked",
      currentGate: "执行失败待修",
    });
  });

  it("surfaces a waiting run as waiting for input, not in progress", async () => {
    const { router, company, store } = companyRouterFixture();
    const { workItem } = seedRunnableWorkItem(company, store);
    const created = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    ) as { runId: string };
    store.db.prepare("UPDATE core_runs SET state = 'waiting' WHERE id = ?").run(created.runId);

    const item = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_GET,
      { workItemId: workItem.id },
      rpcContext(),
    );

    expect(item).toMatchObject({
      currentGate: "等待输入",
    });
  });

  it("attaches the open fix child so the parent does not need another halt", async () => {
    const { router, company } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: owner.id,
    });
    const fix = company.work.pauseForFix({
      workItemId: workItem.id,
      reason: "验收未过",
      ownerId: owner.id,
    });

    const item = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_GET,
      { workItemId: workItem.id },
      rpcContext(),
    );

    expect(item).toMatchObject({
      openFix: { id: fix.id, title: "Fix: Ship module" },
    });
  });

  it("records a self-check on the trace after a successful run", async () => {
    const { router, company, store } = companyRouterFixture();
    const { workItem } = seedRunnableWorkItem(company, store);
    const created = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    ) as { runId: string };
    store.db.prepare("UPDATE core_runs SET state = 'succeeded' WHERE id = ?").run(created.runId);
    company.gates.onRunTerminal({ runId: created.runId, outcome: "succeeded" });

    const item = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_GET,
      { workItemId: workItem.id },
      rpcContext(),
    ) as { state: string; trace: { validationIds: string[]; validations: Array<{ status: string }> } };

    expect(item.state).toBe("waiting_approval");
    expect(item.trace.validationIds.length).toBeGreaterThan(0);
    expect(item.trace.validations).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "passed" })]),
    );
  });

  it("returns approval history with work item titles", async () => {
    const { router, company, store } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const reviewer = hireEmployee(company, created.id);
    const assignee = hireEmployee(company, created.id);
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: reviewer.id,
    });
    store.db
      .prepare(
        "UPDATE company_work_items SET assignee_id = ?, state = 'waiting_approval' WHERE id = ?",
      )
      .run(assignee.id, workItem.id);
    await router.handleUntyped(
      DAEMON_COMPANY_METHODS.APPROVALS_DECIDE,
      {
        workItemId: workItem.id,
        actorId: reviewer.id,
        decision: "approved",
        reason: "Acceptance checks passed",
      },
      rpcContext(),
    );

    const approvals = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.APPROVALS_LIST,
      { companyId: created.id },
      rpcContext(),
    ) as { pending: unknown[]; decisions: Array<{ title: string; decision: string }> };

    expect(approvals.pending).toEqual([]);
    expect(approvals.decisions).toEqual([
      expect.objectContaining({
        title: "Ship module",
        decision: "approved",
        reason: "Acceptance checks passed",
      }),
    ]);
  });

  it("previews approval with the reviewer talent pack and still waits for a human", async () => {
    const prompts: string[] = [];
    const { router, company, store } = companyRouterFixture({
      generateDraft: async (prompt) => {
        prompts.push(prompt);
        return '{"recommendation":"approved","summary":"对照验收通过","findings":["总览可见"]}';
      },
    });
    const { created, reviewer, workItem, plan } = seedRunnableWorkItem(company, store);
    company.org.bindCapability({
      companyId: created.id,
      employeeId: reviewer.id,
      talentTemplateId: "talent.qa",
      talentRole: "质量负责人",
      skills: ["code-review", "acceptance"],
      tools: [],
      workspaces: [],
    });
    company.gates.linkRun({
      workItemId: workItem.id,
      runId: "run_preview_1",
      planArtifactId: plan.id,
    });
    company.gates.onRunTerminal({ runId: "run_preview_1", outcome: "succeeded" });

    const preview = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_PREVIEW_APPROVAL,
      { workItemId: workItem.id },
      rpcContext(),
    );
    const approvals = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.APPROVALS_LIST,
      { companyId: created.id },
      rpcContext(),
    ) as {
      pending: Array<{
        id: string;
        state: string;
        preview?: { recommendation?: string; summary?: string; reviewerId?: string };
      }>;
    };

    expect(prompts.some((prompt) => prompt.includes("code-review"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("质量负责人"))).toBe(true);
    expect(preview).toMatchObject({
      workItemId: workItem.id,
      reviewerId: reviewer.id,
      recommendation: "approved",
      summary: "对照验收通过",
    });
    expect(approvals.pending).toEqual([
      expect.objectContaining({
        id: workItem.id,
        state: "waiting_approval",
        preview: expect.objectContaining({
          reviewerId: reviewer.id,
          recommendation: "approved",
          summary: "对照验收通过",
        }),
      }),
    ]);
    expect(
      store.db.prepare("SELECT state FROM company_work_items WHERE id = ?").get(workItem.id),
    ).toEqual({ state: "waiting_approval" });
  });

  it("binds a budget account when creating a company over RPC", async () => {
    const { router, store } = companyRouterFixture();
    const created = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.CREATE,
      { name: "曜石" },
      rpcContext(),
    ) as { id: string };

    expect(
      store.db.prepare(
        "SELECT account_id AS accountId FROM company_budget_bindings WHERE company_id = ?",
      ).get(created.id),
    ).toEqual({ accountId: `budget:${created.id}` });

    const dashboard = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.DASHBOARD_GET,
      { companyId: created.id },
      rpcContext(),
    ) as { budget?: { availableMinor?: number } };
    expect(dashboard.budget?.availableMinor).toBe(1_000_000);
  });

  it("hangs a work item on the project goal and returns a CEO brief", async () => {
    const { router, company } = companyRouterFixture();
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const goal = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.GOALS_CREATE,
      { companyId: created.id, title: "本周可验收", ownerId: owner.id },
      rpcContext(),
    ) as { id: string };
    const project = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.PROJECTS_CREATE,
      { companyId: created.id, goalId: goal.id, title: "经营台" },
      rpcContext(),
    ) as { id: string };
    const item = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_CREATE,
      {
        companyId: created.id,
        projectId: project.id,
        type: "implementation",
        title: "总览可见目标",
        problem: "目标没挂上",
        expectedOutcome: "需求带上 goalId",
        ownerId: owner.id,
      },
      rpcContext(),
    ) as { goalId: string; projectId: string };

    expect(item).toMatchObject({ goalId: goal.id, projectId: project.id });

    const brief = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.CEO_BRIEF,
      { companyId: created.id },
      rpcContext(),
    ) as { summary: string; priorities: string[] };
    expect(brief.summary).toContain("曜石");
    expect(brief.priorities.length).toBeGreaterThan(0);
    expect(brief.priorities.length).toBeLessThanOrEqual(3);
  });

  it("materializes shared Forge projects into core_workspaces when binding a project group", async () => {
    const workspaceRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "forge-shared-ws-")));
    fixtureRoots.push(workspaceRoot);
    const { router, company, store } = companyRouterFixture({
      projects: [{ id: "warmGo-shared", name: "warmGo", cwd: workspaceRoot }],
    });
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    const goal = company.work.createGoal({
      companyId: created.id,
      title: "本周可验收",
      ownerId: owner.id,
    });
    const project = company.work.createProject({
      companyId: created.id,
      goalId: goal.id,
      title: "老年出行打车app",
    });

    expect(
      store.db.prepare(`SELECT id FROM core_workspaces WHERE id = ?`).get("warmGo-shared"),
    ).toBeUndefined();

    const bound = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.PROJECTS_BIND_WORKSPACES,
      {
        companyId: created.id,
        projectId: project.id,
        workspaceIds: ["warmGo-shared"],
      },
      rpcContext(),
    ) as { groupId: string; projectId: string };

    expect(bound).toMatchObject({ projectId: project.id, grantedEmployees: 1 });
    expect(bound.groupId).toBeTruthy();
    expect(
      store.db.prepare(`SELECT id, root_path AS rootPath FROM core_workspaces WHERE id = ?`)
        .get("warmGo-shared"),
    ).toEqual({ id: "warmGo-shared", rootPath: workspaceRoot });
    expect(
      store.db.prepare(
        `SELECT workspace_id AS workspaceId FROM core_workspace_bindings WHERE group_id = ?`,
      ).all(bound.groupId),
    ).toEqual([{ workspaceId: "warmGo-shared" }]);
    expect(
      store.db.prepare(
        `SELECT group_id AS groupId FROM company_project_workspace_groups
         WHERE company_id = ? AND project_id = ?`,
      ).get(created.id, project.id),
    ).toEqual({ groupId: bound.groupId });
    expect(
      store.db.prepare(
        `SELECT workspace_id AS workspaceId, mode, is_default AS isDefault
         FROM company_employee_workspaces
         WHERE company_id = ? AND employee_id = ? AND workspace_id = ?`,
      ).get(created.id, owner.id, "warmGo-shared"),
    ).toEqual({ workspaceId: "warmGo-shared", mode: "write", isDefault: 1 });
  });

  it("merges project group write grants onto employees that already have other workspaces", async () => {
    const otherRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "forge-other-ws-")));
    const projectRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "forge-project-ws-")));
    fixtureRoots.push(otherRoot, projectRoot);
    const { router, company, store } = companyRouterFixture({
      projects: [{ id: "proj-ws", name: "proj", cwd: projectRoot }],
    });
    store.db.exec(`
      INSERT INTO core_workspaces (
        id, root_path, canonical_root_path, label, created_at, updated_at
      ) VALUES
        ('ws-other', '${otherRoot}', '${otherRoot}', 'other',
         '2026-09-09T09:00:00.000Z', '2026-09-09T09:00:00.000Z'),
        ('proj-ws', '${projectRoot}', '${projectRoot}', 'proj',
         '2026-09-09T09:00:00.000Z', '2026-09-09T09:00:00.000Z');
    `);
    const created = company.companies.create({ name: "曜石" });
    const owner = hireEmployee(company, created.id);
    company.org.grantWorkspaces({
      companyId: created.id,
      employeeId: owner.id,
      workspaces: [{ workspaceId: "ws-other", mode: "write", isDefault: true }],
    });
    const goal = company.work.createGoal({
      companyId: created.id,
      title: "本周可验收",
      ownerId: owner.id,
    });
    const project = company.work.createProject({
      companyId: created.id,
      goalId: goal.id,
      title: "老年出行打车app",
    });

    await router.handleUntyped(
      DAEMON_COMPANY_METHODS.PROJECTS_BIND_WORKSPACES,
      {
        companyId: created.id,
        projectId: project.id,
        workspaceIds: ["proj-ws"],
      },
      rpcContext(),
    );

    expect(
      store.db.prepare(
        `SELECT workspace_id AS workspaceId, mode, is_default AS isDefault
         FROM company_employee_workspaces
         WHERE company_id = ? AND employee_id = ?
         ORDER BY workspace_id`,
      ).all(created.id, owner.id),
    ).toEqual([
      { workspaceId: "proj-ws", mode: "write", isDefault: 0 },
      { workspaceId: "ws-other", mode: "write", isDefault: 1 },
    ]);
  });

  it("writes working copies and freezes an AgentProfile snapshot on requestRun", async () => {
    const { router, company, store } = companyRouterFixture();
    const workspaceRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "forge-company-ws-")));
    fixtureRoots.push(workspaceRoot);
    const created = company.companies.create({ name: "曜石" });
    const reviewer = hireEmployee(company, created.id);
    const assignee = hireEmployee(company, created.id);
    store.db.exec(`
      INSERT INTO core_workspaces (
        id, root_path, canonical_root_path, label, created_at, updated_at
      ) VALUES (
        'ws-live', '${workspaceRoot}', '${workspaceRoot}', 'live',
        '2026-09-09T09:00:00.000Z', '2026-09-09T09:00:00.000Z'
      );
    `);
    company.org.bindCapability({
      companyId: created.id,
      employeeId: assignee.id,
      talentTemplateId: "talent.engineer",
      talentRole: "工程师",
      skills: ["ts"],
      tools: ["git"],
      workspaces: [{ workspaceId: "ws-live", mode: "write", isDefault: true, env: "dev" }],
    });
    const workItem = company.work.createWorkItem({
      companyId: created.id,
      type: "implementation",
      title: "Ship module",
      problem: "RPC is missing",
      expectedOutcome: "RPC is available",
      ownerId: reviewer.id,
    });
    const spec = company.gates.upsertDraft({
      workItemId: workItem.id,
      kind: "spec",
      content: "Accepted behavior",
      actorId: reviewer.id,
    });
    company.gates.acceptArtifact({ artifactId: spec.id, actorId: reviewer.id });
    const plan = company.gates.upsertDraft({
      workItemId: workItem.id,
      kind: "plan",
      content: "Implement accepted behavior",
      actorId: reviewer.id,
    });
    company.gates.acceptArtifact({ artifactId: plan.id, actorId: reviewer.id });
    company.gates.dispatch({
      workItemId: workItem.id,
      assigneeId: assignee.id,
      actorId: reviewer.id,
    });
    const goal = company.work.createGoal({
      companyId: created.id,
      title: "本周可验收",
      ownerId: reviewer.id,
    });
    const project = company.work.createProject({
      companyId: created.id,
      goalId: goal.id,
      title: "经营台",
    });
    const bound = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.PROJECTS_BIND_WORKSPACES,
      {
        companyId: created.id,
        projectId: project.id,
        workspaceIds: ["ws-live"],
      },
      rpcContext(),
    ) as { groupId: string };
    expect(bound.groupId).toBeTruthy();

    const result = await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    ) as { runId: string };

    expect(existsSync(join(workspaceRoot, ".forge/company", workItem.id, "spec.md"))).toBe(true);
    expect(existsSync(join(workspaceRoot, ".forge/company", workItem.id, "plan.md"))).toBe(true);
    expect(
      store.db.prepare(
        "SELECT COUNT(*) AS count FROM core_agent_capability_snapshots WHERE run_id = ?",
      ).get(result.runId),
    ).toEqual({ count: 1 });
    expect(
      store.db.prepare(
        "SELECT COUNT(*) AS count FROM core_workspace_leases WHERE run_id = ? AND released_at IS NULL",
      ).get(result.runId),
    ).toEqual({ count: 1 });
  });
});

function hireEmployee(
  company: ReturnType<typeof companyRouterFixture>["company"],
  companyId: string,
) {
  const department = company.org.createDepartment({
    companyId,
    name: "Engineering",
  });
  const template = company.org.createPositionTemplate({
    companyId,
    name: "Engineer",
    charter: "Build",
  });
  const position = company.org.createPosition({
    companyId,
    departmentId: department.id,
    templateId: template.id,
    title: "Engineer",
  });
  return company.org.hire({
    companyId,
    displayName: "Owner",
    positionId: position.id,
    autonomyLevel: 2,
  });
}

function seedRunnableWorkItem(
  company: ReturnType<typeof companyRouterFixture>["company"],
  store: ForgeStore,
) {
  const created = company.companies.create({ name: "曜石" });
  const reviewer = hireEmployee(company, created.id);
  const assignee = hireEmployee(company, created.id);
  store.db.exec(`
    INSERT INTO core_workspaces (
      id, root_path, canonical_root_path, label, created_at, updated_at
    ) VALUES (
      'ws-app', '/tmp/forge-app', '/tmp/forge-app', 'app',
      '2026-09-09T09:00:00.000Z', '2026-09-09T09:00:00.000Z'
    );
  `);
  company.org.bindCapability({
    companyId: created.id,
    employeeId: assignee.id,
    talentTemplateId: "talent.engineer",
    talentRole: "工程师",
    skills: [],
    tools: [],
    workspaces: [{ workspaceId: "ws-app", mode: "write", isDefault: true }],
  });
  const workItem = company.work.createWorkItem({
    companyId: created.id,
    type: "implementation",
    title: "Ship module",
    problem: "RPC is missing",
    expectedOutcome: "RPC is available",
    ownerId: reviewer.id,
  });
  const spec = company.gates.upsertDraft({
    workItemId: workItem.id,
    kind: "spec",
    content: "Accepted behavior",
    actorId: reviewer.id,
  });
  company.gates.acceptArtifact({ artifactId: spec.id, actorId: reviewer.id });
  const plan = company.gates.upsertDraft({
    workItemId: workItem.id,
    kind: "plan",
    content: "Implement accepted behavior",
    actorId: reviewer.id,
  });
  company.gates.acceptArtifact({ artifactId: plan.id, actorId: reviewer.id });
  company.gates.dispatch({
    workItemId: workItem.id,
    assigneeId: assignee.id,
    actorId: reviewer.id,
  });
  return { created, reviewer, assignee, workItem, plan };
}

function companyRouterFixture(options: {
  artifactRoot?: true;
  projects?: Array<{ id: string; name: string; cwd: string }>;
  models?: Array<{ id: string; name: string; provider?: string }>;
  generateDraft?: (prompt: string, model?: string) => Promise<string>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-company-module-"));
  fixtureRoots.push(root);
  const artifactRoot = join(root, "company");
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const clock = { now: () => "2026-09-09T09:00:00.000Z" };
  const executionClock = {
    now: () => "2026-09-09T09:00:00.000Z",
    nowMs: () => Date.parse("2026-09-09T09:00:00.000Z"),
  };
  const executionStore = new ExecutionStore(store.db);
  const agentProfiles = new AgentProfileStore(store.db);
  const budgetLedger = new BudgetLedgerService(store.db);
  const workspaceGroups = new WorkspaceGroupService(store.db);
  const workspaceLeases = new WorkspaceLeaseService(store.db);
  const wake = { calls: 0 };
  const wakeExecutor = () => {
    wake.calls += 1;
  };
  const company = {
    companies: new CompanyService(store.db, clock),
    org: new OrganizationService(store.db, clock),
    work: new WorkService(
      store.db,
      clock,
      options.artifactRoot ? { artifactRoot } : undefined,
    ),
    gates: new WorkGates(
      store.db,
      clock,
      options.artifactRoot ? { artifactRoot } : undefined,
    ),
  };
  const artifacts = new ArtifactService(store.db, artifactRoot);
  const context = {
    artifacts,
    socketPath: join(root, "daemon.sock"),
    store,
    serverVersion: "0.2.0-test",
    build: "company-module-test",
    company,
    executionStore,
    executionClock,
    agentProfiles,
    budgetLedger,
    workspaceGroups,
    workspaceLeases,
    wakeExecutor,
    executor: {
      resumeWait: (waitId: string, payload: unknown) =>
        executionStore.resumeWait(waitId, payload, executionClock.now()),
    },
  } satisfies Pick<
    ForgeDaemonContext,
    | "artifacts"
    | "socketPath"
    | "store"
    | "serverVersion"
    | "build"
    | "company"
    | "executionStore"
    | "executionClock"
    | "agentProfiles"
    | "budgetLedger"
    | "workspaceGroups"
    | "workspaceLeases"
    | "wakeExecutor"
  > & { executor: { resumeWait(waitId: string, payload: unknown): void } };
  const router = new TypedRouter();
  createCompanyModule({
    generateDraft: options.generateDraft ?? (async () => {
      throw new Error("model unavailable");
    }),
    listSharedProjects: () => options.projects ?? [],
    listModelProfiles: () => options.models ?? [],
  }).register(router, context as unknown as ForgeDaemonContext);
  return {
    router,
    company,
    store,
    artifactRoot,
    artifacts,
    executionStore,
    wake,
  };
}

function rpcContext() {
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    emitAgentEvent: () => {},
  };
}
