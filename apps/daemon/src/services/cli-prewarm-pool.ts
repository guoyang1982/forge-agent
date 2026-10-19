/**
 * Idle CLI process pool.
 *
 * Acquire only checks `isRunning()` and never waits on a health probe.
 * Probes run in the background: 20s after the process is ready, then every
 * 8 minutes, with a 2s timeout. A fingerprint mismatch cold-starts. Callers
 * put every session-specific difference they care about into the fingerprint
 * so an unlisted difference cannot reuse the wrong process.
 */
export interface WarmCliProcess {
  isRunning(): boolean;
  close(): void;
}

export interface CliPrewarmPoolOptions<T extends WarmCliProcess> {
  idleTtlMs?: number;
  healthProbeFirstDelayMs?: number;
  healthProbeIntervalMs?: number;
  healthProbeTimeoutMs?: number;
  now?: () => number;
  probe?: (handle: T) => Promise<boolean>;
}

interface Slot<T extends WarmCliProcess> {
  fingerprint: string;
  handle?: T;
  pending?: Promise<T | null>;
  busy: boolean;
  createdAt: number;
  lastUsedAt: number;
  probeCount: number;
  probeTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PROBE_FIRST_DELAY_MS = 20_000;
const DEFAULT_PROBE_INTERVAL_MS = 8 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export class CliPrewarmPool<T extends WarmCliProcess> {
  private readonly prewarmSlots = new Map<string, Slot<T>>();
  private readonly bySession = new Map<string, Slot<T>>();
  private readonly turnTail = new Map<string, Promise<void>>();

  constructor(private readonly options: CliPrewarmPoolOptions<T> = {}) {}

  async withTurn<R>(sessionId: string, fn: () => Promise<R>): Promise<R> {
    const previous = this.turnTail.get(sessionId) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const chain = previous.then(() => gate);
    this.turnTail.set(sessionId, chain);
    await previous;
    try {
      return await fn();
    } finally {
      releaseTurn();
      if (this.turnTail.get(sessionId) === chain) this.turnTail.delete(sessionId);
    }
  }

  async prewarm(input: {
    fingerprint: string;
    create: () => Promise<T>;
  }): Promise<{ ok: boolean; skipped?: string }> {
    this.evictIdle();
    for (const slot of this.bySession.values()) {
      if (slot.fingerprint === input.fingerprint && slot.handle?.isRunning()) {
        return { ok: true, skipped: "already_bound" };
      }
    }
    const existing = this.prewarmSlots.get(input.fingerprint);
    if (existing?.handle?.isRunning()) return { ok: true, skipped: "already_prewarm" };
    if (existing?.pending) {
      await existing.pending;
      return { ok: true, skipped: "awaited_prewarm" };
    }

    const slot: Slot<T> = {
      fingerprint: input.fingerprint,
      busy: false,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      probeCount: 0,
    };
    slot.pending = input
      .create()
      .then((handle) => {
        slot.handle = handle;
        slot.pending = undefined;
        this.scheduleProbe(slot);
        return handle;
      })
      .catch(() => {
        this.prewarmSlots.delete(input.fingerprint);
        slot.pending = undefined;
        return null;
      });
    this.prewarmSlots.set(input.fingerprint, slot);
    const handle = await slot.pending;
    return handle ? { ok: true } : { ok: false, skipped: "create_failed" };
  }

  async acquire(input: {
    sessionId: string;
    fingerprint: string;
    create: () => Promise<T>;
  }): Promise<{ handle: T; reused: boolean; adoptedPrewarm: boolean }> {
    this.evictIdle();
    const current = this.bySession.get(input.sessionId);
    if (
      current?.handle &&
      current.fingerprint === input.fingerprint &&
      current.handle.isRunning()
    ) {
      current.busy = true;
      current.lastUsedAt = this.now();
      this.cancelProbe(current);
      return { handle: current.handle, reused: true, adoptedPrewarm: false };
    }
    if (current) this.closeSlot(current);

    const warmed = this.prewarmSlots.get(input.fingerprint);
    if (warmed) {
      this.prewarmSlots.delete(input.fingerprint);
      this.cancelProbe(warmed);
      const handle = warmed.handle ?? (await warmed.pending);
      if (handle?.isRunning()) {
        warmed.busy = true;
        warmed.fingerprint = input.fingerprint;
        warmed.lastUsedAt = this.now();
        warmed.handle = handle;
        this.bySession.set(input.sessionId, warmed);
        return { handle, reused: false, adoptedPrewarm: true };
      }
      handle?.close();
    }

    const handle = await input.create();
    this.bySession.set(input.sessionId, {
      fingerprint: input.fingerprint,
      handle,
      busy: true,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      probeCount: 0,
    });
    return { handle, reused: false, adoptedPrewarm: false };
  }

  park(sessionId: string): void {
    const slot = this.bySession.get(sessionId);
    if (!slot?.handle) return;
    slot.busy = false;
    slot.lastUsedAt = this.now();
    this.scheduleProbe(slot);
  }

  invalidate(sessionId: string): void {
    const slot = this.bySession.get(sessionId);
    if (slot) this.closeSlot(slot);
  }

  releaseSession(sessionId: string): void {
    this.invalidate(sessionId);
  }

  releaseAll(): number {
    const sessions = this.bySession.size + this.prewarmSlots.size;
    for (const slot of [...this.bySession.values(), ...this.prewarmSlots.values()]) {
      this.closeSlot(slot);
    }
    return sessions;
  }

  private evictIdle(): void {
    const now = this.now();
    const ttl = this.options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    for (const slot of [...this.bySession.values(), ...this.prewarmSlots.values()]) {
      if (slot.busy || slot.pending) continue;
      const dead = slot.handle ? !slot.handle.isRunning() : false;
      if (dead || now - slot.lastUsedAt > ttl) this.closeSlot(slot);
    }
  }

  private scheduleProbe(slot: Slot<T>, forceInterval = false): void {
    this.cancelProbe(slot);
    if (!slot.handle) return;
    const first = this.options.healthProbeFirstDelayMs ?? DEFAULT_PROBE_FIRST_DELAY_MS;
    const interval = this.options.healthProbeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    const delay =
      !forceInterval && slot.probeCount === 0
        ? Math.max(0, slot.createdAt + first - this.now())
        : interval;
    const timer = setTimeout(() => {
      void this.onProbe(slot);
    }, delay);
    timer.unref?.();
    slot.probeTimer = timer;
  }

  private cancelProbe(slot: Slot<T>): void {
    if (!slot.probeTimer) return;
    clearTimeout(slot.probeTimer);
    slot.probeTimer = undefined;
  }

  private async onProbe(slot: Slot<T>): Promise<void> {
    slot.probeTimer = undefined;
    if (!slot.handle) return;
    if (slot.busy) {
      this.scheduleProbe(slot, true);
      return;
    }
    const timeoutMs = this.options.healthProbeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const probe = this.options.probe ?? (async (handle: T) => handle.isRunning());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ok = false;
    try {
      ok = await Promise.race([
        probe(slot.handle),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    slot.probeCount += 1;
    if (!slot.handle || !ok || !slot.handle.isRunning() || this.now() - slot.lastUsedAt > (this.options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS)) {
      this.closeSlot(slot);
      return;
    }
    this.scheduleProbe(slot);
  }

  private closeSlot(slot: Slot<T>): void {
    this.cancelProbe(slot);
    for (const [key, value] of this.prewarmSlots) {
      if (value === slot) this.prewarmSlots.delete(key);
    }
    for (const [key, value] of this.bySession) {
      if (value === slot) this.bySession.delete(key);
    }
    slot.pending = undefined;
    const handle = slot.handle;
    slot.handle = undefined;
    handle?.close();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
