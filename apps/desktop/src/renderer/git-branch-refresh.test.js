import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("git branch refresh controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes on start, interval, focus, visibility, and explicit refresh", async () => {
    await import("./git-branch-refresh.js");
    const { createGitBranchRefreshController } = globalThis.ForgeGitBranchRefresh;
    const refresh = vi.fn();
    const listeners = new Map();
    const windowObject = {
      addEventListener: vi.fn((name, handler) => listeners.set(`window:${name}`, handler)),
      removeEventListener: vi.fn((name) => listeners.delete(`window:${name}`)),
    };
    const documentObject = {
      visibilityState: "visible",
      addEventListener: vi.fn((name, handler) => listeners.set(`document:${name}`, handler)),
      removeEventListener: vi.fn((name) => listeners.delete(`document:${name}`)),
    };

    const controller = createGitBranchRefreshController({
      refresh,
      getActiveKey: () => "project-1",
      intervalMs: 1000,
      windowObject,
      documentObject,
    });

    controller.start();
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(2);

    listeners.get("window:focus")();
    expect(refresh).toHaveBeenCalledTimes(3);

    listeners.get("document:visibilitychange")();
    expect(refresh).toHaveBeenCalledTimes(4);

    controller.refreshNow();
    expect(refresh).toHaveBeenCalledTimes(5);

    controller.stop();
    vi.advanceTimersByTime(1000);
    listeners.get("window:focus")?.();
    expect(refresh).toHaveBeenCalledTimes(5);
  });

  it("continues refreshing after an async refresh failure", async () => {
    await import("./git-branch-refresh.js");
    const { createGitBranchRefreshController } = globalThis.ForgeGitBranchRefresh;
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("git not ready"))
      .mockResolvedValue(undefined);

    const controller = createGitBranchRefreshController({
      refresh,
      getActiveKey: () => "project-1",
      intervalMs: 1000,
    });

    controller.start();
    await Promise.resolve();
    await Promise.resolve();
    controller.refreshNow();

    expect(refresh).toHaveBeenCalledTimes(2);
    controller.stop();
  });
});
