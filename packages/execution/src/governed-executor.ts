import type { AgentCapabilitySnapshot } from "@forge/agent-profile";
import type { ValidationInput } from "@forge/evidence";
import type { PolicyDecision } from "@forge/policy";
import type { ApprovalRecord } from "@forge/policy";
import type { SubjectRef } from "@forge/protocol";
import type { BudgetReservation } from "@forge/usage-ledger";
import type { WorkspaceLease } from "@forge/workspace";
import type { ExecutionClock } from "./clock.js";
import type {
  StepExecutionInput,
  StepOutcome,
} from "./executor-types.js";
import type {
  GovernedStepExecutionInput,
  GovernedStepOutcome,
  ResourceRef,
  RiskLevel,
  StepWaitReason,
} from "./governed-types.js";
import type { ExecutionStore } from "./store.js";

export type {
  GovernedStepExecutionInput,
  GovernedStepOutcome,
  ResourceRef,
  RiskLevel,
  StepWaitReason,
} from "./governed-types.js";

export { mapGovernedOutcome } from "./governed-types.js";

export interface ProfileResolveInput {
  profileId: string;
  profileVersionId: string;
  runId: string;
}

export interface WorkspaceAcquireInput {
  workspaceId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  mode: "read" | "write";
  rootPath: string;
  expiresAt: string;
}

export interface BudgetReserveInput {
  reservationId: string;
  accountId: string;
  runId: string;
  stepId: string;
  amountMinor: bigint;
  currency: string;
  expiresAt: string;
}

export interface PolicyAuthorizeInput {
  subject: SubjectRef;
  action: string;
  resource: ResourceRef;
  scope: Record<string, string>;
  risk: RiskLevel;
  context: Record<string, unknown>;
}

export interface ApprovalRequestInput {
  subject: SubjectRef;
  action: string;
  resource: ResourceRef;
  parametersSummary: string;
  parameters?: Record<string, unknown>;
  risk: RiskLevel;
  policyVersionId: string;
  expiresAt: string;
  runId: string;
  stepId: string;
  attemptId: string;
}

export interface GovernedExecutionPorts {
  profile: {
    resolve(input: ProfileResolveInput): Promise<AgentCapabilitySnapshot>;
  };
  workspace: {
    acquire(input: WorkspaceAcquireInput): Promise<WorkspaceLease>;
    release(leaseId: string, reason: string): Promise<void>;
  };
  policy: {
    authorize(input: PolicyAuthorizeInput): PolicyDecision;
  };
  approval: {
    requestApproval(input: ApprovalRequestInput): { id: string };
    getApproval(approvalId: string): ApprovalRecord;
  };
  budget: {
    reserve(input: BudgetReserveInput): Promise<BudgetReservation>;
    commit(reservationId: string, amountMinor: bigint): Promise<void>;
    release(reservationId: string, reason: string): Promise<void>;
  };
  evidence: {
    validateDelivery(input: ValidationInput): Promise<{ accepted: boolean }>;
  };
  step: {
    execute(input: StepExecutionInput, signal: AbortSignal): Promise<StepOutcome>;
  };
}

export class GovernedStepExecutor {
  constructor(
    private readonly ports: GovernedExecutionPorts,
    private readonly store: ExecutionStore,
    private readonly clock: ExecutionClock,
  ) {}

