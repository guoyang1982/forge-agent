import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { transitionRun, transitionStep } from "./state-machine.js";
import type {
  AttemptState,
  RunSpec,
  RunState,
  StepSpec,
  StepState,
} from "./types.js";

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

export class ExecutionStore {
  constructor(private readonly db: Database.Database) {}

  createRun(spec: RunSpec, now: string): StoredRun {
    assertAcyclic(spec);

    const create = this.db.transaction(() => {
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
    });
    create.immediate();

    return this.getRun(spec.id)!;
  }

  claimNextStep(
    runId: string,
    workerId: string,
    now: string,
  ): ClaimedAttempt | null {
    return this.db.transaction(() => {
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

      return {
        id: attemptId,
        runId: step.runId,
        stepId: step.id,
        attemptNumber,
        workerId,
      };
    })();
  }

  finishAttempt(attemptId: string, input: FinishAttemptInput, now: string): void {
    this.db.transaction(() => {
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
          input.error === undefined ? null : JSON.stringify(input.error),
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
      }

      this.refreshRunState(attempt.runId, now);
    })();
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
    this.db
      .prepare(`UPDATE core_runs SET state = ?, updated_at = ? WHERE id = ?`)
      .run(state, now, runId);
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
