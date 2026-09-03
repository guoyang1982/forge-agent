import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutomationRecord } from "@forge/protocol";
import { ForgeStore } from "@forge/store";
import { TriggerStore } from "@forge/workflows";
import {
  TriggerScheduleClaimStore,
  automationToWorkflow,
  processScheduledAutomationCatchUp,
} from "./v2-adapter.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("automationToWorkflow", () => {
  it("maps a cron automation to one forge.agent workflow step", () => {
    expect(automationToWorkflow(legacyAutomationFixture())).toMatchObject({
      triggers: [{ kind: "cron" }],
      steps: [{ kind: "forge.agent" }],
    });
  });

  it("maps a manual automation to a manual trigger", () => {
    const workflow = automationToWorkflow(
      legacyAutomationFixture({ trigger: { type: "manual" } }),
    );
    expect(workflow.triggers).toEqual([{ kind: "manual" }]);
    expect(workflow.concurrency).toEqual({ maxRuns: 1 });
  });
});

describe("processScheduledAutomationCatchUp", () => {
  it("does not double-run the same scheduled occurrence after restart", async () => {
    const fx = automationRestartFixture("2026-08-28T10:00:00.000Z");
    await fx.startTwice();
    expect(fx.executionCount()).toBe(1);
  });

  it("reclaims an incomplete trigger receipt when execute returns false", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-automation-trigger-false-"));
    fixtureRoots.push(root);
    const forgeStore = ForgeStore.open({
      dbPath: join(root, "data.db"),
      migrationsDir,
      owner: "test",
    });
    const automation = legacyAutomationFixture();
    const triggers = new TriggerStore(forgeStore.db);
    const claimStore = new TriggerScheduleClaimStore(triggers);
    let calls = 0;

    await processScheduledAutomationCatchUp(
      [automation],
      claimStore,
      async () => {
        calls += 1;
        return false;
      },
      new Date("2026-08-28T10:05:00.000Z"),
    );

    const receipt = triggers.getReceipt({
      source: `automation:${automation.id}`,
      externalId: automation.nextRunAt!,
    });
    expect(receipt?.state).toBe("pending");

    await processScheduledAutomationCatchUp(
      [automation],
      claimStore,
      async () => {
        calls += 1;
        return true;
      },
      new Date("2026-08-28T10:05:00.000Z"),
    );

    expect(calls).toBe(2);
  });

  it("reclaims an incomplete trigger receipt after a crash before durable creation", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-automation-trigger-crash-"));
    fixtureRoots.push(root);
    const forgeStore = ForgeStore.open({
      dbPath: join(root, "data.db"),
      migrationsDir,
      owner: "test",
    });
    const automation = legacyAutomationFixture();
    const claimStore = new TriggerScheduleClaimStore(new TriggerStore(forgeStore.db));
    let calls = 0;

    await expect(
      processScheduledAutomationCatchUp(
        [automation],
        claimStore,
        async () => {
          calls += 1;
          throw new Error("process crashed before durable occurrence");
        },
        new Date("2026-08-28T10:05:00.000Z"),
      ),
    ).rejects.toThrow("process crashed");

    await processScheduledAutomationCatchUp(
      [automation],
      claimStore,
      async () => {
        calls += 1;
        return true;
      },
      new Date("2026-08-28T10:05:00.000Z"),
    );

    expect(calls).toBe(2);
  });
});

function automationRestartFixture(occurrenceAt: string) {
  const root = mkdtempSync(join(tmpdir(), "forge-automation-restart-"));
  fixtureRoots.push(root);
  const forgeStore = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const claimStore = new TriggerScheduleClaimStore(
    new TriggerStore(forgeStore.db),
  );
  let executionCount = 0;

  const automation = legacyAutomationFixture({
    nextRunAt: occurrenceAt,
    lastRunAt: undefined,
  });

  return {
    startTwice: async () => {
      await processScheduledAutomationCatchUp(
        [automation],
        claimStore,
        async () => {
          executionCount += 1;
          return true;
        },
        new Date("2026-08-28T10:05:00.000Z"),
      );
      await processScheduledAutomationCatchUp(
        [automation],
        claimStore,
        async () => {
          executionCount += 1;
          return true;
        },
        new Date("2026-08-28T10:05:00.000Z"),
      );
    },
    executionCount: () => executionCount,
  };
}

function legacyAutomationFixture(
  overrides: Partial<AutomationRecord> = {},
): AutomationRecord {
  return {
    id: "auto-1",
    name: "Daily summary",
    enabled: true,
    cwd: "/tmp/project",
    trigger: {
      type: "cron",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
    },
    prompt: "Summarize open PRs",
    memoryEnabled: false,
    sessionMode: "new",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    nextRunAt: "2026-08-28T09:00:00.000Z",
    ...overrides,
  };
}
