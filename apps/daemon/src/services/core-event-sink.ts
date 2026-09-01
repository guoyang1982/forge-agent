import { randomUUID } from "node:crypto";
import {
  bridgeLegacyAgentEvent,
  type EventAppendFn,
} from "@forge/execution";
import { EventStore } from "@forge/event-store";
import type { AgentEvent, EventEnvelope } from "@forge/protocol";

export interface ProductionEventSinkOptions {
  events: EventStore;
  getCorrelationId(runId: string): string | undefined;
  broadcast(event: EventEnvelope): { failed: number } | void;
  now?(): string;
}

/**
 * The sole production bridge between legacy agent progress and v2 CoreEvents.
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
    const errors: unknown[] = [];
    for (const event of events) {
      try {
        this.broadcastStoredEvent(event);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "CoreEvent broadcast failed after commit");
    }
  };

  readonly discard = (): void => {
    this.pendingTransactionEvents = [];
  };

  readonly emitLegacyAgentEvent = (
    event: AgentEvent,
    links: { runId: string; stepId: string; attemptId: string },
  ): void => {
    const correlationId = this.options.getCorrelationId(links.runId);
    if (!correlationId) {
      throw new Error(`cannot persist agent event for unknown run: ${links.runId}`);
    }
    const stored = this.options.events.append({
      eventId: randomUUID(),
      type: "agent.event",
      subject: { kind: "agent_profile", id: "forge-default" },
      correlationId,
      runId: links.runId,
      stepId: links.stepId,
      attemptId: links.attemptId,
      occurredAt: this.now(),
      data: {
        ...event,
        ...bridgeLegacyAgentEvent(event, { ...links, correlationId }),
      },
    });
    this.broadcastStoredEvent(stored);
  };

  private broadcastStoredEvent(event: EventEnvelope): void {
    const result = this.options.broadcast(event);
    if (result && result.failed > 0) {
      throw new Error(`CoreEvent broadcast failed for ${result.failed} socket(s)`);
    }
  }
}

export function createProductionEventSink(
  options: ProductionEventSinkOptions,
): ProductionEventSink {
  return new ProductionEventSink(options);
}
