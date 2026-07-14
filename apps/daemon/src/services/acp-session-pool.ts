import { AcpClient } from "./acp-client.js";

export interface AcpWarmSession {
  client: AcpClient;
  acpSessionId: string;
  providerKey: string;
  forgeSessionId: string;
  cwd: string;
  model?: string;
  mode?: string;
  acpArgsKey: string;
  lastUsedAt: number;
}

interface CwdPrewarmSlot {
  promise: Promise<AcpWarmSession | null>;
  session?: AcpWarmSession;
}

const IDLE_TTL_MS = 30 * 60 * 1000;

class AcpSessionPool {
  private readonly sessions = new Map<string, AcpWarmSession>();
  private readonly cwdPrewarm = new Map<string, CwdPrewarmSlot>();
  private readonly turnLocks = new Map<string, Promise<void>>();

  private key(providerKey: string, forgeSessionId: string): string {
    return `${providerKey}:${forgeSessionId}`;
  }

  private cwdSlotKey(providerKey: string, cwd: string, acpArgsKey: string): string {
    return `${providerKey}:${cwd}:${acpArgsKey}`;
  }

  private isCompatible(
    existing: AcpWarmSession,
    options: {
      cwd: string;
      model?: string;
      acpArgsKey: string;
    },
  ): boolean {
    return (
      existing.client.isRunning() &&
      existing.cwd === options.cwd &&
      existing.model === options.model &&
      existing.acpArgsKey === options.acpArgsKey
    );
  }

  async withTurn<T>(
    providerKey: string,
    forgeSessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const poolKey = this.key(providerKey, forgeSessionId);
    const previous = this.turnLocks.get(poolKey) ?? Promise.resolve();
    let releaseTurn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const chain = previous.then(() => gate);
    this.turnLocks.set(poolKey, chain);
    await previous;
    try {
      return await fn();
    } finally {
      releaseTurn();
      if (this.turnLocks.get(poolKey) === chain) {
        this.turnLocks.delete(poolKey);
      }
    }
  }

  async prewarmCwd(options: {
    providerKey: string;
    cwd: string;
    model?: string;
    mode?: string;
    acpArgsKey: string;
    create: () => Promise<{ client: AcpClient; acpSessionId: string }>;
  }): Promise<{ ok: boolean; skipped?: string }> {
    this.evictIdle();
    const slotKey = this.cwdSlotKey(options.providerKey, options.cwd, options.acpArgsKey);

    for (const session of this.sessions.values()) {
      if (
        session.providerKey === options.providerKey &&
        session.cwd === options.cwd &&
        session.acpArgsKey === options.acpArgsKey &&
        session.client.isRunning()
      ) {
        return { ok: true, skipped: "already_bound" };
      }
    }

    const existing = this.cwdPrewarm.get(slotKey);
    if (existing?.session && this.isCompatible(existing.session, options)) {
      return { ok: true, skipped: "already_prewarm" };
    }
    if (existing?.promise) {
      await existing.promise;
      return { ok: true, skipped: "awaited_prewarm" };
    }

    const slot: CwdPrewarmSlot = {
      promise: Promise.resolve(null),
    };
    slot.promise = (async () => {
      try {
        const created = await options.create();
        const warm: AcpWarmSession = {
          client: created.client,
          acpSessionId: created.acpSessionId,
          providerKey: options.providerKey,
          forgeSessionId: "",
          cwd: options.cwd,
          model: options.model,
          mode: options.mode,
          acpArgsKey: options.acpArgsKey,
          lastUsedAt: Date.now(),
        };
        slot.session = warm;
        return warm;
      } catch {
        this.cwdPrewarm.delete(slotKey);
        return null;
      }
    })();
    this.cwdPrewarm.set(slotKey, slot);
    await slot.promise;
    return { ok: true };
  }

