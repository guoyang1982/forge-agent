import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type AgentEvent, type RunRequest } from "@forge/protocol";
import {
  applyClaudeNdjsonMessage,
  buildClaudeProcessEnv,
  claudeStdioKeepsStdinOpen,
  createClaudeStreamState,
  listClaudeModels,
  resolveClaudeRuntimePermissionMode,
} from "./claude-runtime.js";

const here = dirname(fileURLToPath(import.meta.url));

const ibrainModel = "anthropic.claude-sonnet-4-5-20250929-v1:0";
const missingSettings = join(tmpdir(), "forge-claude-missing-settings.json");

function writeClaudeSettings(env: Record<string, string>): string {
  const settingsPath = join(mkdtempSync(join(tmpdir(), "forge-claude-")), "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ env }));
  return settingsPath;
}

const forgeClaudeConfig = {
  ...DEFAULT_CONFIG,
  profiles: {
    "claude-code": {
      apiKey: "forge-profile-key",
      baseUrl: "http://forge-profile.example",
      name: ibrainModel,
    },
  },
  runtimes: {
    claudeCode: {
      env: {
        ANTHROPIC_API_KEY: "forge-runtime-key",
        ANTHROPIC_BASE_URL: "http://forge-runtime.example",
        ANTHROPIC_MODEL: ibrainModel,
      },
      models: [
        {
          id: ibrainModel,
          model: ibrainModel,
          displayName: "Claude Sonnet 4.5 · iBrain",
          isDefault: true,
        },
      ],
    },
  },
};

describe("listClaudeModels", () => {
  it("reads the default model from ~/.claude/settings.json", () => {
    const settingsPath = writeClaudeSettings({ ANTHROPIC_MODEL: ibrainModel });
    const listed = listClaudeModels(DEFAULT_CONFIG, { claudeSettingsPath: settingsPath });
    expect(listed.models[0]).toMatchObject({
      model: ibrainModel,
      isDefault: true,
    });
    expect(listed.models.map((item) => item.model)).toEqual(
      expect.arrayContaining(["sonnet", "opus", "haiku", ibrainModel]),
    );
  });

  it("ignores Forge claude-code profile and runtime config", () => {
    const listed = listClaudeModels(forgeClaudeConfig, {
      claudeSettingsPath: missingSettings,
    });
    expect(listed.models.map((item) => item.model)).toEqual(["sonnet", "opus", "haiku"]);
  });
});

describe("buildClaudeProcessEnv", () => {
  it("injects Anthropic env only from ~/.claude/settings.json", () => {
    const settingsPath = writeClaudeSettings({
      ANTHROPIC_API_KEY: "settings-key",
      ANTHROPIC_BASE_URL: "http://ibrain.qiyi.domain",
      ANTHROPIC_MODEL: ibrainModel,
      IQIYI_EMAIL: "dev@example.com",
    });

    const env = buildClaudeProcessEnv(forgeClaudeConfig, { PATH: "/usr/bin" }, {
      claudeSettingsPath: settingsPath,
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "settings-key",
      ANTHROPIC_BASE_URL: "http://ibrain.qiyi.domain",
      ANTHROPIC_MODEL: ibrainModel,
      IQIYI_EMAIL: "dev@example.com",
    });
    expect(env.ANTHROPIC_API_KEY).not.toBe("forge-profile-key");
    expect(env.ANTHROPIC_API_KEY).not.toBe("forge-runtime-key");
  });

  it("does not inject Forge profile env when Claude settings are missing", () => {
    const env = buildClaudeProcessEnv(forgeClaudeConfig, { PATH: "/usr/bin" }, {
      claudeSettingsPath: missingSettings,
    });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("applyClaudeNdjsonMessage", () => {
  function feed(messages: unknown[]) {
    const events: AgentEvent[] = [];
    const state = createClaudeStreamState();
    const finalText = { value: "" };
    const options = {
      cwd: "/tmp",
      sessionId: "sess-1",
      request: { cwd: "/tmp", message: "hi" } satisfies RunRequest,
      emit: (event: AgentEvent) => events.push(event),
    };
    for (const message of messages) {
      applyClaudeNdjsonMessage(message, options, finalText, state);
    }
    return {
      activities: events.filter((event) => event.type === "runtime_activity"),
      events,
    };
  }

  it("accumulates streamed tool input and emits done with args from user tool_result", () => {
    const { activities } = feed([
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_bash",
            name: "Bash",
            input: {},
          },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"command":"ls /Users/guoyang/Documents"}',
          },
        },
      },
      {
        type: "stream_event",
        event: { type: "content_block_stop", index: 1 },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_bash",
              content: "star-jump-adventure.html",
            },
          ],
        },
      },
    ]);

    expect(activities[0]).toMatchObject({
      runtime: "claude-code",
      activityKind: "command",
      status: "running",
      callId: "toolu_bash",
      name: "Bash",
    });
    expect(activities.some((event) => event.status === "running" && event.args?.command === "ls /Users/guoyang/Documents")).toBe(true);
    expect(activities.at(-1)).toMatchObject({
      status: "done",
      callId: "toolu_bash",
      activityKind: "command",
      result: "star-jump-adventure.html",
      args: { command: "ls /Users/guoyang/Documents" },
    });
  });

  it("maps Write tools onto reviewable file activity with a path and diff", () => {
    const { activities } = feed([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_write",
              name: "Write",
              input: {
                file_path: "/Users/guoyang/Documents/star-jump-adventure.html",
                content: "<html><body>Star Jump</body></html>",
              },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_write",
              content: [{ type: "text", text: "Wrote file" }],
            },
          ],
        },
      },
    ]);

    const done = activities.find((event) => event.status === "done");
    expect(done).toMatchObject({
      runtime: "claude-code",
      activityKind: "file",
      name: "Write",
      path: "/Users/guoyang/Documents/star-jump-adventure.html",
      result: "Wrote file",
    });
    expect(String(done?.label || "")).toContain("star-jump-adventure.html");
    expect(done?.patch?.unifiedDiff).toContain("+<html><body>Star Jump</body></html>");
    expect(done?.changes?.[0]).toMatchObject({
      path: "/Users/guoyang/Documents/star-jump-adventure.html",
      kind: "add",
    });
  });
});

describe("claude stdio permission stdin", () => {
  it("keeps stdin open so permission replies can be written", () => {
    expect(claudeStdioKeepsStdinOpen({ cwd: "/tmp", message: "hi" })).toBe(true);
    expect(
      claudeStdioKeepsStdinOpen({
        cwd: "/tmp",
        message: "hi",
        runtime: { provider: "claude-code", permissionMode: "bypass-permissions" },
      }),
    ).toBe(false);
    const source = readFileSync(join(here, "claude-runtime.ts"), "utf8");
    expect(source).not.toMatch(/stdin\.write\([\s\S]{0,200}stdin\.end\(\)/);
  });

  it("bypasses interactive tool approval for unattended automations", () => {
    const automation = {
      cwd: "/tmp",
      message: "写个新的小游戏",
      automationRun: { name: "执行一次 写个新的小游戏" },
    };
    expect(resolveClaudeRuntimePermissionMode(automation)).toBe("bypassPermissions");
    expect(claudeStdioKeepsStdinOpen(automation)).toBe(false);
  });
});
