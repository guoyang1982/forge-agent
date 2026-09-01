import { randomUUID } from "node:crypto";
import type {
  EventEnvelope,
  RpcMethod,
  RpcParams,
  RpcResult,
  SubscriptionFilter,
} from "@forge/protocol";
import type { RequestOptions } from "./index.js";

const DEFAULT_READ_LIMIT = 500;
const DEFAULT_RECONNECT_DELAY_MS = 25;

export interface SubscribeOptions {
  consumerId?: string;
  initialCursor?: number;
  readLimit?: number;
  reconnect?: boolean;
  reconnectDelayMs?: number;
}

export interface EventSubscription {
  readonly id: string;
  readonly cursor: number;
  close(): Promise<void>;
}

export interface SubscriptionTransport {
  request<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    options?: RequestOptions,
  ): Promise<RpcResult<M>>;
  addNotificationListener(listener: (event: EventEnvelope) => void): () => void;
  addCloseListener(listener: () => void): () => void;
  reconnect(): Promise<void>;
}

export function createEventSubscription(
  transport: SubscriptionTransport,
  filter: SubscriptionFilter,
  handler: (event: EventEnvelope) => void | Promise<void>,
  options: SubscribeOptions = {},
): EventSubscription {
  return new ResumableEventSubscription(transport, filter, handler, options);
}

export function matchesEventFilter(
  event: EventEnvelope,
  filter: SubscriptionFilter,
): boolean {
  if (filter.runId && event.runId !== filter.runId) {
    return false;
  }
  if (filter.subjectKind && event.subject.kind !== filter.subjectKind) {
    return false;
  }
  if (filter.subjectId && event.subject.id !== filter.subjectId) {
    return false;
  }
  if (filter.typePrefix && !event.type.startsWith(filter.typePrefix)) {
    return false;
  }
  return true;
}

class ResumableEventSubscription implements EventSubscription {
  readonly id: string;
  private lastCursor: number;
  private readonly seenEventIds = new Set<string>();
  private readonly readLimit: number;
  private readonly reconnect: boolean;
  private readonly reconnectDelayMs: number;
  private closed = false;
  private running = false;
  private replayQueue: Promise<void> = Promise.resolve();
  private removeNotificationListener: (() => void) | undefined;
  private removeCloseListener: (() => void) | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly transport: SubscriptionTransport,
    private readonly filter: SubscriptionFilter,
    private readonly handler: (event: EventEnvelope) => void | Promise<void>,
    options: SubscribeOptions,
  ) {
    this.id = options.consumerId ?? randomUUID();
    this.lastCursor = options.initialCursor ?? 0;
    this.readLimit = options.readLimit ?? DEFAULT_READ_LIMIT;
    this.reconnect = options.reconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.removeNotificationListener = transport.addNotificationListener((event) => {
      void this.enqueue(() => this.deliver(event));
    });
    this.removeCloseListener = transport.addCloseListener(() => {
      this.scheduleReconnect();
    });
    void this.enqueue(() => this.replayFromCursor(this.lastCursor));
  }

  get cursor(): number {
    return this.lastCursor;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.removeNotificationListener?.();
    this.removeNotificationListener = undefined;
    this.removeCloseListener?.();
    this.removeCloseListener = undefined;
    await this.replayQueue;
  }

  /** Test helper: wait until the subscription cursor reaches a sequence. */
  async settledAfter(sequence: number, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    while (this.lastCursor < sequence) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `subscription ${this.id} did not reach cursor ${sequence} (at ${this.lastCursor})`,
        );
      }
      await sleep(5);
    }
    await this.replayQueue;
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.reconnect || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.enqueue(async () => {
        await this.transport.reconnect();
        await this.replayFromCursor(this.lastCursor);
      });
    }, this.reconnectDelayMs);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.replayQueue = this.replayQueue.then(task).catch(() => undefined);
    return this.replayQueue;
  }

  private async replayFromCursor(cursor: number): Promise<void> {
    if (this.closed || this.running) {
      return;
    }
    this.running = true;
    try {
      let nextCursor = cursor;
      while (!this.closed) {
        const page = await this.transport.request("events.read", {
          cursor: nextCursor,
          limit: this.readLimit,
          filter: this.filter,
        });
        if (page.events.length === 0) {
          break;
        }
        for (const event of page.events) {
          await this.deliver(event);
        }
        const lastSequence = page.events.at(-1)?.sequence ?? nextCursor;
        if (page.events.length < this.readLimit || lastSequence <= nextCursor) {
          break;
        }
        nextCursor = lastSequence;
      }
    } finally {
      this.running = false;
    }
  }

  private async deliver(event: EventEnvelope): Promise<void> {
    if (this.closed || this.seenEventIds.has(event.eventId)) {
      return;
    }
    if (!matchesEventFilter(event, this.filter)) {
      return;
    }
    this.seenEventIds.add(event.eventId);
    await this.handler(event);
    if (event.sequence <= this.lastCursor) {
      return;
    }
    this.lastCursor = event.sequence;
    await this.transport.request("events.cursor.ack", {
      consumerId: this.id,
      sequence: this.lastCursor,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test-only subscription with cursor wait helper. */
export type TestEventSubscription = EventSubscription & {
  settledAfter(sequence: number, timeoutMs?: number): Promise<void>;
};
