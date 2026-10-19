import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompanyService,
  OrganizationService,
  WorkService,
  acceptBrief,
  bindCompanyBudgetAccount,
} from "@forge/company-domain";
import { ValidationService } from "@forge/evidence";
import { ExecutionStore } from "@forge/execution";
import { ForgeStore } from "@forge/store";
import { WorkspaceGroupService } from "@forge/workspace";
import { buildProductionGovernedInput } from "./production-execution-composition.js";
import {
  CompanyWorkflowStartError,
  startCompanyResearchWorkflow,
} from "./company-workflow-dispatch.js";
import { createProductionValidatorRegistry } from "./production-validators.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const clock = { now: () => "2026-09-11T12:00:00.000Z" };
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function researchDispatchFixture(options: { noEmployee?: boolean; notReady?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-research-dispatch-"));
  const store = ForgeStore.open({ dbPath: join(root, "data.db"), migrationsDir, owner: "test" });
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companies = new CompanyService(store.db, clock);
  const org = new OrganizationService(store.db, clock);
  const work = new WorkService(store.db, clock);
  const groups = new WorkspaceGroupService(store.db);
  const company = companies.create({ name: "曜石" });
  const department = org.createDepartment({ companyId: company.id, name: "研究部" });
  const template = org.createPositionTemplate({ companyId: company.id, name: "研究员", charter: "research" });
  const position = org.createPosition({
    companyId: company.id,
    departmentId: department.id,
    templateId: template.id,
    title: "研究员",
  });
  const employee = org.hire({
    companyId: company.id,
    displayName: "研究员甲",
    positionId: position.id,
    autonomyLevel: 2,
  });
  const wsPath = join(root, "ws-a");
  mkdirSync(wsPath);
  groups.registerWorkspace({ id: "ws-a", rootPath: wsPath });
  if (!options.noEmployee) {
    org.bindCapability({
      companyId: company.id,
      employeeId: employee.id,
      talentTemplateId: "tpl",
      talentRole: "researcher",
      skills: [],
      tools: [],
      agentProfileId: "profile-1",
      agentProfileVersionId: "profile-1-v1",
      workspaces: [{ workspaceId: "ws-a", mode: "write", isDefault: true }],
    });
  }
  const goal = work.createGoal({ companyId: company.id, title: "G", ownerId: employee.id });
  const project = work.createProject({ companyId: company.id, goalId: goal.id, title: "P" });
  bindCompanyBudgetAccount(store.db, {
    companyId: company.id,
    accountId: "acct-1",
    createdAt: clock.now(),
  });
  const item = work.createWorkItem({
    companyId: company.id,
    projectId: project.id,
    type: "research",
    title: "调研",
    problem: "转化低",
    expectedOutcome: "明确是否进入研发",
    ownerId: employee.id,
  });
  const brief = acceptBrief(store.db, clock, {
    companyId: company.id,
    workItemId: item.id,
    problem: options.notReady ? "" : "转化低",
    targetUser: "SMB 运营",
    expectedOutcome: "明确是否进入研发",
  });
  const executionStore = new ExecutionStore(store.db);
  const wakes: number[] = [];
  const deps = {
    db: store.db,
    executionStore,
    validations: new ValidationService(store.db, createProductionValidatorRegistry()),
    clock,
    wakeExecutor: () => {
      wakes.push(1);
    },
  };
  const base = {
    companyId: company.id,
    projectId: project.id,
    workflowId: "forge.company.requirement-research" as const,
    briefId: brief.id,
    idempotencyKey: "idea-1",
  };
  return { db: store.db, deps, base, executionStore, wakes, employeeId: employee.id, ...base };
}

describe("startCompanyResearchWorkflow", () => {
  it("starts a governed research instance idempotently", async () => {
    const fx = await researchDispatchFixture();
    const first = await startCompanyResearchWorkflow(fx.deps, fx.base);
    expect(first.reused).toBe(false);
    expect(first.workflowId).toBe("forge.company.requirement-research");

    const run = fx.executionStore.getRun(first.runId)!;
    const policy = run.spec.policyContext as Record<string, any>;
    expect(policy.stepGovernance["user-research"].workspace.mode).toBe("read");
    expect(Object.keys(policy.stepGovernance).sort()).toEqual(
      ["code-data-research", "market-research", "research-gate", "risk-research", "synthesis", "user-research"],
    );
    expect(policy.companyWorkItemId).toBeUndefined();
    expect(policy.governance).toBeUndefined();
    expect(run.spec.budgetAccountId).toBe("acct-1");
    expect(run.spec.steps).toHaveLength(6);
    expect(fx.wakes.length).toBe(1);
    const profileId = policy.stepGovernance["user-research"].profileId as string;
    const workspaceId = policy.stepGovernance["user-research"].workspace.id as string;
    expect(
      fx.db.prepare(
        `SELECT action, resource_kind AS resourceKind, effect
         FROM core_grants
         WHERE subject_kind = 'agent_profile' AND subject_id = ?
           AND action = 'agent.run' AND resource_kind = 'workspace'`,
      ).get(profileId),
    ).toEqual({ action: "agent.run", resourceKind: "workspace", effect: "allow" });
    expect(
      (
        fx.db.prepare(
          `SELECT resource_scope_json AS scope FROM core_grants
           WHERE subject_id = ? AND action = 'agent.run'`,
        ).get(profileId) as { scope: string }
      ).scope,
    ).toContain(workspaceId);

    const instance = fx.db
      .prepare(`SELECT state, trigger_ref AS triggerRef, run_id AS runId FROM core_workflow_instances WHERE id = ?`)
      .get(first.instanceId) as { state: string; triggerRef: string; runId: string };
    expect(instance).toEqual({
      state: "running",
      triggerRef: `company-workflow:requirement-research:${fx.companyId}:${fx.projectId}:idea-1`,
      runId: first.runId,
    });

    const second = await startCompanyResearchWorkflow(fx.deps, fx.base);
    expect(second).toEqual({ ...first, reused: true });
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM core_runs`).get()).toEqual({ n: 1 });
  });

  it("serialises concurrent starts with the same idempotency key", async () => {
    const fx = await researchDispatchFixture();
    const [a, b] = await Promise.all([
      startCompanyResearchWorkflow(fx.deps, fx.base),
      startCompanyResearchWorkflow(fx.deps, fx.base),
    ]);
    expect(a.runId).toBe(b.runId);
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
  });

  it("rejects reusing an idempotency key with a different brief", async () => {
    const fx = await researchDispatchFixture();
    await startCompanyResearchWorkflow(fx.deps, fx.base);
    await expect(
      startCompanyResearchWorkflow(fx.deps, { ...fx.base, briefId: "other-brief" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM core_runs`).get()).toEqual({ n: 1 });
  });

  it("allows a second idempotency key and republishes the same definition once", async () => {
    const fx = await researchDispatchFixture();
    const first = await startCompanyResearchWorkflow(fx.deps, fx.base);
    const other = await startCompanyResearchWorkflow(fx.deps, { ...fx.base, idempotencyKey: "idea-2" });
    expect(other.runId).not.toBe(first.runId);
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM core_workflow_versions`).get()).toEqual({ n: 1 });
  });

  it("rejects product-delivery starts in this milestone", async () => {
    const fx = await researchDispatchFixture();
    await expect(
      startCompanyResearchWorkflow(fx.deps, {
        ...fx.base,
        workflowId: "forge.company.product-delivery" as never,
      }),
    ).rejects.toThrow(/NOT_RUNNABLE|requirement-research/);
    await expect(
      startCompanyResearchWorkflow(fx.deps, {
        ...fx.base,
        workflowId: "forge.company.product-delivery" as never,
      }),
    ).rejects.toBeInstanceOf(CompanyWorkflowStartError);
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM core_runs`).get()).toEqual({ n: 0 });
  });

  it("fails closed without publishing when governance cannot be built", async () => {
    const fx = await researchDispatchFixture({ noEmployee: true });
    await expect(startCompanyResearchWorkflow(fx.deps, fx.base)).rejects.toThrow(/POLICY_DENIED/);
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM core_workflow_versions`).get()).toEqual({ n: 0 });
    expect(fx.db.prepare(`SELECT COUNT(*) AS n FROM core_runs`).get()).toEqual({ n: 0 });
  });

  it("ensures a company budget binding before governance when a ledger is provided", async () => {
    const fx = await researchDispatchFixture();
    fx.db.prepare(`DELETE FROM company_budget_bindings WHERE company_id = ?`).run(fx.companyId);
    const created: string[] = [];
    const started = await startCompanyResearchWorkflow(
      {
        ...fx.deps,
        companyName: "曜石",
        budgetLedger: {
          createAccount: (account) => {
            created.push(account.id);
            fx.db.prepare(
              `INSERT INTO core_budget_accounts (
                id, parent_account_id, name, currency, hard_limit_minor, soft_limit_minor,
                created_at, updated_at
              ) VALUES (?, NULL, ?, ?, ?, NULL, ?, ?)`,
            ).run(
              account.id,
              account.name,
              account.currency,
              Number(account.hardLimitMinor),
              clock.now(),
              clock.now(),
            );
          },
        },
      },
      { ...fx.base, idempotencyKey: "idea-budget-ensure" },
    );
    expect(started.reused).toBe(false);
    expect(created).toEqual([`budget:${fx.companyId}`]);
    expect(
      fx.db.prepare(
        `SELECT account_id AS accountId FROM company_budget_bindings WHERE company_id = ?`,
      ).get(fx.companyId),
    ).toEqual({ accountId: `budget:${fx.companyId}` });
    expect(fx.executionStore.getRun(started.runId)?.spec.budgetAccountId).toBe(`budget:${fx.companyId}`);
  });

  it("rejects briefs that are unknown, not ready, or from another project", async () => {
    const fx = await researchDispatchFixture();
    await expect(
      startCompanyResearchWorkflow(fx.deps, { ...fx.base, briefId: "missing" }),
    ).rejects.toThrow(/brief not found/);
    await expect(
      startCompanyResearchWorkflow(fx.deps, { ...fx.base, projectId: "other-project" }),
    ).rejects.toThrow(/does not belong/);
    const notReady = await researchDispatchFixture({ notReady: true });
    await expect(startCompanyResearchWorkflow(notReady.deps, notReady.base)).rejects.toThrow(/not ready/);
  });

  it("falls back to a researcher default when a branch has no specialist", async () => {
    const fx = await researchDispatchFixture({ noEmployee: true });
    const org = new OrganizationService(fx.db, clock);
    const companyId = fx.companyId;
    const department = org.createDepartment({ companyId, name: "经营部" });
    const hire = (input: { name: string; role: string; profileId: string; title: string }) => {
      const template = org.createPositionTemplate({ companyId, name: input.title, charter: input.role });
      const position = org.createPosition({
        companyId, departmentId: department.id, templateId: template.id, title: input.title,
      });
      const employee = org.hire({
        companyId, displayName: input.name, positionId: position.id, autonomyLevel: 2,
      });
      org.bindCapability({
        companyId,
        employeeId: employee.id,
        talentTemplateId: `tpl-${input.profileId}`,
        talentRole: input.role,
        skills: [],
        tools: [],
        agentProfileId: input.profileId,
        agentProfileVersionId: `${input.profileId}-v1`,
        workspaces: [{ workspaceId: "ws-a", mode: "write", isDefault: true }],
      });
      return employee.id;
    };
    hire({ name: "苏衡", role: "高级开发工程师", profileId: "profile-dev", title: "高级开发工程师" });
    hire({ name: "闻启", role: "Trend 研究员", profileId: "profile-researcher", title: "研究员" });

    const started = await startCompanyResearchWorkflow(fx.deps, fx.base);
    const governance = (fx.executionStore.getRun(started.runId)!.spec.policyContext as {
      stepGovernance: Record<string, { profileId: string }>;
    }).stepGovernance;

    // No marketer / legal → market & risk fall back to researcher default, not the developer.
    expect(governance["user-research"].profileId).toBe("profile-researcher");
    expect(governance["market-research"].profileId).toBe("profile-researcher");
    expect(governance["risk-research"].profileId).toBe("profile-researcher");
    expect(governance["code-data-research"].profileId).toBe("profile-dev");
    expect(governance.synthesis.profileId).toBe("profile-researcher");
  });

  it("assigns research branches to matching specialists instead of one developer for all steps", async () => {
    const fx = await researchDispatchFixture({ noEmployee: true });
    const org = new OrganizationService(fx.db, clock);
    const companyId = fx.companyId;
    const department = org.createDepartment({ companyId, name: "经营部" });
    const hire = (input: {
      name: string;
      role: string;
      profileId: string;
      title: string;
    }) => {
      const template = org.createPositionTemplate({
        companyId,
        name: input.title,
        charter: input.role,
      });
      const position = org.createPosition({
        companyId,
        departmentId: department.id,
        templateId: template.id,
        title: input.title,
      });
      const employee = org.hire({
        companyId,
        displayName: input.name,
        positionId: position.id,
        autonomyLevel: 2,
      });
      org.bindCapability({
        companyId,
        employeeId: employee.id,
        talentTemplateId: `tpl-${input.profileId}`,
        talentRole: input.role,
        skills: [],
        tools: [],
        agentProfileId: input.profileId,
        agentProfileVersionId: `${input.profileId}-v1`,
        workspaces: [{ workspaceId: "ws-a", mode: "write", isDefault: true }],
      });
      return employee.id;
    };
    // Hire developer first so a naive "first eligible" policy would pick them for every step.
    const developerId = hire({
      name: "苏衡",
      role: "高级开发工程师",
      profileId: "profile-dev",
      title: "高级开发工程师",
    });
    const researcherId = hire({
      name: "闻启",
      role: "Trend 研究员",
      profileId: "profile-researcher",
      title: "研究员",
    });
    const marketerId = hire({
      name: "韩舟",
      role: "市场营销专家",
      profileId: "profile-market",
      title: "市场营销",
    });
    const legalId = hire({
      name: "沈律",
      role: "法律合规检查员",
      profileId: "profile-legal",
      title: "合规",
    });

    const started = await startCompanyResearchWorkflow(fx.deps, fx.base);
    const governance = (fx.executionStore.getRun(started.runId)!.spec.policyContext as {
      stepGovernance: Record<string, { profileId: string }>;
    }).stepGovernance;

    expect(governance["user-research"].profileId).toBe("profile-researcher");
    expect(governance["market-research"].profileId).toBe("profile-market");
    expect(governance["code-data-research"].profileId).toBe("profile-dev");
    expect(governance["risk-research"].profileId).toBe("profile-legal");
    expect(governance.synthesis.profileId).toBe("profile-researcher");
    expect(governance["research-gate"].profileId).toBe("profile-researcher");
    expect(developerId).toBeTruthy();
    expect(researcherId).toBeTruthy();
    expect(marketerId).toBeTruthy();
    expect(legalId).toBeTruthy();
  });

  it("assigns research branches by operating seat title before talentRole fuzzy match", async () => {
    const fx = await researchDispatchFixture({ noEmployee: true });
    const org = new OrganizationService(fx.db, clock);
    const companyId = fx.companyId;
    const department = org.createDepartment({ companyId, name: "经营部" });
    const hire = (input: {
      name: string;
      role: string;
      profileId: string;
      title: string;
    }) => {
      const template = org.createPositionTemplate({
        companyId,
        name: input.title,
        charter: input.role,
      });
      const position = org.createPosition({
        companyId,
        departmentId: department.id,
        templateId: template.id,
        title: input.title,
      });
      const employee = org.hire({
        companyId,
        displayName: input.name,
        positionId: position.id,
        autonomyLevel: 2,
      });
      org.bindCapability({
        companyId,
        employeeId: employee.id,
        talentTemplateId: `tpl-${input.profileId}`,
        talentRole: input.role,
        skills: [],
        tools: [],
        agentProfileId: input.profileId,
        agentProfileVersionId: `${input.profileId}-v1`,
        workspaces: [{ workspaceId: "ws-a", mode: "write", isDefault: true }],
      });
      return employee.id;
    };
    // Seat titles drive routing: 市场调查员→user, 增长运营→market — even if talentRole also says 市场.
    hire({
      name: "闻启",
      role: "Trend 研究员",
      profileId: "profile-researcher",
      title: "市场调查员",
    });
    hire({
      name: "韩舟",
      role: "市场营销专家",
      profileId: "profile-market",
      title: "增长运营",
    });
    hire({
      name: "苏衡",
      role: "高级开发工程师",
      profileId: "profile-dev",
      title: "执行工程师",
    });
    hire({
      name: "沈律",
      role: "法律合规检查员",
      profileId: "profile-legal",
      title: "财务合规",
    });

    const started = await startCompanyResearchWorkflow(fx.deps, fx.base);
    const governance = (fx.executionStore.getRun(started.runId)!.spec.policyContext as {
      stepGovernance: Record<string, { profileId: string }>;
    }).stepGovernance;

    expect(governance["user-research"].profileId).toBe("profile-researcher");
    expect(governance["market-research"].profileId).toBe("profile-market");
    expect(governance["code-data-research"].profileId).toBe("profile-dev");
    expect(governance["risk-research"].profileId).toBe("profile-legal");
    expect(governance.synthesis.profileId).toBe("profile-researcher");
  });

  it("honours explicit assignments and rejects unknown employees", async () => {
    const fx = await researchDispatchFixture();
    const steps = ["user-research", "market-research", "code-data-research", "risk-research", "synthesis", "research-gate"];
    const assignments = Object.fromEntries(steps.map((id) => [id, fx.employeeId]));
    await expect(startCompanyResearchWorkflow(fx.deps, { ...fx.base, assignments })).resolves.toMatchObject({
      reused: false,
    });
    await expect(
      startCompanyResearchWorkflow(fx.deps, {
        ...fx.base,
        idempotencyKey: "idea-3",
        assignments: { ...assignments, synthesis: "ghost" },
      }),
    ).rejects.toThrow(/POLICY_DENIED/);
  });

  it("requires a non-empty idempotency key", async () => {
    const fx = await researchDispatchFixture();
    await expect(
      startCompanyResearchWorkflow(fx.deps, { ...fx.base, idempotencyKey: "  " }),
    ).rejects.toThrow(/INVALID_REQUEST/);
  });
});

describe("buildProductionGovernedInput step governance", () => {
  const stepGov = (profileId: string) => ({
    profileId,
    profileVersionId: `${profileId}-v1`,
    action: "agent.run",
    resource: { kind: "workspace", id: "ws" },
    risk: "low",
    workspace: { id: "ws", rootPath: "/tmp/ws", mode: "read" },
    budget: { accountId: "acct", amountMinor: 5 },
  });
  const call = (policyContext: Record<string, unknown>) =>
    buildProductionGovernedInput(
      { runId: "r", stepId: "s1", id: "a", attemptNumber: 1 } as never,
      { id: "s1", kind: "k", input: {}, timeoutMs: 1 } as never,
      { id: "r", spec: { policyContext, actingSubject: { kind: "agent_profile", id: "x" } } } as never,
      { getLatestResolvedWait: () => undefined } as never,
    );

  it("prefers stepGovernance[step.id] over run-level governance", () => {
    const input = call({
      governance: stepGov("run-level"),
      stepGovernance: { s1: stepGov("step-level") },
    });
    expect(input?.profileId).toBe("step-level");
    expect(input?.workspaceMode).toBe("read");
  });

  it("falls back to run-level governance when the step has no entry", () => {
    expect(call({ governance: stepGov("run-level"), stepGovernance: { other: stepGov("o") } })?.profileId)
      .toBe("run-level");
  });

  it("returns null when neither is present", () => {
    expect(call({ stepGovernance: { other: stepGov("o") } })).toBeNull();
  });
});
