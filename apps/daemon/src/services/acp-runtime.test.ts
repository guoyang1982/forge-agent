import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@forge/protocol";
import { mapAcpUpdate } from "./acp-runtime.js";

describe("ACP runtime updates", () => {
  it("emits running tool activity when raw input arrives in a tool update", () => {
    const events: AgentEvent[] = [];
    mapAcpUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        title: "Edit File",
        status: "in_progress",
        rawInput: { file_path: "src/app.ts" },
      },
      events.push.bind(events),
      "session-1",
      { value: "" },
    );

    expect(events[0]).toMatchObject({
      type: "runtime_activity",
      sessionId: "session-1",
      callId: "call-1",
      status: "running",
      name: "Edit File",
      args: { file_path: "src/app.ts" },
    });
  });
});
