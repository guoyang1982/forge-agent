import { randomUUID } from "node:crypto";
import {
  bridgeAgentEvent,
  type EventAppendFn,
} from "@forge/execution";
import { EventStore } from "@forge/event-store";
import type { AgentEvent, EventEnvelope } from "@forge/protocol";

export interface ProductionEventSinkOptions {
  events: EventStore;
  getCorrelationId(runId: string): string | undefined;
  getActingSubject(runId: string): EventEnvelope["subject"] | undefined;
  broadcast(event: EventEnvelope): void;
  reportDeliveryFailure?(event: EventEnvelope, error: Error): void;
  now?(): string;
}

/**
 * Production bridge from AgentEvent progress onto durable CoreEvents.
 * It always broadcasts the envelope returned from storage, never a synthetic copy.
 */
export class ProductionEventSink {
  private readonly now: () => string;
  private pendingTransactionEvents: EventEnvelope[] = [];

  constructor(private readonly options: ProductionEventSinkOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  readonly appendInTransaction: EventAppendFn = (db, event) => {
    const stored = EventStore.appendInTransaction(db, event);
    this.pendingTransactionEvents.push(stored);
    return stored;
  };

  readonly flush = (): void => {
    const events = this.pendingTransactionEvents;
    this.pendingTransactionEvents = [];
    for (const event of events) {
      this.broadcastStoredEvent(event);
    }
  };

  readonly discard = (): void => {
    this.pendingTransactionEvents = [];
  };

  readonly emitAgentEvent = (
    event: AgentEvent,
    links: { runId: string; stepId: string; attemptId: string },
  ): void => {
    const correlationId = this.options.getCorrelationId(links.runId);
    if (!correlationId) {
      throw new Error(`cannot persist agent event for unknown run: ${links.runId}`);
    }
    const subject = this.options.getActingSubject(links.runId);
    if (!subject) {
      throw new Error(`cannot persist agent event for unknown run subject: ${links.runId}`);
    }
    const stored = this.options.events.append({
      eventId: randomUUID(),
      type: "agent.event",
      subject,
      correlationId,
      runId: links.runId,
      stepId: links.stepId,
      attemptId: links.attemptId,
      occurredAt: this.now(),
      data: {
        ...event,
        ...bridgeAgentEvent(event, { ...links, correlationId }),
      },
    });
    this.broadcastStoredEvent(stored);
  };

  private broadcastStoredEvent(event: EventEnvelope): void {
    try {
      this.options.broadcast(event);
    } catch (error) {
      try {
        this.options.reportDeliveryFailure?.(event, toError(error));
      } catch {
        // A diagnostic consumer must not fail a store operation that already committed.
      }
    }
  }
}

export function createProductionEventSink(
  options: ProductionEventSinkOptions,
): ProductionEventSink {
  return new ProductionEventSink(options);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
