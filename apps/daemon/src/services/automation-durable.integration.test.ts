import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationStore } from "@forge/automation";
import {
  DurableExecutor,
  ExecutionStore,
  StepExecutorRegistry,
  succeeded,
} from "@forge/execution";
import { DEFAULT_CONFIG } from "@forge/protocol";
import { SessionStore } from "@forge/session";
import { ForgeStore } from "@forge/store";
import { AutomationSchedulerHost } from "./automation-scheduler-host.js";
import { executeAutomation } from "./automation-service.js";

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
    expect(workflowInstances.map((instance) => instance.triggerRef).sort()).toEqual(
      automationRuns.map((run) => `automation-run:${run.id}`).sort(),
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
        (candidate) => candidate.triggerRef === `automation-run:${run.id}`,
      );
      expect(run).toMatchObject({
        workflowInstanceId: instance?.id,
        durableRunId: instance?.runId,
      });
    }
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
  const executionStore = new ExecutionStore(forgeStore.db);
  const clock = {
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
  const executors = new StepExecutorRegistry();
  let agentSideEffects = 0;
  executors.register({
    kind: "forge.agent",
    execute: async () => {
      agentSideEffects += 1;
      return succeeded(`artifact:automation:${agentSideEffects}`);
    },
  });
  const executor = new DurableExecutor(executionStore, executors, clock);
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

  const execute = (id: string, trigger: "schedule" | "manual" | "cli") =>
    executeAutomation(id, trigger, {
      store,
      sessions,
      scheduler: activeScheduler,
      cfg: config,
      durable: { db: forgeStore.db, executionStore, executor, clock },
    });

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
    automationRuns: () => [
      ...store.listRuns(scheduled.id),
      ...store.listRuns(manual.id),
    ],
    workflowInstances: () =>
      forgeStore.db
        .prepare(
          `SELECT id, run_id AS runId, trigger_ref AS triggerRef,
                  trigger_kind AS triggerKind
           FROM core_workflow_instances
           ORDER BY created_at`,
        )
        .all() as Array<{
          id: string;
          runId: string;
          triggerRef: string;
          triggerKind: string;
        }>,
    durableRuns: () =>
      forgeStore.db
        .prepare("SELECT id FROM core_runs ORDER BY created_at")
        .all() as Array<{ id: string }>,
    agentSideEffects: () => agentSideEffects,
  };
}
