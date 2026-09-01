import type { EventEnvelope, SubjectRef } from "@forge/protocol";

export type { EventEnvelope, SubjectRef };

export interface NewEvent<T = unknown> {
  eventId: string;
  type: string;
  subject: SubjectRef;
  correlationId: string;
  runId?: string;
  stepId?: string;
  attemptId?: string;
  occurredAt: string;
  schemaVersion?: number;
  data: T;
  destination?: string;
}

export interface SubscriptionFilter {
  runId?: string;
  subjectKind?: string;
  subjectId?: string;
  typePrefix?: string;
}

export interface OutboxClaim {
  id: string;
  eventSequence: number;
  eventId: string;
  destination: string;
  payload: unknown;
  attempts: number;
  createdAt: string;
}

export type OutboxState = "pending" | "published" | "failed";
