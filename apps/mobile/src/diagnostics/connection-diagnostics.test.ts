import { describe, expect, it } from "vitest";
import {
  diagnosticEntry,
  retryDelayMs,
  sanitizeText,
  shouldRetryConnection,
} from "./connection-diagnostics.js";

describe("Mobile connection diagnostics", () => {
  it("redacts credentials, opaque secrets and URL query values", () => {
    const text = sanitizeText(
      "Bearer invite_12345678901234567890 https://relay/connect?token=resume_12345678901234567890 secret AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(text).not.toContain("12345678901234567890");
    expect(text).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(text).toContain("[redacted]");
  });

  it("bounds exponential retry and stops on E2EE integrity failures", () => {
    expect(retryDelayMs(0, () => 0)).toBe(500);
    expect(retryDelayMs(20, () => 0)).toBe(30_000);
    expect(retryDelayMs(20, () => 1)).toBe(30_000);
    expect(shouldRetryConnection("连接 Relay 超时")).toBe(true);
    expect(shouldRetryConnection("端到端安全校验失败，连接已关闭")).toBe(false);
    expect(shouldRetryConnection("连接凭证已失效，请在 Desktop 重新配对")).toBe(false);
    expect(
      diagnosticEntry({ hostId: "host_123456789012345678", level: "info", event: "connected" })
        .hostId,
    ).toBe("host_123…5678");
  });
});
