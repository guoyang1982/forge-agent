import { describe, expect, it, vi } from "vitest";
import type { ChannelAdapterRecord } from "@forge/protocol";
import type { ChannelStore } from "@forge/channel";
import {
  assertGlobalMobileAvailable,
  handleListChannels,
  redactChannelRecord,
} from "./channel-service.js";

function record(
  kind: ChannelAdapterRecord["kind"],
  config: Record<string, unknown>,
  overrides: Partial<ChannelAdapterRecord> = {},
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
    ...overrides,
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

describe("computer-level Forge Mobile channel", () => {
  it("includes Mobile when listing channels for a different project", async () => {
    const mobile = record("mobile", { relayOrigin: "https://relay.example.com" }, {
      id: "mobile-global",
      cwd: "/workspace/owner",
    });
    const local = record("ilink", {}, { id: "local-channel", cwd: "/workspace/current" });
    const all = [mobile, local];
    const list = vi.fn((opts?: { cwd?: string }) =>
      opts?.cwd ? all.filter((channel) => channel.cwd === opts.cwd) : all,
    );
    const result = await handleListChannels(
      { cwd: "/workspace/current", includeGlobalMobile: true },
      {
        getStore: () => ({ list } as unknown as ChannelStore),
        getGatewayHost: () => {
          throw new Error("not used");
        },
      },
    );

    expect(result.channels.map((channel) => channel.id)).toEqual([
      "mobile-global",
      "local-channel",
    ]);
    expect(list).toHaveBeenCalledWith({ cwd: "/workspace/current" });
  });

  it("prevents creating a second Mobile channel", () => {
    const mobile = record("mobile", {}, { name: "Forge Mobile" });
    expect(() => assertGlobalMobileAvailable("mobile", [mobile])).toThrow(
      /already configured as a computer-level channel/,
    );
    expect(() => assertGlobalMobileAvailable("ilink", [mobile])).not.toThrow();
  });
});
