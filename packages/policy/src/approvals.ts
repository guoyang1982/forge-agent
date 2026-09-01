import { createHash, randomUUID } from "node:crypto";
import type { SubjectRef } from "@forge/protocol";
import type { Database } from "@forge/store";
import type { ResourceRef, RiskLevel } from "./types.js";

export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "revoked";

export interface ApprovalRecord {
  id: string;
  subject: SubjectRef;
  action: string;
  resource: ResourceRef;
  parametersHash: string;
  parametersSummary: string;
  risk: RiskLevel;
  estimatedCostMinor?: bigint;
  policyVersionId: string;
  state: ApprovalState;
  runId?: string;
  stepId?: string;
  attemptId?: string;
  expiresAt: string;
  createdAt: string;
  decidedAt?: string;
  decision?: {
    decision: "approved" | "denied";
    actor: SubjectRef;
    reason?: string;
    decidedAt: string;
  };
}

export interface RequestApprovalInput {
  id?: string;
  subject: SubjectRef;
  action: string;
  resource: ResourceRef;
  parametersHash?: string;
  parametersSummary: string;
  parameters?: Record<string, unknown>;
  risk: RiskLevel;
  estimatedCostMinor?: bigint;
  policyVersionId: string;
  expiresAt: string;
  runId?: string;
  stepId?: string;
  attemptId?: string;
}

export interface ApprovalDecisionInput {
  decision: "approved" | "denied";
  actor: SubjectRef;
  reason?: string;
  parametersHash?: string;
}

export class ApprovalAlreadyDecidedError extends Error {
  constructor(message = "already decided") {
    super(message);
    this.name = "ApprovalAlreadyDecidedError";
  }
}

export class ApprovalHashMismatchError extends Error {
  constructor(message = "parameters hash mismatch") {
    super(message);
    this.name = "ApprovalHashMismatchError";
  }
}

export class ApprovalService {
  constructor(private readonly db: Database) {}

