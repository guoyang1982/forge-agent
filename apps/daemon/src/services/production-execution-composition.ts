import {
  DurableExecutor,
  ExecutionRecovery,
  ExecutionStore,
  GovernedStepExecutor,
  LegacyForgeStepExecutor,
  StepExecutorRegistry,
  type ClaimedAttempt,
  type ExecutionClock,
  type LegacyForgeRunFn,
  type StoredRun,
  type StoredStep,
} from "@forge/execution";
import type { AgentProfileStore } from "@forge/agent-profile";
import type { ValidationService } from "@forge/evidence";
import { PolicyEngine, type ApprovalService } from "@forge/policy";
import type { BudgetLedgerService } from "@forge/usage-ledger";
import { WorkspaceLeaseService } from "@forge/workspace";
import { EventStore } from "@forge/event-store";
import type { EventEnvelope } from "@forge/protocol";
import { createProductionEventSink } from "./core-event-sink.js";

export interface CoreEventDeliveryFailure {
  event: EventEnvelope;
  error: Error;
}

export interface CoreEventDeliveryFailureSource {
  onCoreEventBroadcastFailure(
    listener: (failure: CoreEventDeliveryFailure) => void,
  ): () => void;
}

export interface ProductionExecutionCompositionOptions {
  db: ConstructorParameters<typeof EventStore>[0];
  clock: ExecutionClock;
  run: LegacyForgeRunFn;
  broadcast(event: EventEnvelope): void;
  onDeliveryFailure?(failure: CoreEventDeliveryFailure): void;
  governance?: {
    profiles: AgentProfileStore;
    approvals: ApprovalService;
    budgets: BudgetLedgerService;
    leases: WorkspaceLeaseService;
    validations: ValidationService;
  };
}

/** Production-only durable execution wiring, shared by main and socket e2e tests. */
export function createProductionExecutionComposition(
  options: ProductionExecutionCompositionOptions,
) {
  const eventStore = new EventStore(options.db);
  let executionStore!: ExecutionStore;
  const eventSink = createProductionEventSink({
    events: eventStore,
    getCorrelationId: (runId) => executionStore.getRun(runId)?.correlationId,
    getActingSubject: (runId) => executionStore.getRun(runId)?.spec.actingSubject,
    broadcast: options.broadcast,
    reportDeliveryFailure: (event, error) => {
      options.onDeliveryFailure?.({ event, error });
    },
    now: options.clock.now,
  });
  executionStore = new ExecutionStore(options.db, eventSink.appendInTransaction, {
    onCommitted: eventSink.flush,
    onRolledBack: eventSink.discard,
  });
  const stepExecutors = new StepExecutorRegistry();
  stepExecutors.register(
    new LegacyForgeStepExecutor({
      emitLegacyAgentEvent: eventSink.emitLegacyAgentEvent,
      run: options.run,
    }),
  );
  const governedExecutor = options.governance
    ? new GovernedStepExecutor(
        {
          profile: { resolve: (input) => Promise.resolve(options.governance!.profiles.resolveSnapshot(input)) },
          workspace: {
            acquire: (input) => Promise.resolve(options.governance!.leases.acquire(input)),
            release: async (leaseId, reason) => {
              options.governance!.leases.release(leaseId, reason);
            },
          },
          policy: { authorize: (input) => PolicyEngine.fromDatabase(options.db).authorize(input) },
          approval: {
            requestApproval: (input) => options.governance!.approvals.requestApproval(input),
            getApproval: (approvalId) => options.governance!.approvals.getApproval(approvalId),
          },
          budget: {
            reserve: async (input) => options.governance!.budgets.reserve(input),
            commit: async (reservationId, amountMinor) => {
              options.governance!.budgets.commit(reservationId, amountMinor);
            },
            release: async (reservationId, reason) => {
              options.governance!.budgets.release(reservationId, reason);
            },
          },
          evidence: { validateDelivery: (input) => options.governance!.validations.validateDelivery(input) },
          step: {
            execute: (input, signal) => {
              const step = stepExecutors.get(input.kind);
              if (!step) {
                return Promise.resolve({
                  state: "failed" as const,
                  error: { code: "EXECUTOR_NOT_FOUND", kind: input.kind },
                  retryable: false,
                });
              }
              return step.execute(input, signal);
            },
          },
        },
        executionStore,
        options.clock,
      )
    : undefined;
  const executor = new DurableExecutor(executionStore, stepExecutors, options.clock, {
    governedExecutor,
    requireGovernance: Boolean(governedExecutor),
    buildGovernedInput: governedExecutor
      ? (claimed, step, run) => buildProductionGovernedInput(
          claimed,
          step,
          run,
          executionStore,
        )
      : undefined,
  });
  const executionRecovery = new ExecutionRecovery(
    executionStore,
    stepExecutors,
    options.clock,
  );

  return {
    eventStore,
    executionStore,
    executor,
    executionRecovery,
    observeDeliveryFailures(source: CoreEventDeliveryFailureSource): () => void {
      if (!options.onDeliveryFailure) return () => undefined;
      return source.onCoreEventBroadcastFailure(options.onDeliveryFailure);
    },
  };
}

function buildProductionGovernedInput(
  claimed: ClaimedAttempt,
  step: StoredStep,
  run: StoredRun,
  store: ExecutionStore,
) {
  const governance = readRecord(run.spec.policyContext.governance);
  const resource = readRecord(governance?.resource);
  if (!governance || !resource) return null;
  const profileId = readString(governance.profileId);
  const profileVersionId = readString(governance.profileVersionId);
  const action = readString(governance.action);
  const resourceKind = readString(resource.kind);
  const resourceId = readString(resource.id);
  const risk = readRisk(governance.risk);
  if (!profileId || !profileVersionId || !action || !resourceKind || !resourceId || !risk) {
    return null;
  }
  const workspace = readRecord(governance.workspace);
  const budget = readRecord(governance.budget);
  const delivery = readRecord(governance.delivery);
  const resolved = store.getLatestResolvedWait(run.id, step.id);
  const resumed = readRecord(resolved?.payload);
  return {
    runId: claimed.runId,
    stepId: claimed.stepId,
    attemptId: claimed.id,
    attemptNumber: claimed.attemptNumber,
    kind: step.kind,
    input: step.input,
    idempotencyKey: step.idempotencyKey,
    timeoutMs: step.timeoutMs,
    profileId,
    profileVersionId,
    actingSubject: run.spec.actingSubject,
    action,
    resource: { kind: resourceKind, id: resourceId },
    risk,
    policyContext: {
      ...run.spec.policyContext,
      ...(readString(resumed?.approvalId) ? { approvedApprovalId: readString(resumed?.approvalId) } : {}),
    },
    ...(workspace && readString(workspace.id) && readString(workspace.rootPath)
      ? {
          workspaceId: readString(workspace.id),
          workspaceRootPath: readString(workspace.rootPath),
          workspaceMode: workspace.mode === "read" ? "read" as const : "write" as const,
        }
      : {}),
    ...(budget && readString(budget.accountId) && typeof budget.amountMinor === "number"
      ? { budgetAccountId: readString(budget.accountId), budgetAmountMinor: BigInt(budget.amountMinor) }
      : {}),
    ...(delivery
      ? {
          deliveryId: readString(delivery.id) ?? step.id,
          artifactIds: readStringArray(delivery.artifactIds),
          evidenceIds: readStringArray(delivery.evidenceIds),
        }
      : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function readRisk(value: unknown): "low" | "medium" | "high" | "critical" | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "critical"
    ? value
    : undefined;
}
