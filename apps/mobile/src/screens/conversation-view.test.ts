import { describe, expect, it } from "vitest";
import {
  buildConversationView,
  buildTimelineItems,
  isStatusLikeLine,
  toolsFromMessages,
} from "./conversation-view.js";
import type { MessageItem } from "./session-sanitize.js";

const sampleMessages: MessageItem[] = [
  { key: "0:user", role: "user", text: "inspect ports" },
  {
    key: "1:assistant",
    role: "assistant",
    text: "",
    toolCalls: [{ id: "call_1", name: "shell" }],
  },
  {
    key: "2:tool",
    role: "tool",
    text: "listening on 18789",
    toolCallId: "call_1",
  },
  {
    key: "3:assistant",
    role: "assistant",
    text: "## Summary\n\nPort **18789** is open.",
  },
];

describe("conversation view tool persistence", () => {
  it("reconstructs completed tools from persisted session.messages", () => {
    expect(toolsFromMessages(sampleMessages)).toEqual([
      {
        key: "tool:call_1",
        callId: "call_1",
        name: "shell",
        status: "done",
        output: "listening on 18789",
      },
    ]);
  });

  it("keeps tools after live events are gone so completed timeline stays expandable", () => {
    const view = buildConversationView(sampleMessages, [], "", "已完成", false);
    expect(view.tools).toHaveLength(1);
    expect(view.tools[0]?.name).toBe("shell");
    expect(view.liveAssistant).toBeNull();
    expect(view.completedSummary).toBe("已完成 · 1 步");

    const timeline = buildTimelineItems(sampleMessages, false, []);
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({
      kind: "agent",
      answers: ["## Summary\n\nPort **18789** is open."],
      tools: [{ callId: "call_1", name: "shell", status: "done" }],
    });
  });

  it("rebuilds Codex tools/files from persisted session events", () => {
    const view = buildConversationView(
      [{ key: "0:user", role: "user", text: "fix" }, {
        key: "1:assistant",
        role: "assistant",
        text: "已修复",
      }],
      [],
      "",
      "已完成",
      false,
      [
        {
          kind: "tool",
          callId: "c1",
          name: "ReadFile 读取文件",
          status: "done",
          detail: "src/store/auth.ts",
        },
        {
          kind: "tool",
          callId: "c2",
          name: "Shell 运行命令",
          status: "done",
          detail: "pnpm test --filter auth",
        },
        {
          kind: "file_change",
          path: "src/store/auth.ts",
          status: "modified",
          additions: 32,
          deletions: 8,
          summary: "修复登录同步",
        },
      ],
    );
    expect(view.tools).toHaveLength(2);
    expect(view.files).toHaveLength(1);
    expect(view.completedSummary).toBe("已完成 · 2 步 · 1 个文件");
    expect(view.keyChanges).toEqual(["修复登录同步"]);
    expect(view.verifications[0]?.command).toContain("pnpm test");
  });

  it("prefers live tool status while a run is in progress", () => {
    const view = buildConversationView(
      sampleMessages,
      [{ kind: "tool", callId: "call_1", name: "shell", status: "running", detail: "ss -lntp" }],
      "",
      "执行中",
      true,
    );
    expect(view.tools[0]).toMatchObject({
      callId: "call_1",
      status: "running",
      detail: "ss -lntp",
      output: "listening on 18789",
    });
  });

  it("does not keep liveAssistant after the run ends (avoids duplicate answer cards)", () => {
    const answer = "## Summary\n\nPort **18789** is open.";
    const view = buildConversationView(sampleMessages, [], answer, "已完成", false);
    expect(view.liveAssistant).toBeNull();

    const whileRunning = buildConversationView(sampleMessages, [], answer, "执行中", true);
    expect(whileRunning.liveAssistant).toBe(answer);
  });

  it("does not put status lines into thinking bullets", () => {
    expect(isStatusLikeLine("Codex turn 启动中...")).toBe(true);
    const view = buildConversationView(
      [{ key: "0:user", role: "user", text: "inspect" }],
      [
        { kind: "thinking", text: "Codex turn 启动中..." },
        { kind: "thinking", text: "检查端口占用" },
        { kind: "tool", callId: "t1", name: "shell", status: "running", detail: "ss -lntp" },
      ],
      "",
      "Codex turn 启动中...",
      true,
    );
    expect(view.thinking).toEqual(["检查端口占用"]);
    expect(view.tools).toHaveLength(1);
  });

  it("dedupes consecutive identical assistant answers in one agent turn", () => {
    const messages: MessageItem[] = [
      { key: "0:user", role: "user", text: "你好" },
      { key: "1:assistant", role: "assistant", text: "你好！我是 Forge。" },
      { key: "2:assistant", role: "assistant", text: "你好！我是 Forge。" },
    ];
    const timeline = buildTimelineItems(messages, false, []);
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({
      kind: "agent",
      answers: ["你好！我是 Forge。"],
    });
  });
});
