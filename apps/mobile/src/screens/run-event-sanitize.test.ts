import { describe, expect, it } from "vitest";
import { parseRunEvent } from "./run-event-sanitize.js";

describe("Mobile run event sanitization", () => {
  it("keeps streaming text and tool labels without tool args or result", () => {
    expect(parseRunEvent({ type: "text_delta", delta: "hello", hidden: "drop" })).toEqual({
      kind: "text",
      delta: "hello",
    });
    expect(
      parseRunEvent({
        type: "tool_start",
        callId: "call_01",
        name: "exec_command",
        args: { apiKey: "must-not-render" },
      }),
    ).toEqual({ kind: "tool", callId: "call_01", name: "exec_command", status: "running" });
    expect(
      parseRunEvent({
        type: "tool_end",
        callId: "call_01",
        name: "exec_command",
        result: "potentially huge or sensitive",
      }),
    ).toEqual({ kind: "tool", callId: "call_01", name: "exec_command", status: "done" });
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
  });
});