  async execute(
    input: GovernedStepExecutionInput,
    signal: AbortSignal,
  ): Promise<GovernedStepOutcome> {
    let leaseId: string | undefined;
    let reservationId: string | undefined;
    let retainResourcesForRetry = false;

    try {
      await this.ports.profile.resolve({
        profileId: input.profileId,
        profileVersionId: input.profileVersionId,
        runId: input.runId,
      });

      if (input.workspaceId && input.workspaceRootPath) {
        const lease = await this.ports.workspace.acquire({
          workspaceId: input.workspaceId,
          runId: input.runId,
          stepId: input.stepId,
          attemptId: input.attemptId,
          mode: input.workspaceMode ?? "write",
          rootPath: input.workspaceRootPath,
          expiresAt: input.workspaceLeaseExpiresAt ?? defaultLeaseExpiry(this.clock),
        });
        leaseId = lease.id;
      }

      const decision = this.ports.policy.authorize({
        subject: input.actingSubject,
        action: input.action,
        resource: input.resource,
        scope: input.policyScope ?? {},
        risk: input.risk,
        context: input.policyContext,
      });

      if (decision.outcome === "deny") {
        return {
          state: "failed",
          error: { code: "POLICY_DENIED", reason: decision.reason },
          retryable: false,
        };
      }

      if (decision.outcome === "require_approval") {
        const approvedApprovalId = approvedApprovalIdFrom(input.policyContext);
        if (
          approvedApprovalId &&
          matchesApprovedRequest(
            this.ports.approval.getApproval(approvedApprovalId),
            input,
            decision.policyVersionId,
          )
        ) {
          // The exact approved durable approval authorizes this resumed attempt.
        } else {
        const approval = this.ports.approval.requestApproval({
          subject: input.actingSubject,
          action: input.action,
          resource: input.resource,
          parametersSummary: input.parametersSummary ?? input.action,
          parameters: input.parameters,
          risk: input.risk,
          policyVersionId: decision.policyVersionId,
          expiresAt: input.approvalExpiresAt ?? defaultLeaseExpiry(this.clock),
          runId: input.runId,
          stepId: input.stepId,
          attemptId: input.attemptId,
        });
        const waitReason: StepWaitReason = {
          kind: "approval",
          approvalId: approval.id,
        };
        this.store.enterStepWait(
          input.attemptId,
          "approval",
          waitReason,
          this.clock.now(),
        );
        return { state: "waiting", waitReason };
        }
      }

      if (input.budgetAccountId && input.budgetAmountMinor != null) {
        const reservation = await this.ports.budget.reserve({
          reservationId: input.budgetReservationId ?? `${input.attemptId}:budget`,
          accountId: input.budgetAccountId,
          runId: input.runId,
          stepId: input.stepId,
          amountMinor: input.budgetAmountMinor,
          currency: input.budgetCurrency ?? "USD",
          expiresAt: input.budgetReservationExpiresAt ?? defaultLeaseExpiry(this.clock),
        });
        reservationId = reservation.id;
      }

      const stepInput: StepExecutionInput = {
        runId: input.runId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        attemptNumber: input.attemptNumber,
        kind: input.kind,
        input: input.input,
        idempotencyKey: input.idempotencyKey,
        timeoutMs: input.timeoutMs,
      };

      if (input.idempotencyKey) {
        const claim = this.store.claimIdempotencyKey({
          idempotencyKey: input.idempotencyKey,
          runId: input.runId,
          stepId: input.stepId,
          attemptId: input.attemptId,
          now: this.clock.now(),
        });
        if (claim.state === "completed") {
          return { state: "succeeded", outputRef: claim.outputRef };
        }
        if (claim.state === "in_progress") {
          return {
            state: "failed",
            error: { code: "IDEMPOTENCY_IN_PROGRESS" },
            retryable: false,
          };
        }
      }

      const stepOutcome = await this.ports.step.execute(stepInput, signal);

      if (stepOutcome.state === "waiting") {
        return {
          state: "waiting",
          waitReason: {
            kind: "manual_review",
            reason: stepOutcome.waitRef,
          },
        };
      }

      if (stepOutcome.state === "failed") {
        retainResourcesForRetry =
          stepOutcome.retryable && input.retainResourcesOnRetry === true;
        return stepOutcome;
      }

      if (input.idempotencyKey) {
        this.store.completeIdempotencyKey(
          input.idempotencyKey,
          input.attemptId,
          stepOutcome.outputRef,
        );
      }

      const validation = await this.ports.evidence.validateDelivery({
        runId: input.runId,
        deliveryId: input.deliveryId ?? input.stepId,
        artifactIds: input.artifactIds ?? [],
        evidenceIds: input.evidenceIds ?? [],
        context: input.policyContext,
      });

      if (!validation.accepted) {
        return {
          state: "failed",
          error: { code: "VALIDATION_FAILED" },
          retryable: false,
        };
      }

      if (reservationId) {
        await this.ports.budget.commit(
          reservationId,
          input.budgetCommitMinor ?? input.budgetAmountMinor ?? 0n,
        );
        reservationId = undefined;
      }

      return stepOutcome;
    } finally {
      if (!retainResourcesForRetry) {
        if (leaseId) {
          await this.ports.workspace.release(leaseId, "cleanup");
        }
        if (reservationId) {
          await this.ports.budget.release(reservationId, "cleanup");
        }
      }
    }
  }
}

function approvedApprovalIdFrom(context: Record<string, unknown>): string | undefined {
  const value = context.approvedApprovalId;
  return typeof value === "string" && value ? value : undefined;
}

function matchesApprovedRequest(
  approval: ApprovalRecord,
  input: GovernedStepExecutionInput,
  policyVersionId: string,
): boolean {
  return (
    approval.state === "approved" &&
    approval.subject.kind === input.actingSubject.kind &&
    approval.subject.id === input.actingSubject.id &&
    approval.action === input.action &&
    approval.resource.kind === input.resource.kind &&
    approval.resource.id === input.resource.id &&
    approval.policyVersionId === policyVersionId &&
    approval.runId === input.runId &&
    approval.stepId === input.stepId
  );
}

function defaultLeaseExpiry(clock: ExecutionClock): string {
  return new Date(clock.nowMs() + 15 * 60_000).toISOString();
}
