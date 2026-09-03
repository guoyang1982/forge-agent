import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { EventStore } from "@forge/event-store";
import { transitionRun, transitionStep, isTerminalRunState } from "./state-machine.js";
import type {
  AttemptState,
  RunSpec,
  RunState,
  StepSpec,
  StepState,
} from "./types.js";

export type EventAppendFn = typeof EventStore.appendInTransaction;

export interface EventTransactionObserver {
  onCommitted(): void;
  onRolledBack(): void;
}

export interface ClaimedAttempt {
  id: string;
  runId: string;
  stepId: string;
  attemptNumber: number;
  workerId: string;
}

export interface StoredRun {
  id: string;
  state: RunState;
  spec: RunSpec;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredStep {
  runId: string;
  id: string;
  kind: string;
  state: StepState;
  dependsOn: string[];
  input: unknown;
  workspaceBindingId?: string;
  idempotencyKey?: string;
  retry: StepSpec["retry"];
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAttempt {
  id: string;
  runId: string;
  stepId: string;
  attemptNumber: number;
  state: AttemptState;
  workerId: string | null;
  outputRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinishAttemptInput {
  state: Extract<AttemptState, "succeeded" | "failed" | "cancelled" | "abandoned">;
  outputRef?: string;
  error?: unknown;
}

export type IdempotencyClaim =
  | { state: "claimed" }
  | { state: "completed"; outputRef: string }
  | { state: "in_progress" }
  | { state: "uncertain" };

const IDEMPOTENCY_BLOCKED_STATES = new Set([
  "uncertain",
  "side_effect_committed",
  "validated",
]);

export class ExecutionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly appendEvent: EventAppendFn = EventStore.appendInTransaction,
    private readonly eventTransactionObserver?: EventTransactionObserver,
  ) {}

  createRun(spec: RunSpec, now: string): StoredRun {
    assertAcyclic(spec);

    this.runInTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO core_runs (
            id, state, spec_json, correlation_id, requested_by_json,
            acting_subject_json, objective, budget_account_id, policy_context_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          spec.id,
          "running",
          JSON.stringify(spec),
          spec.correlationId,
          JSON.stringify(spec.requestedBy),
          JSON.stringify(spec.actingSubject),
          spec.objective,
          spec.budgetAccountId ?? null,
          JSON.stringify(spec.policyContext),
          now,
          now,
        );

      for (const step of spec.steps) {
        const initialState: StepState =
          step.dependsOn.length === 0 ? "runnable" : "pending";
        this.db
          .prepare(
            `INSERT INTO core_steps (
              id, run_id, kind, state, depends_on_json, input_json,
              workspace_binding_id, idempotency_key, retry_json, timeout_ms,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            step.id,
            spec.id,
            step.kind,
            initialState,
            JSON.stringify(step.dependsOn),
            JSON.stringify(step.input),
            step.workspaceBindingId ?? null,
            step.idempotencyKey ?? null,
            JSON.stringify(step.retry),
            step.timeoutMs,
            now,
            now,
          );

        for (const dependencyId of step.dependsOn) {
          this.db
            .prepare(
              `INSERT INTO core_step_dependencies (run_id, step_id, depends_on_step_id)
               VALUES (?, ?, ?)`,
            )
            .run(spec.id, step.id, dependencyId);
        }
      }

      this.emitRunEvent(spec, "run.created", now, undefined, {
        objective: spec.objective,
      });
    }, true);

    return this.getRun(spec.id)!;
  }

  claimNextStep(
    runId: string,
    workerId: string,
    now: string,
  ): ClaimedAttempt | null {
    return this.runInTransaction(() => {
      const step = this.db
        .prepare(
          `SELECT id, run_id AS runId
           FROM core_steps
           WHERE run_id = ? AND state = 'runnable'
           ORDER BY id
           LIMIT 1`,
        )
        .get(runId) as { id: string; runId: string } | undefined;
      if (!step) {
        return null;
      }

      const changed = this.db
        .prepare(
          `UPDATE core_steps
           SET state = 'running', updated_at = ?
           WHERE run_id = ? AND id = ? AND state = 'runnable'`,
        )
        .run(now, step.runId, step.id).changes;
      if (changed !== 1) {
        return null;
      }

      const attemptNumber =
        (this.db
          .prepare(
            `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS nextAttempt
             FROM core_attempts
             WHERE run_id = ? AND step_id = ?`,
          )
          .get(step.runId, step.id) as { nextAttempt: number }).nextAttempt ?? 1;

      const attemptId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO core_attempts (
            id, run_id, step_id, attempt_number, state, worker_id,
            input_json, started_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'running', ?, '{}', ?, ?, ?)`,
        )
        .run(
          attemptId,
          step.runId,
          step.id,
          attemptNumber,
          workerId,
          now,
          now,
          now,
        );

      const run = this.getRun(step.runId);
      if (run) {
        this.emitRunEvent(run.spec, "step.started", now, {
          stepId: step.id,
          attemptId,
        });
      }

      return {
        id: attemptId,
        runId: step.runId,
        stepId: step.id,
        attemptNumber,
        workerId,
      };
    });
  }

