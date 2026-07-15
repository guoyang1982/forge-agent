import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildCodexCommandChip,
  buildCodexFileChip,
  codexReasoningText,
  emitCodexActivityChip,
  emitRuntimeActivity,
  isCodexChipItemType,
  isCodexToolItemType,
  normalizeCodexToolName,
} from "./external-runtime-events.js";
import type { AgentEvent } from "@forge/protocol";

const here = dirname(fileURLToPath(import.meta.url));

describe("external-runtime-events", () => {
  it("recognizes codex chip and tool item types", () => {
    expect(isCodexChipItemType("commandExecution")).toBe(true);
    expect(isCodexChipItemType("fileChange")).toBe(true);
    expect(isCodexToolItemType("commandExecution")).toBe(false);
    expect(isCodexToolItemType("mcpToolCall")).toBe(true);
  });

  it("normalizes codex command items to run_command", () => {
    expect(
      normalizeCodexToolName("commandExecution", { type: "commandExecution", command: "ls" }),
    ).toBe("run_command");
  });

  it("builds codex command activity labels from commandActions", () => {
    const chip = buildCodexCommandChip(
      {
        type: "commandExecution",
        id: "call_1",
        commandActions: [
          { type: "listFiles", command: "ls" },
          { type: "read", path: "/tmp/a" },
        ],
      },
      false,
    );
    expect(chip.label).toContain("已列出文件");
    expect(chip.label).toContain("已读取 1 个文件");
    expect(chip.status).toBe("done");
  });

  it("preserves the exact command, output, exit code, cwd, and duration", () => {
    const chip = buildCodexCommandChip(
      {
        type: "commandExecution",
        id: "exec_1",
        command: "pnpm test -- --run app.test.ts",
        cwd: "/workspace/forge",
        aggregatedOutput: "12 tests passed\n",
        exitCode: 0,
        durationMs: 1250,
        commandActions: [{ type: "unknown", command: "pnpm test" }],
      },
      false,
    );
    expect(chip.label).toBe("已运行 pnpm test -- --run app.test.ts");
    expect(chip.args).toMatchObject({
      command: "pnpm test -- --run app.test.ts",
      cwd: "/workspace/forge",
      exitCode: 0,
    });
    expect(chip.result).toBe("12 tests passed\n");
    expect(chip.durationMs).toBe(1250);
  });

  it("builds codex file activity labels with diff stats", () => {
    const running = buildCodexFileChip(
      {
        type: "fileChange",
        id: "call_2",
        changes: [
          {
            path: "/tmp/app.js",
            kind: { type: "modify" },
            diff: "--- a/app.js\n+++ b/app.js\n@@ -1,2 +1,2 @@\n-old\n+new\n",
          },
        ],
      },
      true,
    );
    expect(running?.label).toBe("正在编辑 app.js");
    expect(running?.adds).toBe(1);
    expect(running?.dels).toBe(1);

    const chip = buildCodexFileChip(
      {
        type: "fileChange",
        id: "call_2",
        changes: [
          {
            path: "/tmp/hello.html",
            kind: { type: "add" },
            diff: "--- /dev/null\n+++ b/hello.html\n@@ -0,0 +1,2 @@\n+line\n+two\n",
          },
        ],
      },
      false,
    );
    expect(chip?.label).toContain("hello.html");
    expect(chip?.adds).toBe(2);
    expect(chip?.dels).toBe(0);
    expect(chip?.patch?.path).toContain("hello.html");
  });

  it("builds running codex file activity from top-level path before diff arrives", () => {
    const chip = buildCodexFileChip(
      {
        type: "fileChange",
        id: "call_early",
        path: "/tmp/meteor-runner.html",
      },
      true,
    );

    expect(chip?.label).toBe("正在编辑 meteor-runner.html");
    expect(chip?.status).toBe("running");
    expect(chip?.adds).toBe(0);
    expect(chip?.dels).toBe(0);
  });

  it("converts full content from a newly added file into a counted unified diff", () => {
    const chip = buildCodexFileChip(
      {
        type: "fileChange",
        id: "call_add_content",
        changes: [
          {
            path: "/tmp/new.html",
            kind: { type: "add" },
            diff: "<html>\n<body>hello</body>\n</html>\n",
          },
        ],
      },
      false,
    );

    expect(chip?.adds).toBe(3);
    expect(chip?.dels).toBe(0);
    expect(chip?.patch?.unifiedDiff).toContain("--- /dev/null");
    expect(chip?.patch?.unifiedDiff).toContain("@@ -0,0 +1,3 @@");
    expect(chip?.patch?.unifiedDiff).toContain("+<body>hello</body>");
  });

  it("keeps all files and aggregates stats for streaming multi-file changes", () => {
    const chip = buildCodexFileChip(
      {
        type: "fileChange",
        id: "multi",
        changes: [
          { path: "src/a.ts", kind: { type: "update" }, diff: "--- a\n+++ b\n-old\n+new" },
          { path: "src/b.ts", kind: { type: "add" }, diff: "--- /dev/null\n+++ b\n+one\n+two" },
        ],
      },
      true,
    );
    expect(chip?.label).toBe("正在修改 2 个文件");
    expect(chip?.adds).toBe(3);
    expect(chip?.dels).toBe(1);
    expect(chip?.changes?.map((change) => change.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("accepts file path aliases and rejects pathless file changes", () => {
    expect(
      buildCodexFileChip(
        { type: "fileChange", id: "alias", filePath: "/tmp/alias.ts" },
        true,
      )?.label,
    ).toBe("正在编辑 alias.ts");
    expect(buildCodexFileChip({ type: "fileChange", id: "missing" }, true)).toBeNull();
  });

  it("emits codex_activity agent events", () => {
    const events: AgentEvent[] = [];
    emitCodexActivityChip(events.push.bind(events), "sess-1", {
      callId: "call_1",
      icon: "search",
      label: "已搜索代码",
      status: "done",
    });
    expect(events[0]).toMatchObject({
      type: "codex_activity",
      sessionId: "sess-1",
      label: "已搜索代码",
      icon: "search",
    });
  });

  it("emits standardized runtime_activity events for UI adapters", () => {
    const events: AgentEvent[] = [];
    emitRuntimeActivity(events.push.bind(events), "sess-1", {
      runtime: "claude-code",
      callId: "tool_1",
      activityKind: "tool",
      status: "running",
      name: "Read",
      args: { file_path: "src/app.ts" },
    });

    expect(events[0]).toMatchObject({
      type: "runtime_activity",
      sessionId: "sess-1",
      runtime: "claude-code",
      callId: "tool_1",
      activityKind: "tool",
      status: "running",
      name: "Read",
    });
  });

  it("extracts codex reasoning text from content blocks", () => {
    expect(
      codexReasoningText({
        type: "reasoning",
        content: [{ text: "Parse game script" }, { text: "Playtest in Chromium" }],
      }),
    ).toBe("Parse game script\nPlaytest in Chromium");
  });

  it("terminalizes orphaned Codex activity when the turn completes", () => {
    const source = readFileSync(join(here, "codex-runtime.ts"), "utf8");
    expect(source).toContain("activeChipItems");
    const completed = source.match(
      /if \(message\.method\.includes\("turn\/completed"\)\)[\s\S]*?\n  }/,
    )?.[0] ?? "";
    expect(completed).toContain("emitCodexChipFromItem");
    expect(completed).toContain("activeChipItems.clear()");
  });
});
