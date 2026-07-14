import { describe, expect, it, vi } from "vitest";
import { AutomationScheduler } from "./scheduler.js";

describe("AutomationScheduler", () => {
  it("fires execute at scheduled time", async () => {
    vi.useFakeTimers();
    const executed: string[] = [];
    const sched = new AutomationScheduler({
      listJobs: async () => [
        { id: "a1", nextRunAt: new Date(Date.now() + 1000).toISOString() },
      ],
      onFire: async (id) => {
        executed.push(id);
      },
      reschedule: async () => {},
    });
    await sched.reload();
    await vi.advanceTimersByTimeAsync(1100);
    expect(executed).toEqual(["a1"]);
    sched.stop();
    vi.useRealTimers();
  });

  it("reschedules a single job", async () => {
    vi.useFakeTimers();
    const executed: string[] = [];
    let nextRunAt = new Date(Date.now() + 2000).toISOString();
    const sched = new AutomationScheduler({
      listJobs: async () => [{ id: "a1", nextRunAt }],
      onFire: async (id) => {
        executed.push(id);
      },
    });
    await sched.reload();
    nextRunAt = new Date(Date.now() + 500).toISOString();
    await sched.reschedule("a1");
    await vi.advanceTimersByTimeAsync(600);
    expect(executed).toEqual(["a1"]);
    sched.stop();
    vi.useRealTimers();
  });

  it("stop prevents pending timers", async () => {
    vi.useFakeTimers();
    const executed: string[] = [];
    const sched = new AutomationScheduler({
      listJobs: async () => [
        { id: "a1", nextRunAt: new Date(Date.now() + 1000).toISOString() },
      ],
      onFire: async (id) => {
        executed.push(id);
      },
    });
    await sched.reload();
    sched.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(executed).toEqual([]);
    vi.useRealTimers();
  });

  it("does not pass delays beyond Node's timer limit to setTimeout", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const sched = new AutomationScheduler({
      listJobs: async () => [
        {
          id: "monthly",
          nextRunAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
      onFire: async () => {},
    });

    await sched.reload();

    const scheduledDelay = setTimeoutSpy.mock.calls[0]?.[1];
    expect(typeof scheduledDelay).toBe("number");
    expect(scheduledDelay).toBeLessThanOrEqual(2_147_483_647);

    sched.stop();
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});