  finishAttempt(attemptId: string, input: FinishAttemptInput, now: string): void {
    this.runInTransaction(() => {
      const attempt = this.db
        .prepare(
          `SELECT id, run_id AS runId, step_id AS stepId, state
           FROM core_attempts
           WHERE id = ?`,
        )
        .get(attemptId) as
        | { id: string; runId: string; stepId: string; state: AttemptState }
        | undefined;
      if (!attempt) {
        throw new Error(`attempt not found: ${attemptId}`);
      }

      this.db
        .prepare(
          `UPDATE core_attempts
           SET state = ?, output_ref = ?, error_json = ?, finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.state,
          input.outputRef ?? null,
          input.error === undefined ? null : serializeAttemptError(input.error),
          now,
          now,
          attemptId,
        );

      const nextStepState =
        input.state === "succeeded"
          ? "succeeded"
          : input.state === "cancelled"
            ? "cancelled"
            : "failed";
      const currentStep = this.getStep(attempt.runId, attempt.stepId);
      if (!currentStep) {
        throw new Error(`step not found: ${attempt.stepId}`);
      }
      const resolvedStepState = transitionStep(currentStep.state, nextStepState);
      this.db
        .prepare(
          `UPDATE core_steps SET state = ?, updated_at = ? WHERE run_id = ? AND id = ?`,
        )
        .run(resolvedStepState, now, attempt.runId, attempt.stepId);

      if (input.state === "succeeded") {
        this.promoteDependentSteps(attempt.runId, attempt.stepId, now);
      } else if (input.state === "failed") {
        this.skipBlockedDependents(attempt.runId, now);
      }

      const run = this.getRun(attempt.runId);
      if (run) {
        this.emitRunEvent(
          run.spec,
          stepEventType(resolvedStepState),
          now,
          { stepId: attempt.stepId, attemptId: attempt.id },
          { outputRef: input.outputRef ?? null },
        );
      }

      this.refreshRunState(attempt.runId, now);
    });
  }

  claimIdempotencyKey(input: {
    idempotencyKey: string;
    runId: string;
    stepId: string;
    attemptId: string;
    now: string;
  }): IdempotencyClaim {
    return this.runInTransaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO core_idempotency_records (
            idempotency_key, run_id, step_id, attempt_id, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.idempotencyKey,
          input.runId,
          input.stepId,
          input.attemptId,
          input.now,
        ).changes;
      if (inserted === 1) {
        return { state: "claimed" };
      }

      const existing = this.db
        .prepare(
          `SELECT result_ref AS resultRef, state, attempt_id AS attemptId
           FROM core_idempotency_records
           WHERE idempotency_key = ?`,
        )
        .get(input.idempotencyKey) as
        | { resultRef: string | null; state: string; attemptId: string }
        | undefined;
      if (existing?.state === "completed" && existing.resultRef) {
        return { state: "completed", outputRef: existing.resultRef };
      }
      if (existing && IDEMPOTENCY_BLOCKED_STATES.has(existing.state)) {
        return existing.state === "uncertain"
          ? { state: "uncertain" }
          : { state: "in_progress" };
      }
      if (
        existing &&
        !IDEMPOTENCY_BLOCKED_STATES.has(existing.state) &&
        existing.state !== "completed" &&
        (existing.state === "failed" ||
          this.idempotencyOwnerIsFinished(existing.attemptId))
      ) {
        const reclaimed = this.db
          .prepare(
            `UPDATE core_idempotency_records
             SET run_id = ?, step_id = ?, attempt_id = ?, result_ref = NULL,
                 state = 'claimed', updated_at = ?
             WHERE idempotency_key = ? AND attempt_id = ? AND state != 'completed'`,
          )
          .run(
            input.runId,
            input.stepId,
            input.attemptId,
            input.now,
            input.idempotencyKey,
            existing.attemptId,
          );
        if (reclaimed.changes === 1) {
          return { state: "claimed" };
        }
      }
      return { state: "in_progress" };
    });
  }

  failIdempotencyKey(idempotencyKey: string, attemptId: string, now: string): void {
    this.db
      .prepare(
        `UPDATE core_idempotency_records
         SET state = 'failed', result_ref = NULL, updated_at = ?
         WHERE idempotency_key = ? AND attempt_id = ? AND state = 'claimed'`,
      )
      .run(now, idempotencyKey, attemptId);
  }

  markIdempotencySideEffectCommitted(
    idempotencyKey: string,
    attemptId: string,
    outputRef: string,
    now: string,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE core_idempotency_records
         SET state = 'side_effect_committed', result_ref = ?, updated_at = ?
         WHERE idempotency_key = ? AND attempt_id = ? AND state = 'claimed'`,
      )
      .run(outputRef, now, idempotencyKey, attemptId);
    if (result.changes !== 1) {
      throw new Error(`idempotency side effect commit failed: ${idempotencyKey}`);
    }
  }

  markIdempotencyValidated(
    idempotencyKey: string,
    attemptId: string,
    now: string,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE core_idempotency_records
         SET state = 'validated', updated_at = ?
         WHERE idempotency_key = ? AND attempt_id = ? AND state = 'side_effect_committed'`,
      )
      .run(now, idempotencyKey, attemptId);
    if (result.changes !== 1) {
      throw new Error(`idempotency validation mark failed: ${idempotencyKey}`);
    }
  }

  markIdempotencyUncertain(
    idempotencyKey: string,
    attemptId: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `UPDATE core_idempotency_records
         SET state = 'uncertain', updated_at = ?
         WHERE idempotency_key = ? AND attempt_id = ?
           AND state IN ('claimed', 'side_effect_committed', 'validated')`,
      )
      .run(now, idempotencyKey, attemptId);
  }

  getIdempotencyState(idempotencyKey: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT state FROM core_idempotency_records WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as { state: string } | undefined;
    return row?.state;
  }

  completeIdempotencyKey(
    idempotencyKey: string,
    attemptId: string,
    outputRef: string,
  ): void {
    const result = this.db
      .prepare(
        `UPDATE core_idempotency_records
         SET result_ref = ?, state = 'completed', updated_at = ?
         WHERE idempotency_key = ? AND attempt_id = ?
           AND state IN ('claimed', 'side_effect_committed', 'validated')`,
      )
      .run(outputRef, new Date().toISOString(), idempotencyKey, attemptId);
    if (result.changes !== 1) {
      throw new Error(`idempotency claim not owned: ${idempotencyKey}`);
    }
  }

  private idempotencyOwnerIsFinished(attemptId: string): boolean {
    const row = this.db
      .prepare("SELECT state FROM core_attempts WHERE id = ?")
      .get(attemptId) as { state: AttemptState } | undefined;
    return (
      !row ||
      row.state === "failed" ||
      row.state === "abandoned" ||
      row.state === "cancelled"
    );
  }

  getRun(runId: string): StoredRun | null {
    const row = this.db
      .prepare(
        `SELECT id, state, spec_json AS specJson, correlation_id AS correlationId,
                created_at AS createdAt, updated_at AS updatedAt
         FROM core_runs
         WHERE id = ?`,
      )
      .get(runId) as
      | {
          id: string;
          state: RunState;
          specJson: string;
          correlationId: string;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      state: row.state,
      spec: JSON.parse(row.specJson) as RunSpec,
      correlationId: row.correlationId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  findLatestRunBySessionId(sessionId: string): StoredRun | null {
    if (!sessionId) return null;
    const row = this.db
      .prepare(
        `SELECT id FROM core_runs
         WHERE json_extract(spec_json, '$.steps[0].input.sessionId') = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(sessionId) as { id: string } | undefined;
    return row ? this.getRun(row.id) : null;
  }

  getStep(runId: string, stepId: string): StoredStep | null {
    const row = this.db
      .prepare(
        `SELECT run_id AS runId, id, kind, state, depends_on_json AS dependsOnJson,
                input_json AS inputJson, workspace_binding_id AS workspaceBindingId,
                idempotency_key AS idempotencyKey, retry_json AS retryJson,
                timeout_ms AS timeoutMs, created_at AS createdAt, updated_at AS updatedAt
         FROM core_steps
         WHERE run_id = ? AND id = ?`,
      )
      .get(runId, stepId) as
      | {
          runId: string;
          id: string;
          kind: string;
          state: StepState;
          dependsOnJson: string;
          inputJson: string;
          workspaceBindingId: string | null;
          idempotencyKey: string | null;
          retryJson: string;
          timeoutMs: number;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      runId: row.runId,
      id: row.id,
      kind: row.kind,
      state: row.state,
      dependsOn: JSON.parse(row.dependsOnJson) as string[],
      input: JSON.parse(row.inputJson) as unknown,
      workspaceBindingId: row.workspaceBindingId ?? undefined,
      idempotencyKey: row.idempotencyKey ?? undefined,
      retry: JSON.parse(row.retryJson) as StepSpec["retry"],
      timeoutMs: row.timeoutMs,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  getAttempt(attemptId: string): StoredAttempt | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id AS runId, step_id AS stepId, attempt_number AS attemptNumber,
                state, worker_id AS workerId, output_ref AS outputRef,
                created_at AS createdAt, updated_at AS updatedAt
         FROM core_attempts
         WHERE id = ?`,
      )
      .get(attemptId) as StoredAttempt | undefined;
    return row ?? null;
  }

  listAttempts(runId: string, stepId: string): StoredAttempt[] {
    return this.db
      .prepare(
        `SELECT id, run_id AS runId, step_id AS stepId, attempt_number AS attemptNumber,
                state, worker_id AS workerId, output_ref AS outputRef,
                created_at AS createdAt, updated_at AS updatedAt
         FROM core_attempts
         WHERE run_id = ? AND step_id = ?
         ORDER BY attempt_number ASC`,
      )
      .all(runId, stepId) as StoredAttempt[];
  }

  listRunningAttempts(): StoredAttempt[] {
    return this.db
      .prepare(
        `SELECT id, run_id AS runId, step_id AS stepId, attempt_number AS attemptNumber,
                state, worker_id AS workerId, output_ref AS outputRef,
                created_at AS createdAt, updated_at AS updatedAt
         FROM core_attempts
         WHERE state = 'running'
         ORDER BY created_at ASC`,
      )
      .all() as StoredAttempt[];
  }

  scheduleRetry(
    input: {
      attemptId: string;
      nextAttemptAt: string;
      error: unknown;
    },
    now: string,
  ): void {
    this.runInTransaction(() => {
      const attempt = this.db
        .prepare(
          `SELECT id, run_id AS runId, step_id AS stepId
           FROM core_attempts
           WHERE id = ?`,
        )
        .get(input.attemptId) as
        | { id: string; runId: string; stepId: string }
        | undefined;
      if (!attempt) {
        throw new Error(`attempt not found: ${input.attemptId}`);
      }

      this.db
        .prepare(
          `UPDATE core_attempts
           SET state = 'failed', error_json = ?, finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(serializeAttemptError(input.error), now, now, input.attemptId);

      const currentStep = this.getStep(attempt.runId, attempt.stepId);
      if (!currentStep) {
        throw new Error(`step not found: ${attempt.stepId}`);
      }
      const waitingState = transitionStep(currentStep.state, "waiting");
      this.db
        .prepare(
          `UPDATE core_steps SET state = ?, updated_at = ? WHERE run_id = ? AND id = ?`,
        )
        .run(waitingState, now, attempt.runId, attempt.stepId);

      const waitId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO core_step_waits (
            id, run_id, step_id, attempt_id, wait_kind, wait_ref, state,
            payload_json, created_at
          ) VALUES (?, ?, ?, ?, 'retry', ?, 'waiting', ?, ?)`,
        )
        .run(
          waitId,
          attempt.runId,
          attempt.stepId,
          input.attemptId,
          waitId,
          JSON.stringify({ nextAttemptAt: input.nextAttemptAt, error: input.error }),
          now,
        );

      const run = this.getRun(attempt.runId);
      if (run) {
        this.emitRunEvent(run.spec, "step.waiting", now, {
          stepId: attempt.stepId,
          attemptId: input.attemptId,
        }, { waitId, reason: "retry" });
      }

      this.refreshRunState(attempt.runId, now);
    });
  }

  resumeDueWaits(now: string, limit: number): number {
    const waits = this.db
      .prepare(
        `SELECT id, run_id AS runId, step_id AS stepId, payload_json AS payloadJson
         FROM core_step_waits
         WHERE state = 'waiting' AND wait_kind = 'retry'
         ORDER BY created_at ASC`,
      )
      .all() as Array<{
        id: string;
        runId: string;
        stepId: string;
        payloadJson: string;
      }>;

    let resumed = 0;
    for (const wait of waits) {
      if (resumed >= limit) {
        break;
      }
      const payload = JSON.parse(wait.payloadJson) as { nextAttemptAt?: string };
      if (payload.nextAttemptAt && payload.nextAttemptAt > now) {
        continue;
      }
      this.runInTransaction(() => {
        const changed = this.db
          .prepare(
            `UPDATE core_step_waits
             SET state = 'resolved', resolved_at = ?
             WHERE id = ? AND state = 'waiting'`,
          )
          .run(now, wait.id).changes;
        if (changed !== 1) {
          return;
        }
        const step = this.getStep(wait.runId, wait.stepId);
        if (!step || step.state !== "waiting") {
          return;
        }
        this.db
          .prepare(
            `UPDATE core_steps
             SET state = 'runnable', updated_at = ?
             WHERE run_id = ? AND id = ? AND state = 'waiting'`,
          )
          .run(now, wait.runId, wait.stepId);

        const run = this.getRun(wait.runId);
        if (run) {
          this.emitRunEvent(run.spec, "step.resumed", now, {
            stepId: wait.stepId,
          }, { waitId: wait.id });
        }
      });
      resumed += 1;
    }
    return resumed;
  }

  resumeWait(waitId: string, payload: unknown, now: string): void {
    this.runInTransaction(() => {
      const wait = this.db
        .prepare(
          `SELECT id, run_id AS runId, step_id AS stepId, state
           FROM core_step_waits
           WHERE id = ?`,
        )
        .get(waitId) as
        | { id: string; runId: string; stepId: string; state: string }
        | undefined;
      if (!wait || wait.state !== "waiting") {
        throw new Error(`wait not found or not waiting: ${waitId}`);
      }

      this.db
        .prepare(
          `UPDATE core_step_waits
           SET state = 'resolved', resolved_at = ?, payload_json = ?
           WHERE id = ?`,
        )
        .run(now, JSON.stringify(payload), waitId);

      this.db
        .prepare(
          `UPDATE core_steps
           SET state = 'runnable', updated_at = ?
           WHERE run_id = ? AND id = ? AND state = 'waiting'`,
        )
        .run(now, wait.runId, wait.stepId);

      const run = this.getRun(wait.runId);
      if (run) {
        this.emitRunEvent(run.spec, "step.resumed", now, {
          stepId: wait.stepId,
        }, { waitId, payload });
      }
    });
  }

  getActiveWait(
    runId: string,
    stepId: string,
  ): { id: string; runId: string; stepId: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id AS runId, step_id AS stepId
         FROM core_step_waits
         WHERE run_id = ? AND step_id = ? AND state = 'waiting'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(runId, stepId) as
      | { id: string; runId: string; stepId: string }
      | undefined;
    return row ?? null;
  }

  getLatestResolvedWait(
    runId: string,
    stepId: string,
  ): { payload: unknown } | null {
    const row = this.db
      .prepare(
        `SELECT payload_json AS payloadJson
         FROM core_step_waits
         WHERE run_id = ? AND step_id = ? AND state = 'resolved'
         ORDER BY resolved_at DESC
         LIMIT 1`,
      )
      .get(runId, stepId) as { payloadJson: string } | undefined;
    return row ? { payload: JSON.parse(row.payloadJson) as unknown } : null;
  }

  cancelRun(runId: string, reason: string, now: string): void {
    this.runInTransaction(() => {
      const run = this.getRun(runId);
      if (!run || isTerminalRunState(run.state)) {
        return;
      }

      this.db
        .prepare(
          `UPDATE core_attempts
           SET state = 'cancelled', finished_at = ?, updated_at = ?
           WHERE run_id = ? AND state IN ('created', 'running', 'waiting')`,
        )
        .run(now, now, runId);

      this.db
        .prepare(
          `UPDATE core_steps
           SET state = 'cancelled', updated_at = ?
           WHERE run_id = ? AND state NOT IN ('succeeded', 'failed', 'skipped', 'cancelled')`,
        )
        .run(now, runId);

      this.updateRunState(runId, "cancelled", now);
    });
  }

  enterStepWait(
    attemptId: string,
    waitKind: string,
    waitReason: unknown,
    now: string,
  ): string {
    let waitId = "";
    this.runInTransaction(() => {
      const attempt = this.db
        .prepare(
          `SELECT id, run_id AS runId, step_id AS stepId
           FROM core_attempts WHERE id = ?`,
        )
        .get(attemptId) as
        | { id: string; runId: string; stepId: string }
        | undefined;
      if (!attempt) {
        throw new Error(`attempt not found: ${attemptId}`);
      }

      this.db
        .prepare(
          `UPDATE core_attempts
           SET state = 'abandoned', finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, attemptId);

      const step = this.getStep(attempt.runId, attempt.stepId);
      if (!step) {
        throw new Error(`step not found: ${attempt.stepId}`);
      }
      const waitingState = transitionStep(step.state, "waiting");
      this.db
        .prepare(
          `UPDATE core_steps SET state = ?, updated_at = ? WHERE run_id = ? AND id = ?`,
        )
        .run(waitingState, now, attempt.runId, attempt.stepId);

      waitId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO core_step_waits (
            id, run_id, step_id, attempt_id, wait_kind, wait_ref, state,
            payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
        )
        .run(
          waitId,
          attempt.runId,
          attempt.stepId,
          attemptId,
          waitKind,
          waitId,
          JSON.stringify(waitReason),
          now,
        );

      const run = this.getRun(attempt.runId);
      if (run) {
        this.emitRunEvent(run.spec, "step.waiting", now, {
          stepId: attempt.stepId,
          attemptId,
        }, { waitId, reason: waitKind });
      }

      this.refreshRunState(attempt.runId, now);
    });
    return waitId;
  }

