import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileStore } from "@forge/agent-profile";
import {
  ValidationService,
  ValidatorRegistry,
} from "@forge/evidence";
import { ManualTestClock, type RunSpec } from "@forge/execution";
import { ApprovalService } from "@forge/policy";
import { ForgeStore } from "@forge/store";
import { BudgetLedgerService } from "@forge/usage-ledger";
import { WorkspaceGroupService, WorkspaceLeaseService } from "@forge/workspace";
import { createProductionExecutionComposition } from "./services/production-execution-composition.js";
import { createProductionValidatorRegistry } from "./services/production-validators.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production governance composition", () => {
  it.each(["workspace", "budget"] as const)(
    "fails before the side effect when %s governance is absent",
    async (missing) => {
      const fx = productionGovernanceFixture();
      await fx.execute({ missing });

      expect(fx.sideEffects()).toBe(0);
      expect(fx.runState()).toBe("failed");
    },
  );

  it("fails before the side effect when no applicable validator is registered", async () => {
    const fx = productionGovernanceFixture({ registerValidator: false });
    await fx.execute();

    expect(fx.sideEffects()).toBe(0);
    expect(fx.runState()).toBe("failed");
    expect(fx.validationCount()).toBe(0);
  });

  it("executes only after profile, policy, workspace, budget and validation coverage exist", async () => {
    const fx = productionGovernanceFixture();
    await fx.execute();

    expect(fx.sideEffects(), fx.attemptError()).toBe(1);
    expect(fx.runState()).toBe("succeeded");
    expect(fx.validationCount()).toBe(1);
    expect(fx.budgetState()).toBe("committed");
    expect(fx.releasedLeaseCount()).toBe(1);
  });

  it("fails a malformed approval resume in the production composition without opening a second approval", async () => {
    const fx = productionGovernanceFixture({
      grantEffect: "require_approval",
    });

    await fx.execute();
    expect(fx.openWaitCount()).toBe(1);
    expect(fx.approvalCount()).toBe(1);

    await fx.resumeWith({ approved: true });

    expect(fx.runState()).toBe("failed");
    expect(fx.sideEffects()).toBe(0);
    expect(fx.approvalCount()).toBe(1);
    expect(fx.attemptError()).toContain("APPROVAL_RESUME_INVALID");
  });
});

