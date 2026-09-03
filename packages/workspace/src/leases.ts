import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Database } from "@forge/store";

export class WorkspaceConflictError extends Error {
  readonly code = "WORKSPACE_CONFLICT" as const;

  constructor(message = "WORKSPACE_CONFLICT") {
    super(message);
    this.name = "WorkspaceConflictError";
  }
}

export class WorkspaceLeaseExpiredError extends Error {
  readonly code = "WORKSPACE_LEASE_EXPIRED" as const;

  constructor(message = "WORKSPACE_LEASE_EXPIRED") {
    super(message);
    this.name = "WorkspaceLeaseExpiredError";
  }
}

export interface AcquireLeaseInput {
  id?: string;
  workspaceId: string;
  runId: string;
  stepId?: string;
  attemptId?: string;
  mode: "read" | "write";
  rootPath: string;
  expiresAt: string;
}

export interface WorkspaceLease {
  id: string;
  workspaceId: string;
  runId: string;
  stepId?: string;
  attemptId?: string;
  mode: "read" | "write";
  rootPath: string;
  acquiredAt: string;
  expiresAt: string;
  releasedAt?: string;
  releasedReason?: string;
}

export class WorkspaceLeaseService {
  constructor(private readonly db: Database) {}

  acquire(input: AcquireLeaseInput): WorkspaceLease {
    const rootPath = realpathSync.native(input.rootPath);
    const acquiredAt = new Date().toISOString();
    const leaseId = input.id ?? randomUUID();

    const workspace = this.db
      .prepare(
        `SELECT canonical_root_path
         FROM core_workspaces
         WHERE id = ?`,
      )
      .get(input.workspaceId) as { canonical_root_path: string } | undefined;
    if (!workspace) {
      throw new Error(`workspace not found: ${input.workspaceId}`);
    }
    if (workspace.canonical_root_path !== rootPath) {
      throw new WorkspaceConflictError(
        `requested root path does not match registered workspace canonical root`,
      );
    }

    return this.db.transaction(() => {
      if (input.mode === "write") {
        const active = this.db
          .prepare(
            `SELECT id, expires_at
             FROM core_workspace_leases
             WHERE workspace_id = ?
               AND mode = 'write'
               AND released_at IS NULL`,
          )
          .get(input.workspaceId) as { id: string; expires_at: string } | undefined;

        if (active) {
          if (active.expires_at <= acquiredAt) {
            throw new WorkspaceLeaseExpiredError(
              `workspace ${input.workspaceId} has an expired write lease pending recovery`,
            );
          }
          throw new WorkspaceConflictError(
            `workspace ${input.workspaceId} already has an active write lease`,
          );
        }
      }

      this.db
        .prepare(
          `INSERT INTO core_workspace_leases (
            id, workspace_id, run_id, step_id, attempt_id, mode, root_path,
            acquired_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          leaseId,
          input.workspaceId,
          input.runId,
          input.stepId ?? null,
          input.attemptId ?? null,
          input.mode,
          rootPath,
          acquiredAt,
          input.expiresAt,
        );

      return {
        id: leaseId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        mode: input.mode,
        rootPath,
        acquiredAt,
        expiresAt: input.expiresAt,
      };
    })();
  }

  renew(leaseId: string, expiresAt: string): WorkspaceLease {
    const renewedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE core_workspace_leases
         SET expires_at = ?
         WHERE id = ? AND released_at IS NULL`,
      )
      .run(expiresAt, leaseId);
    if (result.changes !== 1) {
      throw new Error(`lease not found or already released: ${leaseId}`);
    }
    return this.getLease(leaseId);
  }

  release(leaseId: string, reason = "released"): WorkspaceLease {
    const releasedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE core_workspace_leases
         SET released_at = ?, released_reason = ?
         WHERE id = ? AND released_at IS NULL`,
      )
      .run(releasedAt, reason, leaseId);
    if (result.changes !== 1) {
      throw new Error(`lease not found or already released: ${leaseId}`);
    }
    return this.getLease(leaseId);
  }

  getLease(leaseId: string): WorkspaceLease {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, run_id, step_id, attempt_id, mode, root_path,
                acquired_at, expires_at, released_at, released_reason
         FROM core_workspace_leases
         WHERE id = ?`,
      )
      .get(leaseId) as {
      id: string;
      workspace_id: string;
      run_id: string;
      step_id: string | null;
      attempt_id: string | null;
      mode: "read" | "write";
      root_path: string;
      acquired_at: string;
      expires_at: string;
      released_at: string | null;
      released_reason: string | null;
    } | undefined;
    if (!row) {
      throw new Error(`lease not found: ${leaseId}`);
    }
    return mapLease(row);
  }
}

function mapLease(row: {
  id: string;
  workspace_id: string;
  run_id: string;
  step_id: string | null;
  attempt_id: string | null;
  mode: "read" | "write";
  root_path: string;
  acquired_at: string;
  expires_at: string;
  released_at: string | null;
  released_reason: string | null;
}): WorkspaceLease {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    mode: row.mode,
    rootPath: row.root_path,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at ?? undefined,
    releasedReason: row.released_reason ?? undefined,
  };
}

export { mapLease };
