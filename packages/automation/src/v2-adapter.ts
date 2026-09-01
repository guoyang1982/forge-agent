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
}

export class TriggerScheduleClaimStore implements ScheduledRunClaimStore {
  constructor(private readonly triggers: TriggerStore) {}

  tryClaim(automationId: string, occurrenceAt: string): boolean {
    return this.triggers.accept({
      source: `automation:${automationId}`,
      externalId: occurrenceAt,
    });
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
  execute: (automationId: string) => Promise<void>,
  now = new Date(),
): Promise<void> {
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
    await execute(auto.id);
  }
}

export function workflowCorrelationId(
  row: AutomationRecord,
  instanceNumber = 1,
): string {
  const workflow = automationToWorkflow(row);
  return `workflow-instance:${workflow.id}:${instanceNumber}`;
}
