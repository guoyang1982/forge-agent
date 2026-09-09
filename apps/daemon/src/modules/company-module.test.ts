import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompanyService,
  OrganizationService,
  WorkGates,
  WorkService,
} from "@forge/company-domain";
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

  it("moves a linked run through independent approval to accepted", async () => {
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
    ).toEqual({ state: "accepted" });
    expect(
      store.db.prepare("SELECT reason FROM company_decisions WHERE work_item_id = ?").get(workItem.id),
    ).toEqual({ reason: "Acceptance checks passed" });
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
          WHERE item.id = ?`,
        )
        .get(workItem.id),
    ).toEqual({
      state: "rejected",
      reason: "Missing acceptance evidence",
    });
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

    const error = await router
      .handleUntyped(
        DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
        { workItemId: workItem.id },
        rpcContext(),
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/plan not accepted/);
  });

  it("reuses an existing empty run request for the accepted plan", async () => {
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
    const plan = company.gates.upsertDraft({
      workItemId: workItem.id,
      kind: "plan",
      content: "Implement accepted behavior",
      actorId: owner.id,
    });
    company.gates.acceptArtifact({ artifactId: plan.id, actorId: owner.id });

    await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    );
    await router.handleUntyped(
      DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN,
      { workItemId: workItem.id },
      rpcContext(),
    );

    expect(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM company_run_links
          WHERE work_item_id = ? AND plan_artifact_id = ? AND run_id = ''`,
        )
        .get(workItem.id, plan.id),
    ).toEqual({ count: 1 });
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
      trace: {
        workItemId: workItem.id,
        specVersion: 1,
        runIds: ["run_123"],
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

function companyRouterFixture(options: { artifactRoot?: true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-company-module-"));
  fixtureRoots.push(root);
  const artifactRoot = join(root, "company");
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const clock = { now: () => "2026-09-09T09:00:00.000Z" };
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
  const context = {
    socketPath: join(root, "daemon.sock"),
    store,
    serverVersion: "0.2.0-test",
    build: "company-module-test",
    company,
  } satisfies Pick<
    ForgeDaemonContext,
    "socketPath" | "store" | "serverVersion" | "build" | "company"
  >;
  const router = new TypedRouter();
  createCompanyModule().register(router, context);
  return {
    router,
    company,
    store,
    artifactRoot,
  };
}

function rpcContext() {
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    emitAgentEvent: () => {},
  };
}
