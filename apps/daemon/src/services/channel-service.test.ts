import { describe, expect, it } from "vitest";
import type { ChannelAdapterRecord } from "@forge/protocol";
import { redactChannelRecord } from "./channel-service.js";

function record(
  kind: ChannelAdapterRecord["kind"],
  config: Record<string, unknown>,
): ChannelAdapterRecord {
  return {
    id: "channel-1",
    kind,
    name: "test",
    enabled: false,
    cwd: "/workspace",
    config,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

describe("channel config redaction", () => {
  it("never returns Mobile enrollment credentials to API clients", () => {
    const input = record("mobile", {
      relayOrigin: "https://relay.example.com",
      enrollmentToken: "super-secret-enrollment-token",
    });

    expect(redactChannelRecord(input).config).toEqual({
      relayOrigin: "https://relay.example.com",
      enrollmentToken: "[configured]",
    });
    expect(input.config.enrollmentToken).toBe("super-secret-enrollment-token");
  });

  it("also redacts existing message-channel credentials", () => {
    expect(
      redactChannelRecord(record("ilink", { botToken: "bot-secret", baseUrl: "https://api" }))
        .config,
    ).toEqual({ botToken: "[configured]", baseUrl: "https://api" });
    expect(
      redactChannelRecord(
        record("http", { webhookUrl: "https://hook/secret", authHeader: "Bearer secret" }),
      ).config,
    ).toEqual({ webhookUrl: "[configured]", authHeader: "[configured]" });
  });
});
