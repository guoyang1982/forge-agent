import { afterEach, describe, expect, it, vi } from "vitest";
import { CliPrewarmPool, type WarmCliProcess } from "./cli-prewarm-pool.js";

class FakeCli implements WarmCliProcess {
  closed = false;
  alive = true;

  isRunning(): boolean {
    return this.alive && !this.closed;
  }

  close(): void {
    this.closed = true;
    this.alive = false;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CliPrewarmPool", () => {
  it("adopts an in-flight prewarm without starting a second process", async () => {
    const pool = new CliPrewarmPool<FakeCli>();
    let resolveCreate: (handle: FakeCli) => void = () => {};
    const created: FakeCli[] = [];
    const create = () =>
      new Promise<FakeCli>((resolve) => {
        resolveCreate = (handle) => {
          created.push(handle);
          resolve(handle);
        };
      });

    const prewarm = pool.prewarm({ fingerprint: "cwd:a", create });
    const acquire = pool.acquire({ sessionId: "s1", fingerprint: "cwd:a", create });
    const handle = new FakeCli();
    resolveCreate(handle);

    await prewarm;
    const got = await acquire;
    expect(got.handle).toBe(handle);
    expect(got.adoptedPrewarm).toBe(true);
    expect(got.reused).toBe(false);
    expect(created).toEqual([handle]);
  });

  it("reuses the session process and cold-starts when the fingerprint changes", async () => {
    const pool = new CliPrewarmPool<FakeCli>();
    const first = new FakeCli();
    const second = new FakeCli();
    const creates: FakeCli[] = [];
    const create = (handle: FakeCli) => async () => {
      creates.push(handle);
      return handle;
    };

    const adopted = await pool.acquire({
      sessionId: "s1",
      fingerprint: "model-a",
      create: create(first),
    });
    pool.park("s1");
    const again = await pool.acquire({
      sessionId: "s1",
      fingerprint: "model-a",
      create: create(second),
    });
    pool.park("s1");
    const switched = await pool.acquire({
      sessionId: "s1",
      fingerprint: "model-b",
      create: create(second),
    });

    expect(adopted.handle).toBe(first);
    expect(again.handle).toBe(first);
    expect(again.reused).toBe(true);
    expect(switched.handle).toBe(second);
    expect(first.closed).toBe(true);
    expect(creates).toEqual([first, second]);
  });

  it("does not run the health probe on acquire", async () => {
    vi.useFakeTimers();
    let probes = 0;
    const pool = new CliPrewarmPool<FakeCli>({
      probe: async () => {
        probes += 1;
        return true;
      },
    });
    const handle = new FakeCli();
    await pool.prewarm({
      fingerprint: "cwd",
      create: async () => handle,
    });
    const got = await pool.acquire({
      sessionId: "s1",
      fingerprint: "cwd",
      create: async () => new FakeCli(),
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(got.adoptedPrewarm).toBe(true);
    expect(probes).toBe(0);
    expect(handle.closed).toBe(false);
  });

  it("drops an idle process when the background probe fails", async () => {
    vi.useFakeTimers();
    const pool = new CliPrewarmPool<FakeCli>({
      probe: async () => false,
    });
    const handle = new FakeCli();
    await pool.prewarm({
      fingerprint: "cwd",
      create: async () => handle,
    });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(handle.closed).toBe(true);
    const next = new FakeCli();
    const got = await pool.acquire({
      sessionId: "s1",
      fingerprint: "cwd",
      create: async () => next,
    });
    expect(got.handle).toBe(next);
    expect(got.adoptedPrewarm).toBe(false);
  });

  it("closes a released session instead of handing it to the next one", async () => {
    const pool = new CliPrewarmPool<FakeCli>();
    const first = new FakeCli();
    const second = new FakeCli();
    await pool.acquire({
      sessionId: "s1",
      fingerprint: "cwd",
      create: async () => first,
    });
    pool.park("s1");
    pool.releaseSession("s1");
    const got = await pool.acquire({
      sessionId: "s2",
      fingerprint: "cwd",
      create: async () => second,
    });

    expect(first.closed).toBe(true);
    expect(got.handle).toBe(second);
  });

  it("discards a dead session process and cold-starts", async () => {
    const pool = new CliPrewarmPool<FakeCli>();
    const dead = new FakeCli();
    const fresh = new FakeCli();
    await pool.acquire({
      sessionId: "s1",
      fingerprint: "cwd",
      create: async () => dead,
    });
    pool.park("s1");
    dead.alive = false;
    const got = await pool.acquire({
      sessionId: "s1",
      fingerprint: "cwd",
      create: async () => fresh,
    });

    expect(got.handle).toBe(fresh);
    expect(dead.closed).toBe(true);
  });
});
