import type { AutomationRecord, AutomationRunContext } from "@forge/protocol";
import { FORGE_AGENT_STEP_KIND } from "@forge/execution";
import type { TriggerStore } from "@forge/workflows";
import type {
  DurableWorkflowDefinition,
  WorkflowStepDefinition,
} from "@forge/workflows";
import { shouldCatchUpMissedRun } from "./cron.js";

export const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
} as const;

export interface ScheduledRunClaimStore {
  tryClaim(automationId: string, occurrenceAt: string): boolean;
  complete(automationId: string, occurrenceAt: string): void;
  abandon(automationId: string, occurrenceAt: string): void;
  recoverIncomplete(): number;
}

export class TriggerScheduleClaimStore implements ScheduledRunClaimStore {
  private readonly leases = new Map<string, string>();

  constructor(private readonly triggers: TriggerStore) {}

  tryClaim(automationId: string, occurrenceAt: string): boolean {
    const result = this.triggers.accept({
      source: `automation:${automationId}`,
      externalId: occurrenceAt,
    });
    if (result.accepted && result.leaseToken) {
      this.leases.set(`${automationId}:${occurrenceAt}`, result.leaseToken);
    }
    return result.accepted;
  }

  complete(automationId: string, occurrenceAt: string): void {
    const key = `${automationId}:${occurrenceAt}`;
    const leaseToken = this.leases.get(key);
    if (!leaseToken) {
      throw new Error(`missing trigger lease for ${key}`);
    }
    this.triggers.complete(
      {
        source: `automation:${automationId}`,
        externalId: occurrenceAt,
      },
      leaseToken,
    );
    this.leases.delete(key);
  }

  abandon(automationId: string, occurrenceAt: string): void {
    const key = `${automationId}:${occurrenceAt}`;
    const leaseToken = this.leases.get(key);
    if (!leaseToken) {
      return;
    }
    this.triggers.fail(
      {
        source: `automation:${automationId}`,
        externalId: occurrenceAt,
      },
      leaseToken,
    );
    this.leases.delete(key);
  }

  recoverIncomplete(): number {
    return this.triggers.recoverIncomplete();
  }
}

export function automationToWorkflow(
  row: AutomationRecord,
): DurableWorkflowDefinition {
  return {
    id: `automation:${row.id}`,
    version: 1,
    inputSchema: EMPTY_OBJECT_SCHEMA,
    triggers:
      row.trigger.type === "cron"
        ? [
            {
              kind: "cron",
              expression: row.trigger.cron,
            },
          ]
        : [{ kind: "manual" }],
    steps: [legacyAutomationStep(row)],
    concurrency: { maxRuns: 1 },
  };
}

export function legacyAutomationStep(
  row: AutomationRecord,
): WorkflowStepDefinition {
  return {
    id: "agent",
    kind: FORGE_AGENT_STEP_KIND,
    dependsOn: [],
    input: automationLegacyRunInput(row),
    idempotencyKey:
      row.sessionMode === "resume" && row.resumeSessionId
        ? row.resumeSessionId
        : undefined,
  };
}

export function automationLegacyRunInput(
  row: AutomationRecord,
  sessionId?: string,
): Record<string, unknown> {
  return {
    cwd: row.cwd,
    message: row.prompt,
    sessionId,
    hookSource: "startup",
    autoApply: false,
    automationRun: buildAutomationRunContext(row),
  };
}

export function buildAutomationRunContext(
  row: AutomationRecord,
): AutomationRunContext {
  return {
    name: row.name,
    schedule:
      row.trigger.type === "cron"
        ? { cron: row.trigger.cron, timezone: row.trigger.timezone }
        : undefined,
    notification:
      row.notify?.enabled &&
      row.notify.channelKind &&
      row.notify.channelKind !== "mobile"
        ? { channelKind: row.notify.channelKind }
        : undefined,
  };
}

export async function processScheduledAutomationCatchUp(
  automations: AutomationRecord[],
  claimStore: ScheduledRunClaimStore,
  execute: (automationId: string, occurrenceAt: string) => Promise<boolean>,
  now = new Date(),
): Promise<void> {
  claimStore.recoverIncomplete();
  for (const auto of automations) {
    if (auto.trigger.type !== "cron" || !auto.nextRunAt) {
      continue;
    }
    if (!shouldCatchUpMissedRun(auto.nextRunAt, auto.lastRunAt, now)) {
      continue;
    }
    if (!claimStore.tryClaim(auto.id, auto.nextRunAt)) {
      continue;
    }
    let durableOccurrenceCreated = false;
    try {
      durableOccurrenceCreated = await execute(auto.id, auto.nextRunAt);
    } catch (error) {
      claimStore.abandon(auto.id, auto.nextRunAt);
      throw error;
    }
    if (durableOccurrenceCreated) {
      claimStore.complete(auto.id, auto.nextRunAt);
    } else {
      claimStore.abandon(auto.id, auto.nextRunAt);
    }
  }
}

export function workflowCorrelationId(
  row: AutomationRecord,
  instanceNumber = 1,
): string {
  const workflow = automationToWorkflow(row);
  return `workflow-instance:${workflow.id}:${instanceNumber}`;
}