  private async adoptCwdPrewarm(
    options: {
      providerKey: string;
      forgeSessionId: string;
      cwd: string;
      model?: string;
      mode?: string;
      acpArgsKey: string;
    },
    poolKey: string,
  ): Promise<{
    client: AcpClient;
    acpSessionId: string;
    reused: boolean;
    adoptedPrewarm: boolean;
    previousMode?: string;
  } | null> {
    const slotKey = this.cwdSlotKey(options.providerKey, options.cwd, options.acpArgsKey);
    const slot = this.cwdPrewarm.get(slotKey);
    if (!slot) return null;
    const warmed = slot.session ?? (await slot.promise);
    this.cwdPrewarm.delete(slotKey);
    if (!warmed || !this.isCompatible(warmed, options)) {
      if (warmed) this.closeWarmSession(warmed);
      return null;
    }
    const bound: AcpWarmSession = {
      ...warmed,
      forgeSessionId: options.forgeSessionId,
      model: options.model,
      mode: options.mode,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(poolKey, bound);
    return {
      client: bound.client,
      acpSessionId: bound.acpSessionId,
      reused: true,
      adoptedPrewarm: true,
      previousMode: warmed.mode,
    };
  }

  async acquire(options: {
    providerKey: string;
    forgeSessionId: string;
    cwd: string;
    model?: string;
    mode?: string;
    acpArgsKey: string;
    create: () => Promise<{ client: AcpClient; acpSessionId: string }>;
  }): Promise<{
    client: AcpClient;
    acpSessionId: string;
    reused: boolean;
    adoptedPrewarm?: boolean;
    previousMode?: string;
  }> {
    this.evictIdle();
    const poolKey = this.key(options.providerKey, options.forgeSessionId);
    const existing = this.sessions.get(poolKey);
    if (existing && this.isCompatible(existing, options)) {
      existing.lastUsedAt = Date.now();
      return {
        client: existing.client,
        acpSessionId: existing.acpSessionId,
        reused: true,
        previousMode: existing.mode,
      };
    }
    if (existing) await this.releaseKey(poolKey);

    const adopted = await this.adoptCwdPrewarm(options, poolKey);
    if (adopted) return adopted;

    const created = await options.create();
    this.sessions.set(poolKey, {
      client: created.client,
      acpSessionId: created.acpSessionId,
      providerKey: options.providerKey,
      forgeSessionId: options.forgeSessionId,
      cwd: options.cwd,
      model: options.model,
      mode: options.mode,
      acpArgsKey: options.acpArgsKey,
      lastUsedAt: Date.now(),
    });
    return { ...created, reused: false, previousMode: undefined };
  }

  updateWarmSessionMode(
    providerKey: string,
    forgeSessionId: string,
    mode: string | undefined,
  ): void {
    const session = this.sessions.get(this.key(providerKey, forgeSessionId));
    if (session) session.mode = mode;
  }

  cancelTurn(providerKey: string, forgeSessionId: string): void {
    const session = this.sessions.get(this.key(providerKey, forgeSessionId));
    if (!session) return;
    session.client.notifyCancel(session.acpSessionId);
  }

  async invalidate(providerKey: string, forgeSessionId: string): Promise<void> {
    await this.releaseKey(this.key(providerKey, forgeSessionId));
  }

  async release(providerKey: string, forgeSessionId: string): Promise<void> {
    await this.releaseKey(this.key(providerKey, forgeSessionId));
  }

  async releaseForgeSession(forgeSessionId: string, recycleToPrewarm = true): Promise<number> {
    const keys = [...this.sessions.entries()]
      .filter(([, session]) => session.forgeSessionId === forgeSessionId)
      .map(([poolKey]) => poolKey);
    for (const poolKey of keys) {
      await this.releaseKey(poolKey, recycleToPrewarm);
    }
    return keys.length;
  }

  async releaseAll(): Promise<number> {
    const keys = [...this.sessions.keys()];
    for (const poolKey of keys) {
      await this.releaseKey(poolKey);
    }
    for (const [slotKey, slot] of this.cwdPrewarm) {
      if (slot.session) this.closeWarmSession(slot.session);
      this.cwdPrewarm.delete(slotKey);
    }
    return keys.length;
  }

  listWarmSessions(): Array<{
    providerKey: string;
    forgeSessionId: string;
    cwd: string;
    model?: string;
    mode?: string;
    lastUsedAt: number;
    prewarm?: boolean;
  }> {
    const bound = [...this.sessions.values()].map((session) => ({
      providerKey: session.providerKey,
      forgeSessionId: session.forgeSessionId,
      cwd: session.cwd,
      model: session.model,
      mode: session.mode,
      lastUsedAt: session.lastUsedAt,
    }));
    const prewarmed = [...this.cwdPrewarm.values()]
      .map((slot) => slot.session)
      .filter((session): session is AcpWarmSession => Boolean(session))
      .map((session) => ({
        providerKey: session.providerKey,
        forgeSessionId: "(prewarm)",
        cwd: session.cwd,
        model: session.model,
        mode: session.mode,
        lastUsedAt: session.lastUsedAt,
        prewarm: true,
      }));
    return [...bound, ...prewarmed];
  }

  private closeWarmSession(session: AcpWarmSession): void {
    session.client.close();
  }

  private recycleSessionToPrewarm(session: AcpWarmSession): boolean {
    if (!session.client.isRunning()) return false;
    const slotKey = this.cwdSlotKey(session.providerKey, session.cwd, session.acpArgsKey);
    const existing = this.cwdPrewarm.get(slotKey);
    if (existing?.session || existing?.promise) return false;
    const recycled: AcpWarmSession = {
      ...session,
      forgeSessionId: "",
      lastUsedAt: Date.now(),
    };
    this.cwdPrewarm.set(slotKey, {
      session: recycled,
      promise: Promise.resolve(recycled),
    });
    return true;
  }

  private async releaseKey(poolKey: string, recycleToPrewarm = false): Promise<void> {
    const session = this.sessions.get(poolKey);
    if (!session) return;
    this.sessions.delete(poolKey);
    if (recycleToPrewarm && this.recycleSessionToPrewarm(session)) return;
    this.closeWarmSession(session);
  }

  private evictIdle(): void {
    const now = Date.now();
    for (const [poolKey, session] of this.sessions) {
      if (!session.client.isRunning() || now - session.lastUsedAt > IDLE_TTL_MS) {
        void this.releaseKey(poolKey);
      }
    }
    for (const [slotKey, slot] of this.cwdPrewarm) {
      const session = slot.session;
      if (session && (!session.client.isRunning() || now - session.lastUsedAt > IDLE_TTL_MS)) {
        this.closeWarmSession(session);
        this.cwdPrewarm.delete(slotKey);
      }
    }
  }
}

export const acpSessionPool = new AcpSessionPool();