  requestApproval(input: RequestApprovalInput): ApprovalRecord {
    const id = input.id ?? randomUUID();
    const createdAt = new Date().toISOString();
    const parametersHash =
      input.parametersHash ?? hashApprovalParameters(input.parameters ?? {});

    this.db
      .prepare(
        `INSERT INTO core_approvals (
          id, subject_kind, subject_id, action, resource_kind, resource_id,
          parameters_hash, parameters_summary, risk, estimated_cost_minor,
          policy_version_id, state, run_id, step_id, attempt_id,
          expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.subject.kind,
        input.subject.id,
        input.action,
        input.resource.kind,
        input.resource.id,
        parametersHash,
        input.parametersSummary,
        input.risk,
        input.estimatedCostMinor == null ? null : Number(input.estimatedCostMinor),
        input.policyVersionId,
        input.runId ?? null,
        input.stepId ?? null,
        input.attemptId ?? null,
        input.expiresAt,
        createdAt,
      );

    return this.getApproval(id);
  }

  decide(approvalId: string, input: ApprovalDecisionInput): ApprovalRecord {
    const approval = this.getApproval(approvalId);
    if (approval.state !== "pending") {
      throw new ApprovalAlreadyDecidedError();
    }
    if (input.parametersHash && input.parametersHash !== approval.parametersHash) {
      throw new ApprovalHashMismatchError();
    }

    const decidedAt = new Date().toISOString();
    const decisionId = randomUUID();
    const nextState = input.decision === "approved" ? "approved" : "denied";

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO core_approval_decisions (
            id, approval_id, decision, actor_kind, actor_id, reason, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decisionId,
          approvalId,
          input.decision,
          input.actor.kind,
          input.actor.id,
          input.reason ?? null,
          decidedAt,
        );
      this.db
        .prepare(
          `UPDATE core_approvals
           SET state = ?, decided_at = ?
           WHERE id = ?`,
        )
        .run(nextState, decidedAt, approvalId);
    })();

    return this.getApproval(approvalId);
  }

  expire(approvalId: string): ApprovalRecord {
    const approval = this.getApproval(approvalId);
    if (approval.state !== "pending") {
      return approval;
    }
    const decidedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE core_approvals
         SET state = 'expired', decided_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(decidedAt, approvalId);
    return this.getApproval(approvalId);
  }

  revoke(approvalId: string, reason = "revoked"): ApprovalRecord {
    const approval = this.getApproval(approvalId);
    if (approval.state !== "pending") {
      throw new ApprovalAlreadyDecidedError("approval is not pending");
    }
    const decidedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE core_approvals
         SET state = 'revoked', decided_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(decidedAt, approvalId);
    void reason;
    return this.getApproval(approvalId);
  }

  listPending(subject?: SubjectRef): ApprovalRecord[] {
    const now = new Date().toISOString();
    const rows = subject
      ? (this.db
          .prepare(
            `SELECT id FROM core_approvals
             WHERE state = 'pending' AND expires_at > ?
               AND subject_kind = ? AND subject_id = ?
             ORDER BY created_at`,
          )
          .all(now, subject.kind, subject.id) as Array<{ id: string }>)
      : (this.db
          .prepare(
            `SELECT id FROM core_approvals
             WHERE state = 'pending' AND expires_at > ?
             ORDER BY created_at`,
          )
          .all(now) as Array<{ id: string }>);
    return rows.map((row) => this.getApproval(row.id));
  }

  getApproval(approvalId: string): ApprovalRecord {
    const row = this.db
      .prepare(
        `SELECT id, subject_kind, subject_id, action, resource_kind, resource_id,
                parameters_hash, parameters_summary, risk, estimated_cost_minor,
                policy_version_id, state, run_id, step_id, attempt_id,
                expires_at, created_at, decided_at
         FROM core_approvals
         WHERE id = ?`,
      )
      .get(approvalId) as ApprovalRow | undefined;
    if (!row) {
      throw new Error(`approval not found: ${approvalId}`);
    }

    const decision = this.db
      .prepare(
        `SELECT decision, actor_kind, actor_id, reason, decided_at
         FROM core_approval_decisions
         WHERE approval_id = ?`,
      )
      .get(approvalId) as DecisionRow | undefined;

    return mapApproval(row, decision);
  }
}

type ApprovalRow = {
  id: string;
  subject_kind: string;
  subject_id: string;
  action: string;
  resource_kind: string;
  resource_id: string;
  parameters_hash: string;
  parameters_summary: string;
  risk: RiskLevel;
  estimated_cost_minor: number | null;
  policy_version_id: string;
  state: ApprovalState;
  run_id: string | null;
  step_id: string | null;
  attempt_id: string | null;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
};

type DecisionRow = {
  decision: "approved" | "denied";
  actor_kind: string;
  actor_id: string;
  reason: string | null;
  decided_at: string;
};

function mapApproval(row: ApprovalRow, decision?: DecisionRow): ApprovalRecord {
  return {
    id: row.id,
    subject: { kind: row.subject_kind, id: row.subject_id },
    action: row.action,
    resource: { kind: row.resource_kind, id: row.resource_id },
    parametersHash: row.parameters_hash,
    parametersSummary: row.parameters_summary,
    risk: row.risk,
    estimatedCostMinor:
      row.estimated_cost_minor == null ? undefined : BigInt(row.estimated_cost_minor),
    policyVersionId: row.policy_version_id,
    state: row.state,
    runId: row.run_id ?? undefined,
    stepId: row.step_id ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
    decision: decision
      ? {
          decision: decision.decision,
          actor: { kind: decision.actor_kind, id: decision.actor_id },
          reason: decision.reason ?? undefined,
          decidedAt: decision.decided_at,
        }
      : undefined,
  };
}

export function hashApprovalParameters(parameters: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parameters)).digest("hex");
}

export { mapApproval };
