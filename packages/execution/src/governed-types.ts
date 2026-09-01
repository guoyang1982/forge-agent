import type { SubjectRef } from "@forge/protocol";
import type { StepOutcome } from "./executor-types.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ResourceRef {
  kind: string;
  id: string;
}

export type StepWaitReason =
  | { kind: "approval"; approvalId: string }
  | { kind: "input"; requestId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "manual_review"; reason: string };

export interface GovernedStepExecutionInput {
  runId: string;
  stepId: string;
  attemptId: string;
  attemptNumber: number;
  kind: string;
  input: unknown;
  idempotencyKey?: string;
  timeoutMs: number;
  profileId: string;
  profileVersionId: string;
  actingSubject: SubjectRef;
  action: string;
  resource: ResourceRef;
  risk: RiskLevel;
  policyContext: Record<string, unknown>;
  policyScope?: Record<string, string>;
  parametersSummary?: string;
  parameters?: Record<string, unknown>;
  workspaceId?: string;
  workspaceRootPath?: string;
  workspaceMode?: "read" | "write";
  workspaceLeaseExpiresAt?: string;
  budgetAccountId?: string;
  budgetAmountMinor?: bigint;
  budgetCommitMinor?: bigint;
  budgetCurrency?: string;
  budgetReservationId?: string;
  budgetReservationExpiresAt?: string;
  approvalExpiresAt?: string;
  deliveryId?: string;
  artifactIds?: string[];
  evidenceIds?: string[];
  retainResourcesOnRetry?: boolean;
}

export type GovernedStepOutcome =
  | StepOutcome
  | { state: "waiting"; waitReason: StepWaitReason };

export function mapGovernedOutcome(outcome: GovernedStepOutcome): StepOutcome {
  if (outcome.state === "waiting" && "waitReason" in outcome) {
    return {
      state: "waiting",
      waitRef: waitReasonRef(outcome.waitReason),
      payload: outcome.waitReason,
    };
  }
  return outcome;
}

function waitReasonRef(reason: StepWaitReason): string {
  switch (reason.kind) {
    case "approval":
      return reason.approvalId;
    case "input":
      return reason.requestId;
    case "workspace":
      return reason.workspaceId;
    case "manual_review":
      return reason.reason;
  }
}
