import type { Database } from "@forge/store";
import { randomUUID } from "node:crypto";

export interface TriggerAcceptInput {
  source: string;
  externalId: string;
}

export interface TriggerStoreOptions {
  ownerId?: string;
  leaseTtlMs?: number;
}

type TriggerReceiptRow = {
  state: string;
  claimed_by: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  attempt: number;
};

export class TriggerLeaseError extends Error {
  constructor(message = "trigger lease rejected") {
    super(message);
    this.name = "TriggerLeaseError";
  }
}

export class TriggerStore {
  private readonly ownerId: string;
  private readonly leaseTtlMs: number;

  constructor(
    private readonly db: Database,
    options: TriggerStoreOptions = {},
  ) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseTtlMs = options.leaseTtlMs ?? 5 * 60_000;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS core_workflow_trigger_receipts (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'completed',
        claimed_by TEXT,
        updated_at TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source, external_id)
      );
    `);
    this.ensureRecoveryColumns();
  }

  get owner(): string {
    return this.ownerId;
  }

  accept(input: TriggerAcceptInput): { accepted: boolean; leaseToken?: string } {
    const acceptedAt = new Date().toISOString();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + this.leaseTtlMs).toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO core_workflow_trigger_receipts (
          source, external_id, accepted_at, state, claimed_by, updated_at,
          lease_token, lease_expires_at, heartbeat_at, attempt
        ) VALUES (?, ?, ?, 'processing', ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        input.source,
        input.externalId,
        acceptedAt,
        this.ownerId,
        acceptedAt,
        leaseToken,
        leaseExpiresAt,
        acceptedAt,
      );
    if (result.changes === 1) {
      return { accepted: true, leaseToken };
    }
    const reclaimed = this.db
      .prepare(
        `UPDATE core_workflow_trigger_receipts
         SET state = 'processing', claimed_by = ?, updated_at = ?,
             lease_token = ?, lease_expires_at = ?, heartbeat_at = ?,
             attempt = attempt + 1
         WHERE source = ? AND external_id = ? AND state = 'pending'`,
      )
      .run(
        this.ownerId,
        acceptedAt,
        leaseToken,
        leaseExpiresAt,
        acceptedAt,
        input.source,
        input.externalId,
      );
    if (reclaimed.changes === 1) {
      return { accepted: true, leaseToken };
    }
    return { accepted: false };
  }

  heartbeat(input: TriggerAcceptInput, leaseToken: string): void {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + this.leaseTtlMs).toISOString();
    const updated = this.db
      .prepare(
        `UPDATE core_workflow_trigger_receipts
         SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
         WHERE source = ? AND external_id = ?
           AND state = 'processing' AND claimed_by = ? AND lease_token = ?`,
      )
      .run(
        now,
        leaseExpiresAt,
        now,
        input.source,
        input.externalId,
        this.ownerId,
        leaseToken,
      );
    if (updated.changes !== 1) {
      throw new TriggerLeaseError("heartbeat rejected for trigger receipt");
    }
  }

  complete(input: TriggerAcceptInput, leaseToken: string): void {
    const updated = this.db
      .prepare(
        `UPDATE core_workflow_trigger_receipts
         SET state = 'completed', updated_at = ?
         WHERE source = ? AND external_id = ?
           AND state = 'processing' AND claimed_by = ? AND lease_token = ?`,
      )
      .run(
        new Date().toISOString(),
        input.source,
        input.externalId,
        this.ownerId,
        leaseToken,
      );
    if (updated.changes !== 1) {
      throw new TriggerLeaseError("complete rejected for trigger receipt");
    }
  }

  fail(input: TriggerAcceptInput, leaseToken: string): void {
    const updated = this.db
      .prepare(
        `UPDATE core_workflow_trigger_receipts
         SET state = 'pending', claimed_by = NULL, lease_token = NULL,
             lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?
         WHERE source = ? AND external_id = ?
           AND state = 'processing' AND claimed_by = ? AND lease_token = ?`,
      )
      .run(
        new Date().toISOString(),
        input.source,
        input.externalId,
        this.ownerId,
        leaseToken,
      );
    if (updated.changes !== 1) {
      throw new TriggerLeaseError("fail rejected for trigger receipt");
    }
  }

  recoverIncomplete(now = new Date().toISOString()): number {
    return this.db
      .prepare(
        `UPDATE core_workflow_trigger_receipts
         SET state = 'pending', claimed_by = NULL, lease_token = NULL,
             lease_expires_at = NULL, heartbeat_at = NULL, updated_at = ?
         WHERE state = 'processing'
           AND claimed_by != ?
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?`,
      )
      .run(now, this.ownerId, now).changes;
  }

  getReceipt(input: TriggerAcceptInput): TriggerReceiptRow | undefined {
    return this.db
      .prepare(
        `SELECT state, claimed_by, lease_token, lease_expires_at, heartbeat_at, attempt
         FROM core_workflow_trigger_receipts
         WHERE source = ? AND external_id = ?`,
      )
      .get(input.source, input.externalId) as TriggerReceiptRow | undefined;
  }

  private ensureRecoveryColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(core_workflow_trigger_receipts)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (!columns.has("state")) {
      this.db.exec(
        "ALTER TABLE core_workflow_trigger_receipts ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'",
      );
    }
    if (!columns.has("claimed_by")) {
      this.db.exec(
        "ALTER TABLE core_workflow_trigger_receipts ADD COLUMN claimed_by TEXT",
      );
    }
    if (!columns.has("updated_at")) {
      this.db.exec(
        "ALTER TABLE core_workflow_trigger_receipts ADD COLUMN updated_at TEXT",
      );
    }
    if (!columns.has("lease_token")) {
      this.db.exec(
        "ALTER TABLE core_workflow_trigger_receipts ADD COLUMN lease_token TEXT",
      );
    }
    if (!columns.has("lease_expires_at")) {
      this.db.exec(
        "ALTER TABLE core_workflow_trigger_receipts ADD COLUMN lease_expires_at TEXT",
      );
    }
    if (!columns.has("heartbeat_at")) {
      this.db.exec(
        "ALTER TABLE core_workflow_trigger_receipts ADD COLUMN heartbeat_at TEXT",
      );
    }
    if (!columns.has("attempt")) {
      this.db.exec(
        "ALTER TABLE core_workflow_trigger_receipts ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0",
      );
    }
  }
}
