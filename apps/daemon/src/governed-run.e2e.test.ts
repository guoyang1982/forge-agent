import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileStore } from "@forge/agent-profile";
import {
  ArtifactService,
  layerValidator,
  ValidationService,
  ValidatorRegistry,
} from "@forge/evidence";
import {
  GovernedStepExecutor,
  ManualTestClock,
  succeeded,
  type GovernedExecutionPorts,
  type GovernedStepExecutionInput,
  type StepExecutor,
  DurableExecutor,
  ExecutionStore,
  StepExecutorRegistry,
} from "@forge/execution";
import { EventStore } from "@forge/event-store";
import { ApprovalService } from "@forge/policy";
import { V2_RPC_METHODS } from "@forge/protocol";
import { ForgeStore } from "@forge/store";
import { BudgetLedgerService } from "@forge/usage-ledger";
import { WorkspaceGroupService } from "@forge/workspace";
import { TypedRouter } from "./host/router.js";
import type { ForgeDaemonContext } from "./modules/context.js";
import { createDaemonModules } from "./modules/index.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("governed run e2e", () => {
  it("registers governance RPC methods", () => {
    const router = new TypedRouter();
    const context = {} as ForgeDaemonContext;
    for (const module of createDaemonModules(context)) {
      module.register(router, context);
    }

    for (const method of [
      "workspace.groups.create",
      "workspace.groups.bind",
      "workspace.groups.listBindings",
      "approvals.list",
      "approvals.decide",
      "budgets.get",
      "artifacts.get",
      "validations.list",
      "agentProfiles.publish",
      "agentProfiles.resolve",
    ]) {
      expect(V2_RPC_METHODS).toContain(method);
      expect(router.methods()).toContain(method);
    }
  });

  it("pauses a high-risk step, resumes after matching approval, and stores validation", async () => {
    const fx = await governedDaemonFixture();
    const run = await fx.createHighRiskRun();
    const approval = await fx.waitForApproval(run.runId);
    await fx.approve(approval.id, approval.parametersHash);
    await fx.resumeAfterApproval(run.runId, approval.id);
    expect(await fx.waitForRun(run.runId, "succeeded")).toBe("succeeded");
    expect(await fx.validations(run.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: "result", status: "passed" }),
      ]),
    );
  });
});

