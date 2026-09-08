export interface SubjectRef {
  kind: string;
  id: string;
}

export type RunState =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type StepState =
  | "pending"
  | "runnable"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type AttemptState =
  | "created"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "abandoned"
  | "cancelled";

export interface StepRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface StepSpec {
  id: string;
  kind: string;
  dependsOn: string[];
  input: unknown;
  workspaceBindingId?: string;
  idempotencyKey?: string;
  retry: StepRetryPolicy;
  timeoutMs: number;
}

export interface RunSpec {
  id: string;
  requestedBy: SubjectRef;
  actingSubject: SubjectRef;
  objective: string;
  steps: StepSpec[];
  budgetAccountId?: string;
  policyContext: Record<string, unknown>;
  correlationId: string;
}
