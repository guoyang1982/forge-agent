import type { ExecutionClock } from "./clock.js";
import type {
  StepExecutionInput,
  StepExecutorRegistry,
  StepOutcome,
} from "./executor-types.js";
import type { ClaimedAttempt, ExecutionStore } from "./store.js";

export interface DurableExecutorOptions {
  workerId?: string;
}

export class DurableExecutor {
  private readonly workerId: string;

  constructor(
    private readonly store: ExecutionStore,
    private readonly registry: StepExecutorRegistry,
    private readonly clock: ExecutionClock,
    options: DurableExecutorOptions = {},
  ) {
    this.workerId = options.workerId ?? "durable-executor";
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), step.timeoutMs);
    let outcome: StepOutcome;
    try {
      outcome = await executor.execute(input, controller.signal);
    } catch (error) {
      outcome = {
        state: "failed",
        error,
        retryable: controller.signal.aborted,
      };
    } finally {
      clearTimeout(timeout);
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
