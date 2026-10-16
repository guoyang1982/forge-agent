import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompanyService,
  OrganizationService,
  ReleaseService,
  StageGateService,
  WorkGates,
  WorkService,
  acceptBrief,
  createDeliveryProject,
  synthesizeResearch,
  validateHandoff,
} from "@forge/company-domain";
import {
  ValidationService,
  ValidatorRegistry,
  createDeliveryValidatorBundle,
} from "@forge/evidence";
import { DAEMON_COMPANY_METHODS } from "@forge/protocol";
import { ForgeStore } from "@forge/store";
import { AgentProfileStore } from "@forge/agent-profile";
import { ExecutionStore } from "@forge/execution";
import { BudgetLedgerService } from "@forge/usage-ledger";
import { WorkspaceGroupService, WorkspaceLeaseService } from "@forge/workspace";
import { createProductDeliveryWorkflow } from "@forge/workflows";
import { TypedRouter } from "./host/router.js";
import type { ForgeDaemonContext } from "./modules/context.js";
import { createCompanyModule } from "./modules/company-module.js";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "migrations",
);

export const clock = { now: () => "2026-09-11T12:00:00.000Z" };

export function openCompanyE2eFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-company-p1-e2e-"));
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const executionClock = {
    now: () => clock.now(),
    nowMs: () => Date.parse(clock.now()),
  };
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
    build: "company-p1-e2e",
    company,
    executionStore: new ExecutionStore(store.db),
    executionClock,
    agentProfiles: new AgentProfileStore(store.db),
    budgetLedger: new BudgetLedgerService(store.db),
    workspaceGroups: new WorkspaceGroupService(store.db),
    workspaceLeases: new WorkspaceLeaseService(store.db),
    wakeExecutor: () => {},
  } satisfies Pick<
    ForgeDaemonContext,
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
  >;
  const router = new TypedRouter();
  createCompanyModule({
    generateDraft: async () => {
      throw new Error("model unavailable");
    },
    listSharedProjects: () => [],
    listModelProfiles: () => [],
  }).register(router, context);
  return {
    root,
    store,
    company,
    router,
    stages: new StageGateService(store.db),
    releases: new ReleaseService(store.db, clock),
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function hireNamed(
  company: ReturnType<typeof openCompanyE2eFixture>["company"],
  companyId: string,
  name: string,
) {
  const department = company.org.createDepartment({
    companyId,
    name: `${name}部`,
  });
  const template = company.org.createPositionTemplate({
    companyId,
    name,
    charter: name,
  });
  const position = company.org.createPosition({
    companyId,
    departmentId: department.id,
    templateId: template.id,
    title: name,
  });
  return company.org.hire({
    companyId,
    displayName: name,
    positionId: position.id,
    autonomyLevel: 2,
  });
}

export function rpcContext() {
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    emitAgentEvent: () => {},
  };
}

export { acceptBrief, createDeliveryProject, synthesizeResearch, validateHandoff };
export { ValidationService, ValidatorRegistry, createDeliveryValidatorBundle };
export { createProductDeliveryWorkflow };
export { DAEMON_COMPANY_METHODS };
