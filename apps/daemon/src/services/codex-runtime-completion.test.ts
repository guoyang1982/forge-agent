import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyCodexTurnNotification,
  ensureCodexModelsCacheCompatible,
  isCodexModelsCacheStderr,
  isCodexThreadIdleNotification,
  shouldSurfaceCodexStderr,
  stripAnsi,
} from "./codex-runtime.js";

describe("Codex turn completion signals", () => {
  it("recognizes thread idle as a terminal signal once the turn is armed", () => {
    const idle = {
      method: "thread/status/changed",
      params: { threadId: "t1", status: { type: "idle" } },
    };
    expect(isCodexThreadIdleNotification(idle)).toBe(true);
    expect(classifyCodexTurnNotification(idle, false)).toBeNull();
    expect(classifyCodexTurnNotification(idle, true)).toBe("idle");
    expect(
      classifyCodexTurnNotification(
        { method: "thread/status/changed", params: { status: "idle" } },
        true,
      ),
    ).toBe("idle");
  });

  it("still accepts legacy turn/completed and turn/failed", () => {
    expect(
      classifyCodexTurnNotification({ method: "turn/completed", params: {} }, true),
    ).toBe("completed");
    expect(
      classifyCodexTurnNotification({ method: "turn/failed", params: {} }, true),
    ).toBe("failed");
    expect(
      classifyCodexTurnNotification({ method: "turn/canceled", params: {} }, true),
    ).toBe("canceled");
    expect(
      classifyCodexTurnNotification({ method: "turn/started", params: {} }, false),
    ).toBe("started");
  });

  it("does not treat active thread status as completion", () => {
    expect(
      classifyCodexTurnNotification(
        {
          method: "thread/status/changed",
          params: { status: { type: "active", activeFlags: [] } },
        },
        true,
      ),
    ).toBeNull();
  });
});

describe("Codex models-cache stderr handling", () => {
  it("strips ANSI and suppresses models-cache ERROR noise", () => {
    const ansi =
      "\u001b[2m2026-07-20T05:00:15Z\u001b[0m \u001b[31mERROR\u001b[0m codex_models_manager::manager: failed to renew cache TTL: missing field 'supports_reasoning_summaries' at line 88 column 5";
    expect(stripAnsi(ansi)).toContain("failed to renew cache TTL");
    expect(isCodexModelsCacheStderr(ansi)).toBe(true);
    expect(shouldSurfaceCodexStderr(ansi)).toBe(false);
    expect(
      shouldSurfaceCodexStderr(
        "2026-07-20T05:00:15Z ERROR something_else: boom",
      ),
    ).toBe(true);
  });

  it("repairs models_cache.json missing supports_reasoning_summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-codex-cache-"));
    const path = join(dir, "models_cache.json");
    writeFileSync(
      path,
      JSON.stringify({
        fetched_at: "2026-07-20T00:00:00Z",
        models: [
          {
            slug: "gpt-5.6-sol",
            default_reasoning_summary: "auto",
            supported_reasoning_levels: [{ effort: "medium" }],
          },
          {
            slug: "gpt-lite",
          },
        ],
      }),
      "utf8",
    );

    expect(ensureCodexModelsCacheCompatible(path)).toEqual({ repaired: true });
    const repaired = JSON.parse(readFileSync(path, "utf8")) as {
      models: Array<{ supports_reasoning_summaries?: boolean }>;
    };
    expect(repaired.models[0]?.supports_reasoning_summaries).toBe(true);
    expect(repaired.models[1]?.supports_reasoning_summaries).toBe(false);
    expect(ensureCodexModelsCacheCompatible(path)).toEqual({ repaired: false });
  });
});
