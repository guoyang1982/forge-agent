import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileStore } from "@forge/agent-profile";
import {
  CompanyService,
  OrganizationService,
  WorkGates,
  WorkService,
  acceptBrief,
  bindCompanyBudgetAccount,
} from "@forge/company-domain";
import { ValidationService } from "@forge/evidence";
import { ManualTestClock, type ForgeAgentRunFn } from "@forge/execution";
import { ApprovalService } from "@forge/policy";
import { DAEMON_COMPANY_METHODS, type CompanyWorkflowCapability } from "@forge/protocol";
import { ForgeStore } from "@forge/store";
import { BudgetLedgerService } from "@forge/usage-ledger";
import { WorkspaceGroupService, WorkspaceLeaseService } from "@forge/workspace";
import { TypedRouter } from "./host/router.js";
import type { ForgeDaemonContext } from "./modules/context.js";
import { createCompanyModule } from "./modules/company-module.js";
import { readForgeRunResult } from "./services/forge-run-results.js";
import { createProductionExecutionComposition } from "./services/production-execution-composition.js";
import { createProductionValidatorRegistry } from "./services/production-validators.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const BRANCH_REPLY = JSON.stringify({
  claims: [{ text: "SMB 运营有明确痛点", classification: "fact", evidenceRefs: ["ev-1"] }],
  evidenceRefs: ["ev-1"],
  unknowns: [],
});

function rpcContext() {
  return { requestId: "request-1", correlationId: "correlation-1", emitAgentEvent: () => {} };
}

