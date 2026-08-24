import { describe, expect, it } from "vitest";
import { CancelService } from "./cancel-service.js";

describe("CancelService", () => {
  it("reports whether a session really had a live run", () => {
    const service = new CancelService();

    expect(service.cancel("stale-session")).toEqual({ ok: true, canceled: false });

    const controller = service.registerRun("live-session");
    expect(service.activeSessionIds()).toEqual(["live-session"]);
    expect(service.cancel("live-session")).toEqual({ ok: true, canceled: true });
    expect(controller.signal.aborted).toBe(true);
  });
});
