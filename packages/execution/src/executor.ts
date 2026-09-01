import type { ExecutionClock } from "./clock.js";
import type {
  StepExecutionInput,
  StepExecutorRegistry,
  StepOutcome,
} from "./executor-types.js";
import type { GovernedStepExecutor } from "./governed-executor.js";
import type { GovernedStepExecutionInput } from "./governed-types.js";
import { mapGovernedOutcome } from "./governed-types.js";
import type { ClaimedAttempt, ExecutionStore, StoredRun, StoredStep } from "./store.js";

export interface DurableExecutorOptions {
  workerId?: string;
  governedExecutor?: GovernedStepExecutor;
  buildGovernedInput?: (
    claimed: ClaimedAttempt,
    step: StoredStep,
    run: StoredRun,
  ) => GovernedStepExecutionInput | null;
  requireGovernance?: boolean;
}

export class DurableExecutor {
  private readonly workerId: string;
  private readonly governedExecutor?: GovernedStepExecutor;
  private readonly buildGovernedInput?: DurableExecutorOptions["buildGovernedInput"];
  private readonly requireGovernance: boolean;
  private readonly activeControllers = new Map<string, Set<AbortController>>();

  constructor(
    private readonly store: ExecutionStore,
    private readonly registry: StepExecutorRegistry,
    private readonly clock: ExecutionClock,
    options: DurableExecutorOptions = {},
  ) {
    this.workerId = options.workerId ?? "durable-executor";
    this.governedExecutor = options.governedExecutor;
    this.buildGovernedInput = options.buildGovernedInput;
    this.requireGovernance = options.requireGovernance ?? false;
  }

  async tick(limit = 10): Promise<number> {
    let processed = this.store.resumeDueWaits(this.clock.now(), limit);

    for (const run of this.store.loadRecoverableRuns()) {
      if (processed >= limit) {
        break;
      }
      if (
        run.state === "succeeded" ||
        run.state === "failed" ||
        run.state === "cancelled"
      ) {
        continue;
      }

      while (processed < limit) {
        const claimed = this.store.claimNextStep(
          run.id,
          this.workerId,
          this.clock.now(),
        );
        if (!claimed) {
          break;
        }
        processed += 1;
        await this.executeClaim(claimed);
      }
    }

    return processed;
  }

  resumeWait(waitId: string, payload: unknown): void {
    this.store.resumeWait(waitId, payload, this.clock.now());
  }

  cancelRun(runId: string, reason: string): void {
    for (const controller of this.activeControllers.get(runId) ?? []) {
      controller.abort(reason);
    }
    this.store.cancelRun(runId, reason, this.clock.now());
  }

  private async executeClaim(claimed: ClaimedAttempt): Promise<void> {
    const step = this.store.getStep(claimed.runId, claimed.stepId);
    if (!step) {
      throw new Error(`step not found: ${claimed.stepId}`);
    }

    const executor = this.registry.get(step.kind);
    if (!executor) {
      this.store.finishAttempt(
        claimed.id,
        { state: "failed", error: { code: "EXECUTOR_NOT_FOUND", kind: step.kind } },
        this.clock.now(),
      );
      return;
    }

    const input: StepExecutionInput = {
      runId: claimed.runId,
      stepId: claimed.stepId,
      attemptId: claimed.id,
      attemptNumber: claimed.attemptNumber,
      kind: step.kind,
      input: step.input,
      idempotencyKey: step.idempotencyKey,
      timeoutMs: step.timeoutMs,
    };
    const run = this.store.getRun(claimed.runId);
    const governedInput =
      this.governedExecutor && run && this.buildGovernedInput
        ? this.buildGovernedInput(claimed, step, run)
        : null;

    if (this.requireGovernance && !governedInput) {
      this.store.finishAttempt(
        claimed.id,
        {
          state: "failed",
          error: { code: "GOVERNANCE_CONFIGURATION_MISSING" },
        },
        this.clock.now(),
      );
      return;
    }

    if (input.idempotencyKey && !governedInput) {
      const claim = this.store.claimIdempotencyKey({
        idempotencyKey: input.idempotencyKey,
        runId: input.runId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        now: this.clock.now(),
      });
      if (claim.state === "completed") {
        await this.applyOutcome(claimed, step.retry, {
          state: "succeeded",
          outputRef: claim.outputRef,
        });
        return;
      }
      if (claim.state === "in_progress") {
        await this.applyOutcome(claimed, step.retry, {
          state: "failed",
          error: { code: "IDEMPOTENCY_IN_PROGRESS" },
          retryable: false,
        });
        return;
      }
    }

    const controller = new AbortController();
    let controllers = this.activeControllers.get(claimed.runId);
    if (!controllers) {
      controllers = new Set();
      this.activeControllers.set(claimed.runId, controllers);
    }
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), step.timeoutMs);
    let outcome: StepOutcome;
    try {
      if (this.governedExecutor && governedInput) {
        outcome = mapGovernedOutcome(
          await this.governedExecutor.execute(governedInput, controller.signal),
        );
      } else {
        outcome = await executor.execute(input, controller.signal);
      }
    } catch (error) {
      outcome = {
        state: "failed",
        error,
        retryable: controller.signal.aborted,
      };
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
      if (controllers.size === 0) {
        this.activeControllers.delete(claimed.runId);
      }
    }

    if (this.store.getRun(claimed.runId)?.state === "cancelled") {
      return;
    }
    if (outcome.state === "succeeded" && input.idempotencyKey && !governedInput) {
      this.store.completeIdempotencyKey(
        input.idempotencyKey,
        input.attemptId,
        outcome.outputRef,
      );
    }
    await this.applyOutcome(claimed, step.retry, outcome);
  }

  private async applyOutcome(
    claimed: ClaimedAttempt,
    retry: { maxAttempts: number; backoffMs: number; maxBackoffMs: number },
    outcome: StepOutcome,
  ): Promise<void> {
    const now = this.clock.now();

    if (outcome.state === "succeeded") {
      this.store.finishAttempt(
        claimed.id,
        { state: "succeeded", outputRef: outcome.outputRef },
        now,
      );
      return;
    }

    if (outcome.state === "waiting") {
      const currentStep = this.store.getStep(claimed.runId, claimed.stepId);
      if (currentStep?.state === "waiting") {
        return;
      }
      this.store.finishAttempt(
        claimed.id,
        { state: "failed", error: { code: "EXTERNAL_WAIT", waitRef: outcome.waitRef } },
        now,
      );
      return;
    }

    const canRetry =
      outcome.retryable && claimed.attemptNumber < retry.maxAttempts;
    if (canRetry) {
      const delayMs = Math.min(
        retry.maxBackoffMs,
        retry.backoffMs * claimed.attemptNumber,
      );
      this.store.scheduleRetry(
        {
          attemptId: claimed.id,
          nextAttemptAt: new Date(this.clock.nowMs() + delayMs).toISOString(),
          error: outcome.error,
        },
        now,
      );
      return;
    }

    this.store.finishAttempt(
      claimed.id,
      { state: "failed", error: outcome.error },
      now,
    );
  }
}