/** Production composition (governed, real durable executor) with a deterministic fake model run. */
function researchWorkflowFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-research-workflow-e2e-"));
  const store = ForgeStore.open({ dbPath: join(root, "data.db"), migrationsDir, owner: "test" });
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const clock = new ManualTestClock(new Date().toISOString()) /* budget/lease services use wall-clock expiry */;
  const domainClock = { now: () => clock.now() };
  store.db
    .prepare(
      `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
       VALUES ('policy-v1', 'default', 1, '{}', 1, ?)`,
    )
    .run(clock.now());

  const agentProfiles = new AgentProfileStore(store.db);
  const profile = agentProfiles.publishVersion({ name: "researcher", model: "forge-default" });
  // External user authorization: the employee's profile may run in the granted workspace.
  store.db
    .prepare(
      `INSERT INTO core_subjects (kind, subject_id, display_name, created_at, updated_at)
       VALUES ('agent_profile', ?, 'researcher', ?, ?)`,
    )
    .run(profile.profileId, clock.now(), clock.now());
  store.db
    .prepare(
      `INSERT INTO core_grants (
         id, subject_kind, subject_id, policy_version_id, action, resource_kind,
         resource_scope_json, effect, created_at
       ) VALUES ('grant-research', 'agent_profile', ?, 'policy-v1', 'agent.run', 'workspace', ?, 'allow', ?)`,
    )
    .run(profile.profileId, JSON.stringify({ resourceIds: ["ws-a"] }), clock.now());
  const budgetLedger = new BudgetLedgerService(store.db);
  budgetLedger.createAccount({ id: "acct-1", name: "company", currency: "USD", hardLimitMinor: 100_000_000n });
  const workspaceGroups = new WorkspaceGroupService(store.db);
  const workspaceLeases = new WorkspaceLeaseService(store.db);
  const validations = new ValidationService(store.db, createProductionValidatorRegistry());

  const prompts: string[] = [];
  const cwds: string[] = [];
  const run: ForgeAgentRunFn = async (request) => {
    prompts.push(request.message);
    cwds.push(request.cwd);
    const branch = /Research branch: ([\w-]+)/.exec(request.message)?.[1] ?? "unknown";
    return { sessionId: `session-${branch}`, finalText: BRANCH_REPLY };
  };
  const composition = createProductionExecutionComposition({
    db: store.db,
    clock,
    run,
    broadcast: () => {},
    governance: {
      profiles: agentProfiles,
      approvals: new ApprovalService(store.db),
      budgets: budgetLedger,
      leases: workspaceLeases,
      validations,
    },
  });

  const company = {
    companies: new CompanyService(store.db, domainClock),
    org: new OrganizationService(store.db, domainClock),
    work: new WorkService(store.db, domainClock),
    gates: new WorkGates(store.db, domainClock),
  };
  let wakeCount = 0;
  const context = {
    socketPath: join(root, "daemon.sock"),
    store,
    serverVersion: "0.2.0-test",
    build: "research-workflow-e2e",
    company,
    executionStore: composition.executionStore,
    executionClock: clock,
    executor: composition.executor,
    agentProfiles,
    budgetLedger,
    workspaceGroups,
    workspaceLeases,
    validations,
    companyWorkflowCapabilities: composition.companyWorkflowCapabilities,
    wakeExecutor: () => {
      wakeCount += 1;
    },
  } as unknown as ForgeDaemonContext;
  const router = new TypedRouter();
  createCompanyModule({
    generateDraft: async () => {
      throw new Error("model unavailable");
    },
    listSharedProjects: () => [],
    listModelProfiles: () => [],
  }).register(router, context);

  const created = company.companies.create({ name: "曜石" });
  const department = company.org.createDepartment({ companyId: created.id, name: "研究部" });
  const template = company.org.createPositionTemplate({ companyId: created.id, name: "研究员", charter: "research" });
  const position = company.org.createPosition({
    companyId: created.id,
    departmentId: department.id,
    templateId: template.id,
    title: "研究员",
  });
  const employee = company.org.hire({
    companyId: created.id,
    displayName: "研究员甲",
    positionId: position.id,
    autonomyLevel: 2,
  });
  const wsPath = join(root, "ws-a");
  mkdirSync(wsPath);
  workspaceGroups.registerWorkspace({ id: "ws-a", rootPath: wsPath });
  company.org.bindCapability({
    companyId: created.id,
    employeeId: employee.id,
    talentTemplateId: "tpl",
    talentRole: "researcher",
    skills: [],
    tools: [],
    agentProfileId: profile.profileId,
    agentProfileVersionId: profile.id,
    workspaces: [{ workspaceId: "ws-a", mode: "write", isDefault: true }],
  });
  bindCompanyBudgetAccount(store.db, { companyId: created.id, accountId: "acct-1", createdAt: clock.now() });
  const goal = company.work.createGoal({ companyId: created.id, title: "G", ownerId: employee.id });
  const project = company.work.createProject({ companyId: created.id, goalId: goal.id, title: "P" });
  const item = company.work.createWorkItem({
    companyId: created.id,
    projectId: project.id,
    type: "research",
    title: "调研",
    problem: "转化低",
    expectedOutcome: "明确是否进入研发",
    ownerId: employee.id,
  });
  const brief = acceptBrief(store.db, domainClock, {
    companyId: created.id,
    workItemId: item.id,
    problem: "转化低",
    targetUser: "SMB 运营",
    expectedOutcome: "明确是否进入研发",
  });

  /** Tick the real durable executor until nothing else is claimable. */
  async function drive(maxTicks = 20) {
    for (let i = 0; i < maxTicks; i += 1) {
      if ((await composition.executor.tick()) === 0) return;
    }
    throw new Error("executor did not settle");
  }

  return {
    store,
    router,
    clock,
    composition,
    prompts,
    cwds,
    wsPath,
    companyId: created.id,
    projectId: project.id,
    briefId: brief.id,
    employeeId: employee.id,
    drive,
    wakeCount: () => wakeCount,
    stepStates(runId: string) {
      return Object.fromEntries(
        (store.db.prepare(`SELECT id, state FROM core_steps WHERE run_id = ? ORDER BY id`).all(runId) as Array<{
          id: string;
          state: string;
        }>).map((row) => [row.id, row.state]),
      );
    },
    readOutput(runId: string, stepId: string) {
      const outputRef = (store.db
        .prepare(
          `SELECT output_ref AS outputRef FROM core_attempts
            WHERE run_id = ? AND step_id = ? AND state = 'succeeded' ORDER BY attempt_number DESC LIMIT 1`,
        )
        .get(runId, stepId) as { outputRef: string } | undefined)?.outputRef;
      expect(outputRef).toBeTruthy();
      return JSON.parse(readForgeRunResult(store.db, outputRef!)!.finalText);
    },
  };
}

