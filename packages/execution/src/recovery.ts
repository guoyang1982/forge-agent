import type { ExecutionClock } from "./clock.js";
import type { StepExecutorRegistry } from "./executor-types.js";
import type { ExecutionStore } from "./store.js";

export class ExecutionRecovery {
  constructor(
    private readonly store: ExecutionStore,
    private readonly registry: StepExecutorRegistry,
    private readonly clock: ExecutionClock,
  ) {}

  async recoverOnStartup(): Promise<void> {
    const now = this.clock.now();
    for (const attempt of this.store.listRunningAttempts()) {
      const step = this.store.getStep(attempt.runId, attempt.stepId);
      if (!step) {
        continue;
      }

      const executor = this.registry.get(step.kind);
      if (step.idempotencyKey && executor?.reconcile) {
        const outcome = await executor.reconcile({
          runId: attempt.runId,
          stepId: attempt.stepId,
          attemptId: attempt.id,
          attemptNumber: attempt.attemptNumber,
          kind: step.kind,
          input: step.input,
          idempotencyKey: step.idempotencyKey,
          timeoutMs: step.timeoutMs,
        });

        if (outcome === "unknown") {
          this.store.abandonAttemptForManualReview(attempt.id, now);
          continue;
        }

        if (outcome.state === "succeeded") {
          this.store.finishAttempt(
            attempt.id,
            { state: "succeeded", outputRef: outcome.outputRef },
            now,
          );
          continue;
        }

        if (outcome.state === "waiting") {
          this.store.abandonAttemptForManualReview(attempt.id, now);
          continue;
        }

        if (outcome.retryable) {
          this.store.abandonAttemptAndRetryStep(attempt.id, now);
        } else {
          this.store.finishAttempt(
            attempt.id,
            { state: "failed", error: outcome.error },
            now,
          );
        }
        continue;
      }

      if (step.idempotencyKey) {
        this.store.abandonAttemptAndRetryStep(attempt.id, now);
        continue;
      }

      this.store.abandonAttemptForManualReview(attempt.id, now);
    }
  }
}
