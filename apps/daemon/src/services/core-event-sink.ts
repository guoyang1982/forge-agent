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
  broadcast(event: EventEnvelope): void;
  now?(): string;
}

/**
 * The sole production bridge between legacy agent progress and v2 CoreEvents.
 * It always broadcasts the envelope returned from storage, never a synthetic copy.
 */
export class ProductionEventSink {
  private readonly now: () => string;

  constructor(private readonly options: ProductionEventSinkOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  readonly appendInTransaction: EventAppendFn = (db, event) => {
    const stored = EventStore.appendInTransaction(db, event);
    this.options.broadcast(stored);
    return stored;
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
    this.options.broadcast(stored);
  };
}

export function createProductionEventSink(
  options: ProductionEventSinkOptions,
): ProductionEventSink {
  return new ProductionEventSink(options);
}