describe("requirement-research workflow e2e", () => {
  it("starts, runs branches and synthesis, waits at the gate, resumes after a decision and succeeds", async () => {
    const fx = researchWorkflowFixture();

    const capabilities = (await fx.router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORKFLOW_CAPABILITIES,
      {},
      rpcContext(),
    )) as CompanyWorkflowCapability[];
    expect(capabilities.find((c) => c.workflowId === "forge.company.requirement-research")).toMatchObject({
      runnable: true,
      blockers: [],
    });
    expect(capabilities.find((c) => c.workflowId === "forge.company.product-delivery")?.runnable).toBe(false);

    const started = (await fx.router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORKFLOWS_START,
      {
        companyId: fx.companyId,
        projectId: fx.projectId,
        workflowId: "forge.company.requirement-research",
        briefId: fx.briefId,
        idempotencyKey: "idea-1",
      },
      rpcContext(),
    )) as { runId: string; instanceId: string; reused: boolean };
    expect(started.reused).toBe(false);
    expect(fx.wakeCount()).toBe(1);

    await fx.drive();

    // Branches ran through the real governed executor, read-only in the granted workspace.
    expect(fx.stepStates(started.runId)).toMatchObject({
      "code-data-research": "succeeded",
      "market-research": "succeeded",
      "risk-research": "succeeded",
      "user-research": "succeeded",
      synthesis: "succeeded",
      "research-gate": "waiting",
    });
    expect(fx.prompts).toHaveLength(5);
    expect(new Set(fx.cwds)).toEqual(new Set([fx.wsPath]));
    expect(fx.composition.executionStore.getRun(started.runId)?.state).not.toBe("succeeded");
    expect(fx.readOutput(started.runId, "synthesis").recommendation).toBe("enter_product_definition");

    // Gate wait is real: the coordinator reports readiness only once synthesis + wait exist.
    fx.clock.advanceBy(1_000);
    const snapshot = (await fx.router.handleUntyped(
      DAEMON_COMPANY_METHODS.DELIVERY_GATES_SNAPSHOT,
      { companyId: fx.companyId, projectId: fx.projectId, gate: "research" },
      rpcContext(),
    )) as { ready: boolean; inputVersionRefs: string[] };
    expect(snapshot.ready).toBe(true);

    const decided = (await fx.router.handleUntyped(
      DAEMON_COMPANY_METHODS.DELIVERY_GATES_DECIDE,
      {
        id: "research-decision-1",
        companyId: fx.companyId,
        projectId: fx.projectId,
        gate: "research",
        outcome: "approved",
        inputVersionRefs: snapshot.inputVersionRefs,
        decidedBy: { kind: "employee", id: fx.employeeId },
        rationale: "桌面研究足够，进入需求设计",
        impact: "进入产品定义",
      },
      rpcContext(),
    )) as { nextAction: string };
    expect(decided.nextAction).toBe("enter_product_definition");
    expect(fx.wakeCount()).toBe(2);
    expect(fx.stepStates(started.runId)["research-gate"]).toBe("runnable");

    await fx.drive();
    expect(fx.stepStates(started.runId)["research-gate"]).toBe("succeeded");
    expect(fx.composition.executionStore.getRun(started.runId)?.state).toBe("succeeded");
    expect(fx.readOutput(started.runId, "research-gate")).toMatchObject({
      decisionId: "research-decision-1",
      outcome: "approved",
      nextAction: "enter_product_definition",
      projectId: fx.projectId,
    });

    // Idempotent re-start attaches to the finished run instead of creating another.
    const again = (await fx.router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORKFLOWS_START,
      {
        companyId: fx.companyId,
        projectId: fx.projectId,
        workflowId: "forge.company.requirement-research",
        briefId: fx.briefId,
        idempotencyKey: "idea-1",
      },
      rpcContext(),
    )) as { runId: string; reused: boolean };
    expect(again).toMatchObject({ runId: started.runId, reused: true });
  });

  it("rejects starting product-delivery", async () => {
    const fx = researchWorkflowFixture();
    await expect(
      fx.router.handleUntyped(
        DAEMON_COMPANY_METHODS.WORKFLOWS_START,
        {
          companyId: fx.companyId,
          projectId: fx.projectId,
          workflowId: "forge.company.product-delivery",
          briefId: fx.briefId,
          idempotencyKey: "nope",
        },
        rpcContext(),
      ),
    ).rejects.toThrow();
  });
});
