import { mkdtempSync, rmSync } from "node:fs";
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

function companyRouterFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-company-module-"));
  fixtureRoots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const clock = { now: () => "2026-09-09T09:00:00.000Z" };
  const company = {
    companies: new CompanyService(store.db, clock),
    org: new OrganizationService(store.db, clock),
    work: new WorkService(store.db, clock),
    gates: new WorkGates(store.db, clock),
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
  return { router, company, store };
}

function rpcContext() {
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    emitAgentEvent: () => {},
  };
}