async function governedDaemonFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-governed-run-e2e-"));
  fixtureRoots.push(root);
  const clock = new ManualTestClock("2099-01-01T00:00:00.000Z");
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  forgeStore.db
    .prepare(
      `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
       VALUES ('policy-v1', 'default', 1, '{}', 1, ?)`,
    )
    .run(clock.now());
  const store = new ExecutionStore(forgeStore.db);
  const events = new EventStore(forgeStore.db);
  const workspaceGroups = new WorkspaceGroupService(forgeStore.db);
  const approvals = new ApprovalService(forgeStore.db);
  const budgetLedger = new BudgetLedgerService(forgeStore.db);
  budgetLedger.createAccount({
    id: "budget-1",
    name: "run budget",
    currency: "USD",
    hardLimitMinor: 10_000n,
  });
  const agentProfiles = new AgentProfileStore(forgeStore.db);
  const profileVersion = agentProfiles.publishVersion({
    name: "governed-agent",
    model: "forge-default",
  });
  const artifacts = new ArtifactService(forgeStore.db, join(root, "artifacts"));
  const validatorRegistry = new ValidatorRegistry();
  validatorRegistry.register(
    layerValidator({
      id: "result-check",
      layer: "result",
      status: "passed",
      summary: "result validated",
    }),
  );
  const validations = new ValidationService(forgeStore.db, validatorRegistry);

  const router = new TypedRouter();
  let wakeCount = 0;
  const context = {
    executionStore: store,
    eventStore: events,
    executionClock: clock,
    workspaceGroups,
    approvals,
    budgetLedger,
    agentProfiles,
    artifacts,
    validations,
    wakeExecutor: () => {
      wakeCount += 1;
      void executor.tick();
    },
  } as unknown as ForgeDaemonContext;

  for (const module of createDaemonModules(context)) {
    module.register(router, context);
  }

  const stepRegistry = new StepExecutorRegistry();
  stepRegistry.register({
    kind: "high.risk",
    execute: async () => succeeded("artifact:delivery-1"),
  } satisfies StepExecutor);

  let policyDecision: "require_approval" | "allow" = "require_approval";
  const calls: string[] = [];
  const ports: GovernedExecutionPorts = {
    profile: {
      resolve: async () => {
        calls.push("profile.resolve");
        return agentProfiles.resolveSnapshot({
          profileId: profileVersion.profileId,
          profileVersionId: profileVersion.id,
        });
      },
    },
    workspace: {
      acquire: async () => {
        calls.push("workspace.acquire");
        return {
          id: "lease-1",
          workspaceId: "ws-1",
          runId: "run-governed",
          mode: "write",
          rootPath: root,
          acquiredAt: clock.now(),
          expiresAt: "2026-01-01T01:00:00.000Z",
        };
      },
      release: async () => {
        calls.push("workspace.release");
      },
    },
    policy: {
      authorize: () => {
        calls.push("policy.authorize");
        if (policyDecision === "require_approval") {
          return {
            outcome: "require_approval",
            policyVersionId: "policy-v1",
            reason: "high risk",
            approvalClass: "high_risk",
            inputHash: "hash",
          };
        }
        return {
          outcome: "allow",
          policyVersionId: "policy-v1",
          reason: "approved",
          inputHash: "hash",
        };
      },
    },
    approval: {
      requestApproval: (input) => {
        calls.push("approval.request");
        return approvals.requestApproval({
          ...input,
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      },
      getApproval: (approvalId) => approvals.getApproval(approvalId),
      consumeApproval: (approvalId) => {
        approvals.consumeApproval(approvalId);
      },
    },
    budget: {
      reserve: async (input) => {
        calls.push("budget.reserve");
        return budgetLedger.reserve(input);
      },
      commit: async (reservationId, amountMinor) => {
        calls.push("budget.commit");
        budgetLedger.commit(reservationId, amountMinor);
      },
      release: async (reservationId, reason) => {
        calls.push("budget.release");
        budgetLedger.release(reservationId, reason);
      },
    },
    evidence: {
      hasCoverage: () => true,
      validateDelivery: async (input) => {
        calls.push("evidence.validate");
        return validations.validateDelivery(input);
      },
    },
    step: {
      execute: async (input, signal) => {
        calls.push("step.execute");
        const executor = stepRegistry.get("high.risk");
        if (!executor) {
          throw new Error("missing step executor");
        }
        return executor.execute(input, signal);
      },
    },
  };

  const governedExecutor = new GovernedStepExecutor(ports, store, clock);
  const buildGovernedInput = (
    claimed: { runId: string; stepId: string; id: string; attemptNumber: number },
    step: { kind: string; input: unknown; idempotencyKey?: string; timeoutMs: number },
  ): GovernedStepExecutionInput => ({
    runId: claimed.runId,
    stepId: claimed.stepId,
    attemptId: claimed.id,
    attemptNumber: claimed.attemptNumber,
    kind: step.kind,
    input: step.input,
    idempotencyKey: step.idempotencyKey,
    timeoutMs: step.timeoutMs,
    profileId: profileVersion.profileId,
    profileVersionId: profileVersion.id,
    actingSubject: { kind: "agent", id: "agent-1" },
    action: "connector.publish",
    resource: { kind: "connector", id: "web" },
    risk: "high",
    policyContext: {},
    workspaceId: "ws-1",
    workspaceRootPath: root,
    budgetAccountId: "budget-1",
    budgetAmountMinor: 100n,
    budgetReservationId: `${claimed.id}:budget`,
    deliveryId: claimed.stepId,
  });

  const executor = new DurableExecutor(store, stepRegistry, clock, {
    governedExecutor,
    buildGovernedInput: (claimed, step, _run) => buildGovernedInput(claimed, step),
  });
  context.executor = executor;

  return {
    router,
    store,
    calls,
    wakeCount: () => wakeCount,
    async createHighRiskRun() {
      store.createRun(
        {
          id: "run-governed",
          requestedBy: { kind: "user", id: "u1" },
          actingSubject: { kind: "agent", id: "agent-1" },
          objective: "publish high risk content",
          correlationId: "corr-governed-1",
          policyContext: {},
          budgetAccountId: "budget-1",
          steps: [
            {
              id: "publish",
              kind: "high.risk",
              dependsOn: [],
              input: { channel: "web" },
              retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
              timeoutMs: 60_000,
            },
          ],
        },
        clock.now(),
      );
      await executor.tick();
      expect(calls).toContain("policy.authorize");
      expect(calls).toContain("approval.request");
      expect(store.getStep("run-governed", "publish")?.state).toBe("waiting");
      return { runId: "run-governed" };
    },
    async waitForApproval(runId: string) {
      const result = await router.handle(
        "approvals.list",
        { runId },
        rpcContext(),
      );
      expect(result.approvals).toHaveLength(1);
      return result.approvals[0]!;
    },
    async approve(approvalId: string, parametersHash: string) {
      policyDecision = "allow";
      return router.handle(
        "approvals.decide",
        {
          approvalId,
          decision: "approved",
          actor: { kind: "user", id: "u1" },
          parametersHash,
        },
        rpcContext(),
      );
    },
    async resumeAfterApproval(runId: string, approvalId: string) {
      const wait = store.getActiveWait(runId, "publish");
      expect(wait).not.toBeNull();
      executor.resumeWait(wait!.id, { approvalId, approved: true });
      await executor.tick();
    },
    async waitForRun(runId: string, state: string) {
      return store.getRun(runId)?.state;
    },
    async validations(runId: string) {
      const result = await router.handle(
        "validations.list",
        { runId },
        rpcContext(),
      );
      return result.validations;
    },
  };
}

function rpcContext() {
  return {
    requestId: "request-governed-1",
    correlationId: "correlation-governed-1",
    emitAgentEvent: () => {},
  };
}
