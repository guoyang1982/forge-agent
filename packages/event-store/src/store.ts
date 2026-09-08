import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { EventEnvelope } from "@forge/protocol";
import type { NewEvent, OutboxClaim, OutboxState, SubscriptionFilter } from "./types.js";
import { DEFAULT_OUTBOX_LEASE_MS } from "./types.js";

const DEFAULT_DESTINATION = "internal";
const DEFAULT_SCHEMA_VERSION = 1;

interface StoredEventRow {
  sequence: number;
  eventId: string;
  eventType: string;
  envelopeJson: string;
  occurredAt: string;
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
  correlationId: string | null;
}

export class EventStore {
  constructor(private readonly db: Database.Database) {}

  append<T>(event: NewEvent<T>): EventEnvelope<T> {
    return this.db.transaction(() =>
      EventStore.appendInTransaction(this.db, event),
    )();
  }

  static appendInTransaction<T>(
    db: Database.Database,
    event: NewEvent<T>,
  ): EventEnvelope<T> {
    const envelope = toEnvelope(event);
    const destination = event.destination ?? DEFAULT_DESTINATION;
    const now = event.occurredAt;

    try {
      const result = db
        .prepare(
          `INSERT INTO core_events (
            event_id, event_type, envelope_json, occurred_at,
            run_id, step_id, attempt_id, correlation_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.eventId,
          envelope.type,
          "{}",
          envelope.occurredAt,
          envelope.runId ?? null,
          envelope.stepId ?? null,
          envelope.attemptId ?? null,
          envelope.correlationId,
        );

      const sequence = Number(result.lastInsertRowid);
      const persisted = { ...envelope, sequence };

      db.prepare(
        `UPDATE core_events SET envelope_json = ? WHERE sequence = ?`,
      ).run(JSON.stringify(persisted), sequence);

      db.prepare(
        `INSERT INTO core_outbox (
          id, event_sequence, event_id, destination, payload_json,
          state, attempts, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
      ).run(
        randomUUID(),
        sequence,
        envelope.eventId,
        destination,
        JSON.stringify(persisted),
        now,
      );

      return persisted;
    } catch (error) {
      if (isDuplicateEventIdError(error)) {
        throw new Error(`duplicate eventId: ${event.eventId}`);
      }
      throw error;
    }
  }

  readAfter<T>(input: {
    sequence: number;
    filter: SubscriptionFilter;
    limit: number;
  }): EventEnvelope<T>[] {
    const clauses = ["sequence > ?"];
    const params: unknown[] = [input.sequence];

    if (input.filter.runId) {
      clauses.push("run_id = ?");
      params.push(input.filter.runId);
    }
    if (input.filter.subjectKind) {
      clauses.push("json_extract(envelope_json, '$.subject.kind') = ?");
      params.push(input.filter.subjectKind);
    }
    if (input.filter.subjectId) {
      clauses.push("json_extract(envelope_json, '$.subject.id') = ?");
      params.push(input.filter.subjectId);
    }
    if (input.filter.typePrefix) {
      clauses.push("event_type LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(input.filter.typePrefix)}%`);
    }

    params.push(input.limit);
    const rows = this.db
      .prepare(
        `SELECT sequence, event_id AS eventId, event_type AS eventType,
                envelope_json AS envelopeJson, occurred_at AS occurredAt,
                run_id AS runId, step_id AS stepId, attempt_id AS attemptId,
                correlation_id AS correlationId
         FROM core_events
         WHERE ${clauses.join(" AND ")}
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(...params) as StoredEventRow[];

    return rows.map((row) => JSON.parse(row.envelopeJson) as EventEnvelope<T>);
  }

  ackCursor(consumerId: string, sequence: number, now: string): void {
    const maxSequence = this.getMaxSequence();
    if (sequence > maxSequence) {
      throw new Error(
        `cursor sequence ${sequence} exceeds stream maximum ${maxSequence}`,
      );
    }
    this.db
      .prepare(
        `INSERT INTO core_event_cursors (consumer_id, sequence, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(consumer_id) DO UPDATE SET
           sequence = MAX(core_event_cursors.sequence, excluded.sequence),
           updated_at = excluded.updated_at`,
      )
      .run(consumerId, sequence, now);
  }

  getMaxSequence(): number {
    const row = this.db
      .prepare(`SELECT MAX(sequence) AS maxSequence FROM core_events`)
      .get() as { maxSequence: number | null } | undefined;
    return row?.maxSequence ?? 0;
  }

  getCursor(consumerId: string): number {
    const row = this.db
      .prepare(
        `SELECT sequence FROM core_event_cursors WHERE consumer_id = ?`,
      )
      .get(consumerId) as { sequence: number } | undefined;
    return row?.sequence ?? 0;
  }

  claimOutbox(input: {
    destination: string;
    limit: number;
    now: string;
    workerId: string;
    leaseMs?: number;
  }): OutboxClaim[] {
    const leaseMs = input.leaseMs ?? DEFAULT_OUTBOX_LEASE_MS;
    const leasedUntil = new Date(Date.parse(input.now) + leaseMs).toISOString();

    return this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE core_outbox
           SET leased_by = NULL, leased_until = NULL
           WHERE destination = ?
             AND state = 'pending'
             AND leased_until IS NOT NULL
             AND leased_until <= ?`,
        )
        .run(input.destination, input.now);

      const rows = this.db
        .prepare(
          `SELECT id, event_sequence AS eventSequence, event_id AS eventId,
                  destination, payload_json AS payloadJson, attempts, created_at AS createdAt
           FROM core_outbox
           WHERE destination = ?
             AND state = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (leased_by IS NULL OR leased_until IS NULL OR leased_until <= ?)
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(input.destination, input.now, input.now, input.limit) as Array<{
          id: string;
          eventSequence: number;
          eventId: string;
          destination: string;
          payloadJson: string;
          attempts: number;
          createdAt: string;
        }>;

      const claims: OutboxClaim[] = [];
      for (const row of rows) {
        const changed = this.db
          .prepare(
            `UPDATE core_outbox
             SET leased_by = ?, leased_until = ?, attempts = attempts + 1
             WHERE id = ?
               AND state = 'pending'
               AND (leased_by IS NULL OR leased_until IS NULL OR leased_until <= ?)`,
          )
          .run(input.workerId, leasedUntil, row.id, input.now).changes;
        if (changed !== 1) {
          continue;
        }
        claims.push({
          id: row.id,
          eventSequence: row.eventSequence,
          eventId: row.eventId,
          destination: row.destination,
          payload: JSON.parse(row.payloadJson) as unknown,
          attempts: row.attempts + 1,
          createdAt: row.createdAt,
          leasedUntil,
        });
      }
      return claims;
    })();
  }

  ackOutbox(outboxId: string, workerId: string, now: string): void {
    const result = this.db
      .prepare(
        `UPDATE core_outbox
         SET state = 'published', published_at = ?, leased_by = NULL, leased_until = NULL
         WHERE id = ? AND state = 'pending' AND leased_by = ?`,
      )
      .run(now, outboxId, workerId);
    if (result.changes !== 1) {
      throw new Error(`outbox delivery not owned: ${outboxId}`);
    }
  }

  markOutboxFailed(
    outboxId: string,
    nextAttemptAt: string,
    workerId?: string,
  ): void {
    const result = workerId
      ? this.db
          .prepare(
            `UPDATE core_outbox
             SET state = 'failed', next_attempt_at = ?, leased_by = NULL, leased_until = NULL
             WHERE id = ? AND leased_by = ?`,
          )
          .run(nextAttemptAt, outboxId, workerId)
      : this.db
          .prepare(
            `UPDATE core_outbox
             SET state = 'failed', next_attempt_at = ?, leased_by = NULL, leased_until = NULL
             WHERE id = ?`,
          )
          .run(nextAttemptAt, outboxId);
    if (result.changes !== 1) {
      throw new Error(`outbox delivery not owned: ${outboxId}`);
    }
  }

  releaseOutbox(outboxId: string, workerId: string, nextAttemptAt: string): void {
    const result = this.db
      .prepare(
        `UPDATE core_outbox
         SET state = 'pending', next_attempt_at = ?, leased_by = NULL, leased_until = NULL
         WHERE id = ? AND state = 'pending' AND leased_by = ?`,
      )
      .run(nextAttemptAt, outboxId, workerId);
    if (result.changes !== 1) {
      throw new Error(`outbox delivery not owned: ${outboxId}`);
    }
  }

  getOutboxState(outboxId: string): OutboxState | null {
    const row = this.db
      .prepare(`SELECT state FROM core_outbox WHERE id = ?`)
      .get(outboxId) as { state: OutboxState } | undefined;
    return row?.state ?? null;
  }
}

function toEnvelope<T>(event: NewEvent<T>): EventEnvelope<T> {
  return {
    eventId: event.eventId,
    sequence: 0,
    type: event.type,
    subject: event.subject,
    correlationId: event.correlationId,
    runId: event.runId,
    stepId: event.stepId,
    attemptId: event.attemptId,
    occurredAt: event.occurredAt,
    schemaVersion: event.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
    data: event.data,
  };
}

function isDuplicateEventIdError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: core_events\.event_id/i.test(error.message)
  );
}

function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}
