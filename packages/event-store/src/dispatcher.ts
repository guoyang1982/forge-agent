import { randomUUID } from "node:crypto";
import type { EventStore } from "./store.js";
import type { OutboxClaim } from "./types.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface OutboxDispatchStats {
  claimed: number;
  published: number;
  retried: number;
  failed: number;
}

export interface OutboxDeliveryFailure {
  claim: OutboxClaim;
  error: unknown;
  terminal: boolean;
  nextAttemptAt?: string;
}

export interface OutboxDispatcherOptions {
  store: EventStore;
  destination: string;
  publish: (claim: OutboxClaim) => void | Promise<void>;
  workerId?: string;
  now?: () => string;
  batchSize?: number;
  maxAttempts?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  onFailure?: (failure: OutboxDeliveryFailure) => void;
  onLoopError?: (error: unknown) => void;
}

export class OutboxDispatcher {
  private readonly workerId: string;
  private readonly now: () => string;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private running = false;

  constructor(private readonly options: OutboxDispatcherOptions) {
    this.workerId = options.workerId ?? `outbox-${randomUUID()}`;
    this.now = options.now ?? (() => new Date().toISOString());
    this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
    this.maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.baseRetryMs = positiveInteger(options.baseRetryMs, DEFAULT_BASE_RETRY_MS);
    this.maxRetryMs = positiveInteger(options.maxRetryMs, DEFAULT_MAX_RETRY_MS);
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
    );
  }

  async dispatchOnce(): Promise<OutboxDispatchStats> {
    const claimTime = this.now();
    const claims = this.options.store.claimOutbox({
      destination: this.options.destination,
      limit: this.batchSize,
      now: claimTime,
      workerId: this.workerId,
      ...(this.options.leaseMs === undefined
        ? {}
        : { leaseMs: this.options.leaseMs }),
    });
    const stats: OutboxDispatchStats = {
      claimed: claims.length,
      published: 0,
      retried: 0,
      failed: 0,
    };

    for (const claim of claims) {
      try {
        await this.options.publish(claim);
        this.options.store.ackOutbox(claim.id, this.workerId, this.now());
        stats.published += 1;
      } catch (error) {
        const failureTime = this.now();
        if (claim.attempts >= this.maxAttempts) {
          this.options.store.markOutboxFailed(claim.id, failureTime, this.workerId);
          stats.failed += 1;
          this.reportFailure({ claim, error, terminal: true });
          continue;
        }

        const nextAttemptAt = new Date(
          Date.parse(failureTime) + this.retryDelayMs(claim.attempts),
        ).toISOString();
        this.options.store.releaseOutbox(claim.id, this.workerId, nextAttemptAt);
        stats.retried += 1;
        this.reportFailure({ claim, error, terminal: false, nextAttemptAt });
      }
    }

    return stats;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  private runLoop(): void {
    if (!this.running || this.inFlight) return;
    this.inFlight = this.dispatchOnce()
      .then(() => undefined)
      .catch((error) => {
        try {
          this.options.onLoopError?.(error);
        } catch {
          // Observability hooks must not stop future polling.
        }
      })
      .finally(() => {
        this.inFlight = undefined;
        if (!this.running) return;
        this.timer = setTimeout(() => this.runLoop(), this.pollIntervalMs);
        this.timer.unref?.();
      });
  }

  private retryDelayMs(attempts: number): number {
    return Math.min(
      this.maxRetryMs,
      this.baseRetryMs * 2 ** Math.max(0, attempts - 1),
    );
  }

  private reportFailure(failure: OutboxDeliveryFailure): void {
    try {
      this.options.onFailure?.(failure);
    } catch {
      // Observability hooks must not change delivery state transitions.
    }
  }

}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isInteger(value) || value <= 0
    ? fallback
    : value;
}
