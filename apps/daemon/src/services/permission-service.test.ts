import { describe, expect, it, vi } from "vitest";
import { PermissionService } from "./permission-service.js";

describe("PermissionService dismiss reasons", () => {
  it("marks timeout dismissals so UI can clear stale banners", async () => {
    vi.useFakeTimers();
    const service = new PermissionService();
    const pending = service.waitForResponse("p1", { timeoutMs: 1_000, sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({
      approved: false,
      dismissReason: "timeout",
    });
    expect(service.respond("p1", true)).toBe(false);
    vi.useRealTimers();
  });

  it("marks abort dismissals", async () => {
    const service = new PermissionService();
    const controller = new AbortController();
    const pending = service.waitForResponse("p2", {
      sessionId: "s1",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      approved: false,
      dismissReason: "abort",
    });
  });

  it("marks cancelSession dismissals and returns ids", async () => {
    const service = new PermissionService();
    const pending = service.waitForResponse("p3", { sessionId: "s1" });
    expect(service.cancelSession("s1")).toEqual(["p3"]);
    await expect(pending).resolves.toMatchObject({
      approved: false,
      dismissReason: "cancelled",
    });
  });

  it("user respond has no dismissReason", async () => {
    const service = new PermissionService();
    const pending = service.waitForResponse("p4", { sessionId: "s1" });
    expect(service.respond("p4", true, false, "allow-once")).toBe(true);
    await expect(pending).resolves.toEqual({
      approved: true,
      remember: false,
      optionId: "allow-once",
    });
  });
});
