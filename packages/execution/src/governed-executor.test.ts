import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeStore } from "@forge/store";
import { ApprovalService } from "@forge/policy";
import { ManualTestClock } from "./clock.js";
import {
  GovernedStepExecutor,
  type GovernedExecutionPorts,
  type GovernedStepExecutionInput,
} from "./governed-executor.js";
import { succeeded } from "./executor-types.js";
import { ExecutionStore } from "./store.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("GovernedStepExecutor", () => {
  it("resolves profile, leases workspace, authorizes, reserves, executes, validates, then settles", async () => {
    const fx = governedFixture();
    await fx.executor.execute(fx.input, fx.signal);
    expect(fx.calls).toEqual([
      "profile.resolve",
      "workspace.acquire",
      "policy.authorize",
      "budget.reserve",
      "step.execute",
      "evidence.validate",
      "budget.commit",
      "workspace.release",
    ]);
  });

  it("passes the resolved versioned runtime policy to the underlying step", async () => {
    const fx = governedFixture();

    await fx.executor.execute(fx.input, fx.signal);

    expect(fx.stepRuntimePolicies).toEqual([
      {
        model: "profile-model",
        dynamicStatus: { modelHeartbeatIntervalMs: 25 },
        contextCompression: { triggerTokenEstimate: 100, tokenBudget: 50 },
      },
    ]);
  });

  it("waits without executing when approval is required", async () => {
    const fx = governedFixture({ decision: "require_approval" });
    const outcome = await fx.executor.execute(fx.input, fx.signal);
    expect(fx.calls).not.toContain("step.execute");
    expect(fx.calls).not.toContain("budget.reserve");
    expect(fx.store.getStep("r1", "s1")?.state).toBe("waiting");
    expect(outcome).toMatchObject({
      state: "waiting",
      waitReason: { kind: "approval", approvalId: expect.any(String) },
    });
    expect(fx.calls).toContain("workspace.release");
  });

  it("uses a resumed approved approval instead of opening another approval wait", async () => {
    const fx = governedFixture({ decision: "require_approval" });
    const approvalId = fx.approveMatchingRequest();
    const outcome = await fx.executor.execute(
      {
        ...fx.input,
        policyContext: { approvedApprovalId: approvalId },
      },
      fx.signal,
    );

    expect(outcome).toEqual({ state: "succeeded", outputRef: "output-1" });
    expect(fx.calls).not.toContain("approval.request");
    expect(fx.calls).toContain("step.execute");
  });

  it("releases workspace and budget reservations when policy denies", async () => {
    const fx = governedFixture({ decision: "deny" });
    const outcome = await fx.executor.execute(fx.input, fx.signal);
    expect(fx.calls).toEqual([
      "profile.resolve",
      "workspace.acquire",
      "policy.authorize",
      "workspace.release",
    ]);
    expect(fx.calls).not.toContain("budget.reserve");
    expect(fx.calls).not.toContain("step.execute");
    expect(outcome).toMatchObject({
      state: "failed",
      retryable: false,
    });
  });

  it("releases reserved budget when validation fails", async () => {
    const fx = governedFixture({ validationAccepted: false });
    const outcome = await fx.executor.execute(fx.input, fx.signal);
    expect(fx.calls).toContain("step.execute");
    expect(fx.calls).toContain("budget.release");
    expect(fx.calls).not.toContain("budget.commit");
    expect(outcome).toMatchObject({
      state: "failed",
      retryable: false,
    });
  });
});

