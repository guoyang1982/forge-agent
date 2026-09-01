import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { EventEnvelope } from "@forge/protocol";
import type { NewEvent, OutboxClaim, OutboxState, SubscriptionFilter } from "./types.js";

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
          JSON.stringify(envelope),
          envelope.occurredAt,
          envelope.runId ?? null,
          envelope.stepId ?? null,
          envelope.attemptId ?? null,
          envelope.correlationId,
        );

      const sequence = Number(result.lastInsertRowid);
      const persisted = { ...envelope, sequence };

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
  }): OutboxClaim[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id, event_sequence AS eventSequence, event_id AS eventId,
                  destination, payload_json AS payloadJson, attempts, created_at AS createdAt
           FROM core_outbox
           WHERE destination = ?
             AND state = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(input.destination, input.now, input.limit) as Array<{
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
             SET state = 'published', published_at = ?, attempts = attempts + 1
             WHERE id = ? AND state = 'pending'`,
          )
          .run(input.now, row.id).changes;
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
        });
      }
      return claims;
    })();
  }

  markOutboxFailed(outboxId: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `UPDATE core_outbox
         SET state = 'failed', next_attempt_at = ?, attempts = attempts + 1
         WHERE id = ?`,
      )
      .run(nextAttemptAt, outboxId);
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
