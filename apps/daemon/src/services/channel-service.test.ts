import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapterRecord } from "@forge/protocol";
import type { ChannelStore } from "@forge/channel";
import {
  assertGlobalMobileAvailable,
  handleCreateChannel,
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

  it("creates Mobile without binding it to a project directory", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "forge-channel-service-"));
    tempDirs.push(dataDir);
    const configPath = join(dataDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        permissions: {
          channels: { enabled: true, create: "allow", start: "allow", delete: "allow" },
          mobile: { enabled: true, allowedProjects: [dataDir] },
        },
      }),
    );
    vi.stubEnv("FORGE_CONFIG_PATH", configPath);
    vi.stubEnv("FORGE_DATA_DIR", dataDir);

    const createFromDraft = vi.fn((draft: { kind: string }, cwd: string) =>
      record("mobile", { relayOrigin: "https://relay.example.com" }, { cwd }),
    );
    const result = await handleCreateChannel(
      {
        draft: {
          kind: "mobile",
          name: "Forge Mobile",
          // 前端不再传项目目录；即使传了也应被忽略。
          cwd: "/definitely/not/a/real/project",
          config: { relayOrigin: "https://relay.example.com", enrollmentToken: "x".repeat(32) },
        },
        skipConfirm: true,
      },
      {
        getStore: () => ({ list: () => [], createFromDraft } as unknown as ChannelStore),
        getGatewayHost: () => {
          throw new Error("not used");
        },
      },
    );

    expect(createFromDraft).toHaveBeenCalledWith(expect.anything(), homedir());
    expect(result.channel.cwd).toBe(homedir());
  });
});

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