function governedFixture(options?: {
  decision?: "allow" | "deny" | "require_approval";
  validationAccepted?: boolean;
}) {
  const calls: string[] = [];
  const stepRuntimePolicies: Array<unknown> = [];
  const root = mkdtempSync(join(tmpdir(), "forge-governed-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const store = new ExecutionStore(forgeStore.db);
  const approvals = new ApprovalService(forgeStore.db);
  const clock = new ManualTestClock("2026-01-01T00:00:00.000Z");
  forgeStore.db
    .prepare(
      `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
       VALUES ('policy-1', 'test-policy', 1, '{}', 1, ?)`,
    )
    .run(clock.now());

  store.createRun(
    {
      id: "r1",
      requestedBy: { kind: "user", id: "u1" },
      actingSubject: { kind: "agent", id: "a1" },
      objective: "publish",
      correlationId: "corr-1",
      policyContext: {},
      budgetAccountId: "budget-1",
      steps: [
        {
          id: "s1",
          kind: "publish",
          dependsOn: [],
          input: { channel: "web" },
          retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
          timeoutMs: 1000,
        },
      ],
    },
    clock.now(),
  );

  store.claimNextStep("r1", "worker-1", clock.now());

  const decision = options?.decision ?? "allow";
  const ports: GovernedExecutionPorts = {
    profile: {
      resolve: async () => {
        calls.push("profile.resolve");
        return {
          id: "snap-1",
          profileId: "p1",
          profileVersionId: "pv1",
          modelPolicy: { model: "forge-default" },
          runtime: {
            model: "profile-model",
            dynamicStatus: { modelHeartbeatIntervalMs: 25 },
            contextCompression: { triggerTokenEstimate: 100, tokenBudget: 50 },
          },
          skills: [],
          tools: [],
          knowledge: [],
          memoryScopes: [],
          connectors: [],
          policyVersionId: "policy-1",
          createdAt: clock.now(),
        };
      },
    },
    workspace: {
      acquire: async () => {
        calls.push("workspace.acquire");
        return {
          id: "lease-1",
          workspaceId: "ws-1",
          runId: "r1",
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
        if (decision === "deny") {
          return {
            outcome: "deny",
            policyVersionId: "policy-1",
            reason: "denied",
            inputHash: "hash",
          };
        }
        if (decision === "require_approval") {
          return {
            outcome: "require_approval",
            policyVersionId: "policy-1",
            reason: "approval required",
            approvalClass: "high_risk",
            inputHash: "hash",
          };
        }
        return {
          outcome: "allow",
          policyVersionId: "policy-1",
          reason: "allowed",
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
    },
    budget: {
      reserve: async () => {
        calls.push("budget.reserve");
        return {
          id: "reservation-1",
          accountId: "budget-1",
          runId: "r1",
          stepId: "s1",
          amountMinor: 100n,
          currency: "USD",
          state: "reserved",
          expiresAt: "2026-01-01T01:00:00.000Z",
          createdAt: clock.now(),
        };
      },
      commit: async () => {
        calls.push("budget.commit");
      },
      release: async () => {
        calls.push("budget.release");
      },
    },
    evidence: {
      validateDelivery: async () => {
        calls.push("evidence.validate");
        return { accepted: options?.validationAccepted ?? true };
      },
    },
    step: {
      execute: async (input) => {
        calls.push("step.execute");
        stepRuntimePolicies.push(input.runtimePolicy);
        return succeeded("output-1");
      },
    },
  };

  const executor = new GovernedStepExecutor(ports, store, clock);
  const attempt = store.listAttempts("r1", "s1")[0]!;
  const input: GovernedStepExecutionInput = {
    runId: "r1",
    stepId: "s1",
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    kind: "publish",
    input: { channel: "web" },
    timeoutMs: 1000,
    profileId: "p1",
    profileVersionId: "pv1",
    actingSubject: { kind: "agent", id: "a1" },
    action: "connector.publish",
    resource: { kind: "connector", id: "web" },
    risk: "high",
    policyContext: {},
    workspaceId: "ws-1",
    workspaceRootPath: root,
    budgetAccountId: "budget-1",
    budgetAmountMinor: 100n,
  };

  return {
    executor,
    calls,
    store,
    stepRuntimePolicies,
    input,
    signal: AbortSignal.timeout(1000),
    approveMatchingRequest: () => {
      const approval = approvals.requestApproval({
        subject: { kind: "agent", id: "a1" },
        action: "connector.publish",
        resource: { kind: "connector", id: "web" },
        parametersSummary: "connector.publish",
        risk: "high",
        policyVersionId: "policy-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        runId: "r1",
        stepId: "s1",
      });
      approvals.decide(approval.id, {
        decision: "approved",
        actor: { kind: "user", id: "u1" },
        parametersHash: approval.parametersHash,
      });
      return approval.id;
    },
  };
}