function productionGovernanceFixture(
  options: {
    registerValidator?: boolean;
    grantEffect?: "allow" | "require_approval";
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "forge-production-governance-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const clock = new ManualTestClock("2099-01-01T00:00:00.000Z");
  const profiles = new AgentProfileStore(forgeStore.db);
  const approvals = new ApprovalService(forgeStore.db);
  const budgets = new BudgetLedgerService(forgeStore.db);
  const workspaceGroups = new WorkspaceGroupService(forgeStore.db);
  const leases = new WorkspaceLeaseService(forgeStore.db);
  const validators =
    options.registerValidator ?? true
      ? createProductionValidatorRegistry()
      : new ValidatorRegistry();
  const validations = new ValidationService(forgeStore.db, validators);
  seedPolicy(forgeStore);
  const profile = profiles.publishVersion({
    name: "production-governed-agent",
    model: "profile-model",
    policyVersionId: "policy-production",
  });
  forgeStore.db
    .prepare(
      `INSERT INTO core_subjects (kind, subject_id, display_name, created_at, updated_at)
       VALUES ('agent_profile', ?, 'production agent', ?, ?)`,
    )
    .run(profile.profileId, clock.now(), clock.now());
  forgeStore.db
    .prepare(
      `INSERT INTO core_grants (
        id, subject_kind, subject_id, policy_version_id, action, resource_kind,
        resource_scope_json, effect, created_at
      ) VALUES ('grant-production', 'agent_profile', ?, 'policy-production',
                'agent.run', 'workspace', ?, ?, ?)`,
    )
    .run(
      profile.profileId,
      JSON.stringify({ resourceIds: ["workspace-1"] }),
      options.grantEffect ?? "allow",
      clock.now(),
    );
  workspaceGroups.registerWorkspace({ id: "workspace-1", rootPath: root });
  budgets.createAccount({
    id: "budget-1",
    name: "production test budget",
    currency: "USD",
    hardLimitMinor: 100n,
  });

  let sideEffects = 0;
  const production = createProductionExecutionComposition({
    db: forgeStore.db,
    clock,
    broadcast: () => {},
    run: async (request) => {
      sideEffects += 1;
      return {
        sessionId: request.sessionId ?? "session-production",
        finalText: "validated production result",
      };
    },
    governance: { profiles, approvals, budgets, leases, validations },
  });

  return {
    sideEffects: () => sideEffects,
    async execute(input: { missing?: "workspace" | "budget" } = {}) {
      production.executionStore.createRun(
        governedRunSpec(root, profile.profileId, profile.id, input.missing),
        clock.now(),
      );
      await production.executor.tick();
    },
    async resumeWith(payload: unknown) {
      const wait = production.executionStore.getActiveWait(
        "run-production",
        "agent",
      );
      if (!wait) throw new Error("expected an open production approval wait");
      production.executor.resumeWait(wait.id, payload);
      await production.executor.tick();
    },
    runState: () => production.executionStore.getRun("run-production")?.state,
    attemptError: () =>
      (
        forgeStore.db
          .prepare(
            `SELECT error_json AS errorJson FROM core_attempts
             WHERE run_id = ? ORDER BY attempt_number DESC LIMIT 1`,
          )
          .get("run-production") as { errorJson: string | null } | undefined
      )?.errorJson ?? "no attempt error",
    validationCount: () =>
      validations.listByRun("run-production").length,
    approvalCount: () =>
      (
        forgeStore.db
          .prepare(
            "SELECT COUNT(*) AS count FROM core_approvals WHERE run_id = ?",
          )
          .get("run-production") as { count: number }
      ).count,
    openWaitCount: () =>
      production.executionStore.getActiveWait("run-production", "agent") ? 1 : 0,
    budgetState: () =>
      forgeStore.db
        .prepare("SELECT state FROM core_budget_reservations WHERE run_id = ?")
        .get("run-production")?.state,
    releasedLeaseCount: () =>
      (
        forgeStore.db
          .prepare(
            "SELECT COUNT(*) AS count FROM core_workspace_leases WHERE run_id = ? AND released_at IS NOT NULL",
          )
          .get("run-production") as { count: number }
      ).count,
  };
}

function governedRunSpec(
  root: string,
  profileId: string,
  profileVersionId: string,
  missing?: "workspace" | "budget",
): RunSpec {
  return {
    id: "run-production",
    requestedBy: { kind: "human", id: "user-production" },
    actingSubject: { kind: "agent_profile", id: profileId },
    objective: "exercise production governance",
    correlationId: "corr-production",
    budgetAccountId: "budget-1",
    policyContext: {
      governance: {
        profileId,
        profileVersionId,
        action: "agent.run",
        resource: { kind: "workspace", id: "workspace-1" },
        risk: "low",
        ...(missing === "workspace"
          ? {}
          : {
              workspace: {
                id: "workspace-1",
                rootPath: root,
                mode: "write",
              },
            }),
        ...(missing === "budget"
          ? {}
          : { budget: { accountId: "budget-1", amountMinor: 1 } }),
        delivery: { id: "agent" },
      },
    },
    steps: [
      {
        id: "agent",
        kind: "forge.agent",
        dependsOn: [],
        input: { cwd: root, message: "run" },
        retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
        timeoutMs: 1_000,
      },
    ],
  };
}

function seedPolicy(store: ForgeStore): void {
  store.db
    .prepare(
      `INSERT INTO core_policy_versions (id, name, version, rules_json, is_active, created_at)
       VALUES ('policy-production', 'production', 1, '{}', 1, '2026-09-02T00:00:00.000Z')`,
    )
    .run();
}
