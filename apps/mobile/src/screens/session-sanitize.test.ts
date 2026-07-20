import { describe, expect, it } from "vitest";
import { parseMessages, parseSessionEvents, parseSessions } from "./session-sanitize.js";

describe("Mobile session response sanitization", () => {
  it("keeps only the session fields rendered by the app", () => {
    expect(
      parseSessions({
        sessions: [
          {
            id: "session_01",
            cwd: "/workspace/a",
            updatedAt: "2026-07-16T00:00:00.000Z",
            messageCount: 2,
            lastPreview: "hello",
            secretInternalField: "must-not-pass",
          },
          { id: 123, cwd: "/invalid" },
        ],
      }),
    ).toEqual([
      {
        id: "session_01",
        cwd: "/workspace/a",
        updatedAt: "2026-07-16T00:00:00.000Z",
        messageCount: 2,
        lastPreview: "hello",
      },
    ]);
  });

  it("renders text only and drops unknown roles or non-text parts", () => {
    expect(
      parseMessages({
        messages: [
          { role: "user", content: "hello", hidden: "drop" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "answer" },
              { type: "image_url", image_url: { url: "data:secret" } },
            ],
          },
          { role: "admin", content: "drop" },
        ],
      }),
    ).toEqual([
      { key: "0:user", role: "user", text: "hello" },
      { key: "1:assistant", role: "assistant", text: "answer" },
    ]);
  });

  it("keeps assistant tool_calls and tool results for timeline rebuild", () => {
    expect(
      parseMessages({
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_9",
                type: "function",
                function: { name: "shell", arguments: "{\"cmd\":\"ls\"}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_9",
            content: "ok",
            secret: "drop",
          },
        ],
      }),
    ).toEqual([
      {
        key: "0:assistant",
        role: "assistant",
        text: "",
        toolCalls: [{ id: "call_9", name: "shell" }],
      },
      {
        key: "1:tool",
        role: "tool",
        text: "ok",
        toolCallId: "call_9",
      },
    ]);
  });

  it("sanitizes persisted session events into mobile UI tools/files", () => {
    expect(
      parseSessionEvents({
        events: [
          {
            event: {
              type: "runtime_activity",
              runtime: "codex",
              activityKind: "command",
              status: "done",
              callId: "cmd_1",
              name: "run_command",
              args: { command: "pnpm test" },
              secret: "drop",
            },
          },
          {
            event: {
              type: "runtime_activity",
              runtime: "codex",
              activityKind: "file",
              status: "done",
              callId: "file_1",
              path: "game.html",
              adds: 10,
              dels: 0,
            },
          },
        ],
      }),
    ).toEqual([
      {
        kind: "tool",
        callId: "cmd_1",
        name: "Shell 运行命令",
        status: "done",
        detail: "pnpm test",
      },
      {
        kind: "file_change",
        path: "game.html",
        status: "modified",
        additions: 10,
        deletions: 0,
      },
    ]);
  });
});