  abandonAttemptForManualReview(attemptId: string, now: string): void {
    this.runInTransaction(() => {
      const attempt = this.db
        .prepare(
          `SELECT id, run_id AS runId, step_id AS stepId
           FROM core_attempts WHERE id = ?`,
        )
        .get(attemptId) as
        | { id: string; runId: string; stepId: string }
        | undefined;
      if (!attempt) {
        throw new Error(`attempt not found: ${attemptId}`);
      }

      this.db
        .prepare(
          `UPDATE core_attempts
           SET state = 'abandoned', finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, attemptId);

      const step = this.getStep(attempt.runId, attempt.stepId);
      if (!step) {
        return;
      }
      const waitingState = transitionStep(step.state, "waiting");
      this.db
        .prepare(
          `UPDATE core_steps SET state = ?, updated_at = ? WHERE run_id = ? AND id = ?`,
        )
        .run(waitingState, now, attempt.runId, attempt.stepId);

      const waitId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO core_step_waits (
            id, run_id, step_id, attempt_id, wait_kind, wait_ref, state,
            payload_json, created_at
          ) VALUES (?, ?, ?, ?, 'manual_review', ?, 'waiting', ?, ?)`,
        )
        .run(
          waitId,
          attempt.runId,
          attempt.stepId,
          attemptId,
          waitId,
          JSON.stringify({ reason: "interrupted_non_idempotent" }),
          now,
        );

      const run = this.getRun(attempt.runId);
      if (run) {
        this.emitRunEvent(run.spec, "step.waiting", now, {
          stepId: attempt.stepId,
          attemptId,
        }, { waitId, reason: "manual_review" });
      }

      this.refreshRunState(attempt.runId, now);
    });
  }

