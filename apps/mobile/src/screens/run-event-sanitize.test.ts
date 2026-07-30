import { describe, expect, it } from "vitest";
import {
  appendStreamingText,
  parseRunEvent,
  parseRunEvents,
  sanitizeStatusLabel,
} from "./run-event-sanitize.js";

describe("Mobile run event sanitization", () => {
  it("keeps streaming text and tool labels without tool args or result secrets", () => {
    expect(parseRunEvent({ type: "text_delta", delta: "hello", hidden: "drop" })).toEqual({
      kind: "text",
      delta: "hello",
    });
    expect(
      parseRunEvent({
        type: "tool_start",
        callId: "call_01",
        name: "exec_command",
        args: { apiKey: "must-not-render", path: "src/app.ts" },
      }),
    ).toEqual({
      kind: "tool",
      callId: "call_01",
      name: "exec_command",
      status: "running",
      detail: "src/app.ts",
    });
    expect(
      parseRunEvent({
        type: "tool_end",
        callId: "call_01",
        name: "exec_command",
        result: "potentially huge or sensitive",
      }),
    ).toEqual({
      kind: "tool",
      callId: "call_01",
      name: "exec_command",
      status: "done",
      output: "potentially huge or sensitive",
    });
  });

  it("accepts thinking_delta.delta and Codex runtime_activity chips", () => {
    expect(parseRunEvent({ type: "thinking_delta", delta: "检查登录流程" })).toEqual({
      kind: "thinking",
      text: "检查登录流程",
    });
    expect(parseRunEvent({
      type: "runtime_activity",
      runtime: "codex",
      activityKind: "read",
      status: "done",
      callId: "read_1",
      name: "read_file",
      path: "src/store/auth.ts",
      label: "已读取 auth.ts",
    })).toEqual({
      kind: "tool",
      callId: "read_1",
      name: "ReadFile 读取文件",
      status: "done",
      detail: "src/store/auth.ts",
    });
    expect(parseRunEvents({
      type: "runtime_activity",
      runtime: "codex",
      activityKind: "file",
      status: "done",
      callId: "file_1",
      path: "src/a.ts",
      adds: 3,
      dels: 1,
      label: "已修改 a.ts",
      changes: [
        { path: "src/a.ts", kind: "update", adds: 3, dels: 1 },
        { path: "src/b.ts", kind: "add", adds: 12, dels: 0 },
      ],
    })).toEqual([
      {
        kind: "file_change",
        path: "src/a.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        summary: "已修改 a.ts",
      },
      {
        kind: "file_change",
        path: "src/b.ts",
        status: "added",
        additions: 12,
        deletions: 0,
        summary: "已修改 a.ts",
      },
    ]);
  });

  it("dedupes full-text replay chunks while streaming", () => {
    expect(appendStreamingText("你好", "你好")).toBe("你好");
    expect(appendStreamingText("你好", "你好世界")).toBe("你好世界");
    expect(appendStreamingText("AB", "CD")).toBe("ABCD");
    expect(appendStreamingText("hello world", " world")).toBe("hello world");
  });

  it("collapses Codex models-cache ERROR status into a short warning", () => {
    const raw =
      "Codex: \u001b[31mERROR\u001b[0m codex_models_manager::manager: failed to renew cache TTL: missing field 'supports_reasoning_summaries' at line 88 column 5";
    expect(sanitizeStatusLabel(raw)).toBe("Codex 模型缓存需刷新（不影响本轮）");
    expect(parseRunEvent({ type: "status", message: raw })).toEqual({
      kind: "status",
      label: "Codex 模型缓存需刷新（不影响本轮）",
    });
    expect(parseRunEvent({ type: "done", sessionId: "s1", finalText: "done" })).toEqual({
      kind: "done",
      sessionId: "s1",
      finalText: "done",
    });
  });

  it("drops unknown events and minimizes permission requests", () => {
    expect(parseRunEvent({ type: "private_internal", secret: "drop" })).toBeNull();
    expect(
      parseRunEvent({
        type: "permission_request",
        id: "permission_01",
        sessionId: "session_01",
        summary: "允许执行命令？",
        detail: { command: "secret command" },
        options: [{ optionId: "allow_once", name: "允许一次", kind: "allow_once", secret: "drop" }],
      }),
    ).toEqual({
      kind: "permission",
      requestId: "permission_01",
      sessionId: "session_01",
      summary: "允许执行命令？",
      options: [{ optionId: "allow_once", name: "允许一次", allow: true }],
    });
    expect(
      parseRunEvent({
        type: "permission_dismissed",
        id: "permission_01",
        sessionId: "session_01",
        reason: "timeout",
      }),
    ).toEqual({
      kind: "permission_dismissed",
      requestId: "permission_01",
      sessionId: "session_01",
    });
  });

  it("maps Codex approval options onto the sticky permission card", () => {
    expect(
      parseRunEvent({
        type: "permission_request",
        id: "codex_perm_01",
        sessionId: "session_codex",
        kind: "codex",
        summary: "执行命令: touch /tmp/forge-permission-probe",
        detail: {
          method: "item/commandExecution/requestApproval",
          command: "touch /tmp/forge-permission-probe",
        },
        options: [
          { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
          { optionId: "allow-session", name: "本会话总是允许", kind: "allow_always" },
          { optionId: "deny", name: "拒绝", kind: "reject_once" },
        ],
      }),
    ).toEqual({
      kind: "permission",
      requestId: "codex_perm_01",
      sessionId: "session_codex",
      summary: "执行命令: touch /tmp/forge-permission-probe",
      options: [
        { optionId: "allow-once", name: "允许一次", allow: true },
        { optionId: "allow-session", name: "本会话总是允许", allow: true },
        { optionId: "deny", name: "拒绝", allow: false },
      ],
    });
  });

  it("normalizes file activity and bounds command output", () => {
    expect(parseRunEvent({
      type: "command_output",
      callId: "call_01",
      command: "pnpm test",
      output: "x".repeat(60_000),
      privateArgs: "drop",
    })).toEqual({
      kind: "tool",
      callId: "call_01",
      name: "pnpm test",
      status: "done",
      detail: "pnpm test",
      output: "x".repeat(50_000),
    });
    expect(parseRunEvent({
      type: "file_change",
      path: "src/app.ts",
      status: "update",
      additions: 3,
      deletions: 1,
      content: "drop",
    })).toEqual({
      kind: "file_change",
      path: "src/app.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
    });
    expect(parseRunEvent({
      type: "file_change",
      path: "src/store/auth.ts",
      status: "modified",
      additions: 32,
      deletions: 8,
      summary: "修复登录成功后未广播状态变更，导致侧边栏未同步的问题",
    })).toEqual({
      kind: "file_change",
      path: "src/store/auth.ts",
      status: "modified",
      additions: 32,
      deletions: 8,
      summary: "修复登录成功后未广播状态变更，导致侧边栏未同步的问题",
    });
    expect(parseRunEvent({
      type: "patch_proposed",
      path: "snake-game.html",
      applied: true,
      unifiedDiff: [
        "--- /dev/null",
        "+++ snake-game.html",
        "@@ -0,0 +1,3 @@",
        "+<html>",
        "+body",
        "+</html>",
      ].join("\n"),
    })).toEqual({
      kind: "file_change",
      path: "snake-game.html",
      status: "added",
      additions: 3,
      summary: "已写入工作区",
    });
  });
});
