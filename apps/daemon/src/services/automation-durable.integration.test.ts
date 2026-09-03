import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationStore } from "@forge/automation";
import { AgentProfileStore } from "@forge/agent-profile";
import { ValidationService } from "@forge/evidence";
import { ApprovalService } from "@forge/policy";
import { DEFAULT_CONFIG } from "@forge/protocol";
import { SessionStore } from "@forge/session";
import { ForgeStore } from "@forge/store";
import { BudgetLedgerService } from "@forge/usage-ledger";
import { WorkspaceGroupService, WorkspaceLeaseService } from "@forge/workspace";
import { createProductionExecutionComposition } from "./production-execution-composition.js";
import { createProductionValidatorRegistry } from "./production-validators.js";
import { AutomationGovernanceService, seedAutomationGrant } from "./automation-governance.js";
import { AutomationSchedulerHost } from "./automation-scheduler-host.js";
import {
  executeAutomation,
  reconcileAutomationRuns,
} from "./automation-service.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("durable automation occurrence integration", () => {
  it("persists scheduled and manual occurrences as linked workflow instances and Runs without replaying after restart", async () => {
    const fx = durableAutomationFixture();

    await fx.runScheduledOccurrenceAcrossRestart();
    await fx.runManualOccurrence();

    const automationRuns = fx.automationRuns();
    const workflowInstances = fx.workflowInstances();
    expect(workflowInstances).toHaveLength(2);
    expect(fx.durableRuns()).toHaveLength(2);
    expect(fx.agentSideEffects()).toBe(2);
    expect(automationRuns).toHaveLength(2);
    expect(automationRuns.map((run) => run.status)).toEqual([
      "success",
      "success",
    ]);
    expect(automationRuns.every((run) => run.sessionId.length > 0)).toBe(true);
    expect(automationRuns.map((run) => run.preview)).toEqual([
      "automation result 1",
      "automation result 2",
    ]);
    expect(workflowInstances.map((instance) => instance.triggerRef).sort()).toEqual(
      automationRuns
        .map((run) => run.triggerRef ?? `automation-run:${run.id}`)
        .sort(),
    );
    expect(workflowInstances.map((instance) => instance.triggerKind).sort()).toEqual([
      "cron",
      "manual",
    ]);
    expect(
      workflowInstances.every(
        (instance) =>
          instance.runId.length > 0 &&
          fx.durableRuns().some((run) => run.id === instance.runId),
      ),
    ).toBe(true);
    for (const run of automationRuns) {
      const instance = workflowInstances.find(
        (candidate) =>
          candidate.triggerRef === (run.triggerRef ?? `automation-run:${run.id}`),
      );
      expect(run).toMatchObject({
        workflowInstanceId: instance?.id,
        durableRunId: instance?.runId,
      });
    }
  });

  it("recovers the same scheduled occurrence when the process fails after the workflow instance but before its Run", async () => {
    const fx = durableAutomationFixture();

    await fx.failScheduledOccurrenceBeforeRun();
    await fx.retryScheduledOccurrenceAfterRestart();

    expect(fx.scheduledAutomationRuns()).toHaveLength(1);
    expect(fx.workflowInstances()).toHaveLength(1);
    expect(fx.durableRuns()).toHaveLength(1);
    expect(fx.agentSideEffects()).toBe(1);
    expect(fx.scheduledAutomationRuns()[0]).toMatchObject({
      status: "success",
      preview: "automation result 1",
      triggerRef: "automation-schedule:2026-08-31T09:00:00.000Z",
    });
  });

  it("reconciles a queued terminal Run into the workflow and automation projections with its persisted output", async () => {
    const fx = durableAutomationFixture();

    await fx.runManualOccurrence();
    fx.simulateProjectionCrashAfterDurableSuccess();
    expect(fx.manualAutomationRuns()[0]).toMatchObject({ status: "running" });

    await fx.reconcileProjections();

    expect(fx.manualAutomationRuns()[0]).toMatchObject({
      status: "success",
      preview: "automation result 1",
    });
    expect(fx.workflowInstances()[0]?.state).toBe("succeeded");
  });
});

function durableAutomationFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-durable-automation-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const store = new AutomationStore(forgeStore.db);
  const sessions = new SessionStore(forgeStore.db);
  const clock = {
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
  let agentSideEffects = 0;
  const profiles = new AgentProfileStore(forgeStore.db);
  const budgets = new BudgetLedgerService(forgeStore.db);
  const validations = new ValidationService(
    forgeStore.db,
    createProductionValidatorRegistry(),
  );
  const production = createProductionExecutionComposition({
    db: forgeStore.db,
    clock,
    broadcast: () => {},
    run: async (request) => {
      agentSideEffects += 1;
      return {
        sessionId: request.sessionId ?? "automation-session",
        finalText: `automation result ${agentSideEffects}`,
      };
    },
    governance: {
      profiles,
      approvals: new ApprovalService(forgeStore.db),
      budgets,
      leases: new WorkspaceLeaseService(forgeStore.db),
      validations,
    },
  });
  const { executionStore, executor } = production;
  const governance = new AutomationGovernanceService(
    forgeStore.db,
    profiles,
    budgets,
    new WorkspaceGroupService(forgeStore.db),
    validations,
  );
  let activeScheduler: AutomationSchedulerHost;

  const config = {
    ...DEFAULT_CONFIG,
    permissions: {
      ...DEFAULT_CONFIG.permissions,
      automation: {
        ...DEFAULT_CONFIG.permissions.automation,
        enabled: true,
        run: "allow" as const,
      },
    },
  };

  const scheduled = store.create({
    name: "Scheduled report",
    cwd: root,
    trigger: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
    prompt: "Create the scheduled report",
    enabled: true,
  });
  store.setNextRunAt(scheduled.id, "2026-08-31T09:00:00.000Z");
  const manual = store.create({
    name: "Manual report",
    cwd: root,
    trigger: { type: "manual" },
    prompt: "Create the manual report",
    enabled: true,
  });
  seedAutomationPolicyAndGrants(forgeStore.db, scheduled.id, root);
  seedAutomationPolicyAndGrants(forgeStore.db, manual.id, root);

  const execute = (
    id: string,
    trigger: "schedule" | "manual" | "cli",
    opts?: { occurrenceRef?: string },
  ) =>
    executeAutomation(id, trigger, {
      store,
      sessions,
      scheduler: activeScheduler,
      cfg: config,
      durable: { db: forgeStore.db, executionStore, executor, clock, governance },
    }, opts);

  const newScheduler = () => {
    activeScheduler = new AutomationSchedulerHost({
      store,
      db: forgeStore.db,
      executeAutomation: execute,
    });
    return activeScheduler;
  };

  return {
    async runScheduledOccurrenceAcrossRestart() {
      const first = newScheduler();
      await first.start();
      first.stop();
      // Model the projection left behind when a process dies after the durable
      // occurrence commits but before the legacy scheduling timestamps do.
      forgeStore.db
        .prepare(
          `UPDATE automations
           SET last_run_at = NULL, next_run_at = ?
           WHERE id = ?`,
        )
        .run("2026-08-31T09:00:00.000Z", scheduled.id);
      const restarted = newScheduler();
      await restarted.start();
      restarted.stop();
    },
    async runManualOccurrence() {
      newScheduler();
      await execute(manual.id, "manual");
      activeScheduler.stop();
    },
    async failScheduledOccurrenceBeforeRun() {
      forgeStore.db.exec(`
        CREATE TRIGGER fail_automation_run_insert
        BEFORE INSERT ON core_runs
        BEGIN
          SELECT RAISE(ABORT, 'simulated crash before durable Run');
        END;
      `);
      const first = newScheduler();
      await first.start();
      first.stop();
      forgeStore.db.exec("DROP TRIGGER fail_automation_run_insert");
    },
    async retryScheduledOccurrenceAfterRestart() {
      const restarted = newScheduler();
      await restarted.start();
      restarted.stop();
    },
    scheduledAutomationRuns: () => store.listRuns(scheduled.id),
    manualAutomationRuns: () => store.listRuns(manual.id),
    simulateProjectionCrashAfterDurableSuccess() {
      const projection = store.listRuns(manual.id)[0]!;
      forgeStore.db
        .prepare(
          `UPDATE automation_runs
           SET status = 'running', finished_at = NULL, preview = NULL
           WHERE id = ?`,
        )
        .run(projection.id);
      forgeStore.db
        .prepare(
          `UPDATE core_workflow_instances
           SET state = 'running'
           WHERE id = ?`,
        )
        .run(projection.workflowInstanceId);
    },
    async reconcileProjections() {
      await reconcileAutomationRuns({
        store,
        durable: { db: forgeStore.db, executionStore },
      });
    },
    automationRuns: () => [
      ...store.listRuns(scheduled.id),
      ...store.listRuns(manual.id),
    ],
    workflowInstances: () =>
      forgeStore.db
        .prepare(
          `SELECT id, run_id AS runId, trigger_ref AS triggerRef, state,
                  trigger_kind AS triggerKind
           FROM core_workflow_instances
           ORDER BY created_at`,
        )
        .all() as Array<{
          id: string;
          runId: string;
          triggerRef: string;
          triggerKind: string;
          state: string;
        }>,
    durableRuns: () =>
      forgeStore.db
        .prepare("SELECT id FROM core_runs ORDER BY created_at")
        .all() as Array<{ id: string }>,
    agentSideEffects: () => agentSideEffects,
  };
}

function seedAutomationPolicyAndGrants(
  db: ForgeStore["db"],
  automationId: string,
  cwd: string,
): void {
  const now = new Date().toISOString();
  const policyId = "policy:automation:test:v1";
  db.prepare(
    `INSERT OR IGNORE INTO core_policy_versions (
      id, name, version, rules_json, is_active, created_at
    ) VALUES (?, 'automation-test', 1, '{}', 1, ?)`,
  ).run(policyId, now);
  const profileId = `automation-profile:${automationId}`;
  const workspaceId = `automation-workspace:${createHash("sha256")
    .update(cwd)
    .digest("hex")
    .slice(0, 16)}`;
  seedAutomationGrant(db, automationId, profileId, policyId, workspaceId);
}