  abandonAttemptAndRetryStep(attemptId: string, now: string): void {
    this.runInTransaction(() => {
      const attempt = this.db
        .prepare(
          `SELECT id, run_id AS runId, step_id AS stepId
           FROM core_attempts WHERE id = ?`,
        )
        .get(attemptId) as
        | { id: string; runId: string; stepId: string }
        | undefined;
      if (!attempt) {
        throw new Error(`attempt not found: ${attemptId}`);
      }

      this.db
        .prepare(
          `UPDATE core_attempts
           SET state = 'abandoned', finished_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, attemptId);

      const step = this.getStep(attempt.runId, attempt.stepId);
      if (!step) {
        return;
      }
      this.db
        .prepare(
          `UPDATE core_steps
           SET state = 'runnable', updated_at = ?
           WHERE run_id = ? AND id = ?`,
        )
        .run(now, attempt.runId, attempt.stepId);

      const run = this.getRun(attempt.runId);
      if (run) {
        this.emitRunEvent(run.spec, "step.resumed", now, {
          stepId: attempt.stepId,
          attemptId,
        }, { reason: "recovery_retry" });
      }

      this.refreshRunState(attempt.runId, now);
    });
  }

  loadRecoverableRuns(): StoredRun[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT r.id, r.state, r.spec_json AS specJson,
                r.correlation_id AS correlationId,
                r.created_at AS createdAt, r.updated_at AS updatedAt
         FROM core_runs r
         LEFT JOIN core_steps s ON s.run_id = r.id
         LEFT JOIN core_attempts a ON a.run_id = r.id
         WHERE r.state IN ('running', 'waiting')
            OR s.state IN ('running', 'waiting', 'runnable')
            OR a.state IN ('running', 'waiting', 'created')
         ORDER BY r.created_at`,
      )
      .all() as Array<{
        id: string;
        state: RunState;
        specJson: string;
        correlationId: string;
        createdAt: string;
        updatedAt: string;
      }>;

    return rows.map((row) => ({
      id: row.id,
      state: row.state,
      spec: JSON.parse(row.specJson) as RunSpec,
      correlationId: row.correlationId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  private runInTransaction<T>(operation: () => T, immediate = false): T {
    const transaction = this.db.transaction(operation);
    let committed = false;
    try {
      const result = immediate ? transaction.immediate() : transaction();
      committed = true;
      this.eventTransactionObserver?.onCommitted();
      return result;
    } catch (error) {
      if (!committed) {
        this.eventTransactionObserver?.onRolledBack();
      }
      throw error;
    }
  }

  private promoteDependentSteps(
    runId: string,
    completedStepId: string,
    now: string,
  ): void {
    const dependents = this.db
      .prepare(
        `SELECT step_id AS stepId
         FROM core_step_dependencies
         WHERE run_id = ? AND depends_on_step_id = ?`,
      )
      .all(runId, completedStepId) as Array<{ stepId: string }>;

    for (const dependent of dependents) {
      const step = this.getStep(runId, dependent.stepId);
      if (!step || step.state !== "pending") {
        continue;
      }
      const deps = this.db
        .prepare(
          `SELECT depends_on_step_id AS dependsOnStepId
           FROM core_step_dependencies
           WHERE run_id = ? AND step_id = ?`,
        )
        .all(runId, dependent.stepId) as Array<{ dependsOnStepId: string }>;
      const allSucceeded = deps.every((dep) => {
        const dependency = this.getStep(runId, dep.dependsOnStepId);
        return dependency?.state === "succeeded";
      });
      if (!allSucceeded) {
        continue;
      }
      this.db
        .prepare(
          `UPDATE core_steps
           SET state = 'runnable', updated_at = ?
           WHERE run_id = ? AND id = ? AND state = 'pending'`,
        )
        .run(now, runId, dependent.stepId);
    }
  }

  private skipBlockedDependents(runId: string, now: string): void {
    let changed = true;
    while (changed) {
      changed = false;
      const candidates = this.db
        .prepare(
          `SELECT id
           FROM core_steps
           WHERE run_id = ? AND state = 'pending'
           ORDER BY id`,
        )
        .all(runId) as Array<{ id: string }>;

      for (const candidate of candidates) {
        const blockers = this.db
          .prepare(
            `SELECT dependency.state
             FROM core_step_dependencies edge
             JOIN core_steps dependency
               ON dependency.run_id = edge.run_id
              AND dependency.id = edge.depends_on_step_id
             WHERE edge.run_id = ? AND edge.step_id = ?`,
          )
          .all(runId, candidate.id) as Array<{ state: StepState }>;
        if (
          !blockers.some((dependency) =>
            dependency.state === "failed" ||
            dependency.state === "skipped" ||
            dependency.state === "cancelled"
          )
        ) {
          continue;
        }

        const result = this.db
          .prepare(
            `UPDATE core_steps
             SET state = 'skipped', updated_at = ?
             WHERE run_id = ? AND id = ? AND state = 'pending'`,
          )
          .run(now, runId, candidate.id);
        if (result.changes !== 1) {
          continue;
        }
        changed = true;
        const run = this.getRun(runId);
        if (run) {
          this.emitRunEvent(
            run.spec,
            "step.skipped",
            now,
            { stepId: candidate.id },
            { reason: "dependency_failed" },
          );
        }
      }
    }
  }

  private refreshRunState(runId: string, now: string): void {
    const run = this.getRun(runId);
    if (!run) {
      return;
    }

    const steps = this.db
      .prepare(
        `SELECT state FROM core_steps WHERE run_id = ? ORDER BY id`,
      )
      .all(runId) as Array<{ state: StepState }>;
    if (steps.length === 0) {
      return;
    }

    if (steps.some((step) => step.state === "running" || step.state === "waiting")) {
      if (run.state !== "running") {
        this.updateRunState(runId, transitionRun(run.state, "running"), now);
      }
      return;
    }

    if (steps.some((step) => step.state === "runnable" || step.state === "pending")) {
      if (run.state !== "running") {
        this.updateRunState(runId, transitionRun(run.state, "running"), now);
      }
      return;
    }

    if (steps.every((step) => step.state === "succeeded" || step.state === "skipped")) {
      this.updateRunState(runId, transitionRun(run.state, "succeeded"), now);
      return;
    }

    if (steps.some((step) => step.state === "failed")) {
      this.updateRunState(runId, transitionRun(run.state, "failed"), now);
      return;
    }

    if (steps.every((step) => step.state === "cancelled")) {
      this.updateRunState(runId, transitionRun(run.state, "cancelled"), now);
    }
  }

  private updateRunState(runId: string, state: RunState, now: string): void {
    const current = this.getRun(runId);
    if (!current || current.state === state) {
      return;
    }
    const nextState = transitionRun(current.state, state);
    this.db
      .prepare(`UPDATE core_runs SET state = ?, updated_at = ? WHERE id = ?`)
      .run(nextState, now, runId);

    const eventType = runEventType(nextState);
    if (eventType) {
      this.emitRunEvent(current.spec, eventType, now);
    }
  }

  private emitRunEvent(
    spec: RunSpec,
    type: string,
    now: string,
    ids?: { stepId?: string; attemptId?: string },
    data: unknown = {},
  ): void {
    this.appendEvent(this.db, {
      eventId: randomUUID(),
      type,
      subject: spec.actingSubject,
      correlationId: spec.correlationId,
      runId: spec.id,
      stepId: ids?.stepId,
      attemptId: ids?.attemptId,
      occurredAt: now,
      data,
    });
  }
}

function assertAcyclic(spec: RunSpec): void {
  const graph = new Map<string, string[]>();
  for (const step of spec.steps) {
    graph.set(step.id, [...step.dependsOn]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string): void => {
    if (visited.has(node)) {
      return;
    }
    if (visiting.has(node)) {
      throw new Error(`cycle detected in run spec: ${node}`);
    }
    visiting.add(node);
    for (const dependency of graph.get(node) ?? []) {
      if (!graph.has(dependency)) {
        throw new Error(`unknown dependency: ${dependency}`);
      }
      visit(dependency);
    }
    visiting.delete(node);
    visited.add(node);
  };

  for (const stepId of graph.keys()) {
    visit(stepId);
  }
}

function stepEventType(state: StepState): string {
  switch (state) {
    case "succeeded":
      return "step.succeeded";
    case "cancelled":
      return "step.cancelled";
    default:
      return "step.failed";
  }
}

function serializeAttemptError(error: unknown): string {
  if (error instanceof Error) {
    return JSON.stringify({
      name: error.name,
      message: error.message,
      ...Object.fromEntries(
        Object.entries(error as unknown as Record<string, unknown>).filter(
          ([, value]) => value !== undefined,
        ),
      ),
    });
  }
  return JSON.stringify(error);
}

function runEventType(state: RunState): string | null {
  switch (state) {
    case "succeeded":
      return "run.succeeded";
    case "failed":
      return "run.failed";
    case "cancelled":
      return "run.cancelled";
    default:
      return null;
  }
}
