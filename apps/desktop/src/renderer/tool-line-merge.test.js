import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf-8");

/** Extract self-contained helper functions from app.js and evaluate them. */
function loadToolHelpers() {
  const source = appSource();
  const pick = (name) => {
    const match = source.match(
      new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`),
    );
    if (!match) throw new Error(`helper not found: ${name}`);
    return match[0];
  };
  const code = [
    pick("normalizeToolArgsEnvelope"),
    pick("readToolArgString"),
    pick("normalizeRuntimeToolKey"),
    pick("isFileEditRuntimeTool"),
    pick("extractToolCallPath"),
    pick("buildReplaceStringsDiffPreview"),
    pick("buildCreateFileDiffPreview"),
    pick("extractPatchFromRuntimeToolArgs"),
    pick("extractPatchFromToolResult"),
    pick("toolCallSummary"),
    pick("truncateToolSummary"),
    "function formatTalentStepLabel(label) { return label; }",
    "function normalizeWorkspaceRelPath(_cwd, path) { return path; }",
    "function getActiveProject() { return null; }",
    pick("diffStatsFromUnifiedDiff"),
    pick("displayToolName"),
    pick("actionToolName"),
    pick("toolLineText"),
    pick("extractPatchFromToolCall"),
    pick("formatToolResultForDetail"),
    pick("buildToolDetailContent"),
  ].join("\n");
  return new Function(
    `${code}\nreturn { toolCallSummary, truncateToolSummary, toolLineText, formatToolResultForDetail, buildToolDetailContent, extractPatchFromToolCall, normalizeRuntimeToolKey };`,
  )();
}

describe("merged tool line rendering", () => {
  it("renders one line per tool call instead of start+end pairs", () => {
    const source = appSource();

    // Live path: tool_start opens the line, tool_end completes it in place.
    expect(source).toContain("beginToolLine(ev.name, ev.args, ev.callId, ev.talent)");
    expect(source).toContain('completeToolLine(ev.name, ev.result ?? "", ev.callId)');
    // The legacy two-line rendering must be gone.
    expect(source).not.toContain("Tool Start ·");
    expect(source).not.toContain("Tool End ·");
  });

  it("restored sessions also render a single completed line per tool call", () => {
    const source = appSource();
    const restored = source.match(
      /function renderRestoredSession[\s\S]*?\n}\n\nasync function restoreSessionTimeline/,
    )?.[0] ?? "";

    expect(restored).toContain("toolLineText(name, args, true)");
    expect(restored).toContain("buildToolEventDetail(name, args, result)");
    expect(restored).not.toContain("⏺");
  });

  it("tool detail carries the file location for the right panel", () => {
    const source = appSource();

    expect(source).toContain("toolCallFilePath");
    expect(source).toContain("openToolFileDetail");
    // toolFile must survive innerHTML serialization round-trips.
    expect(source).toContain('toolFile: detail.toolFile || ""');
  });

  it("summarizes file path / pattern / command on the line", () => {
    const { toolCallSummary, toolLineText } = loadToolHelpers();

    expect(toolCallSummary("read_file", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolCallSummary("grep", { pattern: "foo", glob: "*.ts" })).toBe(
      "foo · *.ts",
    );
    expect(toolCallSummary("run_command", { command: " ls -la " })).toBe(
      "ls -la",
    );
    expect(toolLineText("read_file", { path: "src/a.ts" }, false)).toBe(
      "⏺ 正在读取 src/a.ts",
    );
    expect(toolLineText("read_file", { path: "src/a.ts" }, true)).toBe(
      "✓ 已读取 src/a.ts",
    );
  });

  it("recognizes ACP/Cursor file edit tools with file_path args", () => {
    const { toolCallSummary, toolLineText, extractPatchFromToolCall, normalizeRuntimeToolKey } =
      loadToolHelpers();

    expect(normalizeRuntimeToolKey("Edit File")).toBe("write_patch");
    expect(toolCallSummary("Edit File", { file_path: "src/Demo.java" })).toBe(
      "src/Demo.java",
    );
    expect(toolLineText("Edit File", { file_path: "src/Demo.java" }, false)).toBe(
      "⏺ 正在编辑 src/Demo.java",
    );
    expect(toolLineText("Edit File", { file_path: "src/Demo.java" }, true)).toBe(
      "✓ 已编辑 src/Demo.java",
    );

    const patch = extractPatchFromToolCall(
      "StrReplace",
      {
        path: "src/a.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;",
      },
      "ok",
    );
    expect(patch?.path).toBe("src/a.ts");
    expect(patch?.unifiedDiff).toContain("-const a = 1;");
    expect(patch?.unifiedDiff).toContain("+const a = 2;");
    expect(patch?.applied).toBe(true);
  });

  it("parses nested ACP arguments for edit/create file tools", () => {
    const { toolCallSummary, toolLineText, extractPatchFromToolCall } = loadToolHelpers();

    expect(
      toolCallSummary("Edit File", {
        item: {
          input: { file_path: "src/Nested.java" },
        },
      }),
    ).toBe("src/Nested.java");

    const running = toolLineText("Write", {
      arguments: JSON.stringify({ file_path: "src/New.java", content: "class A {}" }),
    }, false);
    expect(running).toContain("正在编辑 src/New.java");

    const patch = extractPatchFromToolCall(
      "Edit File",
      {
        item: {
          arguments: JSON.stringify({
            file_path: "src/Nested.java",
            old_string: "a",
            new_string: "b",
          }),
        },
      },
      "ok",
    );
    expect(patch?.path).toBe("src/Nested.java");
    expect(patch?.unifiedDiff).toContain("-a");
    expect(patch?.unifiedDiff).toContain("+b");
  });

  it("records modified files when runtime tool lines complete", () => {
    const source = appSource();
    const complete = source.match(/function completeToolLine[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(complete).toContain("recordRunModifiedFile");
    expect(complete).toContain("buildInlineDiffHtml");
    expect(complete).toContain("isFileEditRuntimeTool");
  });

  it("reconciles workspace git diff into conclusion file list", () => {
    const source = appSource();
    expect(source).toContain("reconcileRunPatchesFromWorkspace");
    expect(source).toContain("getWorkspaceTurnDiffs");
    expect(source).toContain("runCheckpointShaBySession");
    expect(source).toContain("updateRunFilesChangedBar");
    expect(source).toContain("function renderRunConclusion");
    expect(source).toContain("scheduleWorkspaceTurnDiffPoll");
    expect(source).toContain("syncFileEditLiveLabel");
    expect(source).toContain("enrichBareEditLiveLabel");
  });

  it("keeps the file-name tail when truncating long paths", () => {
    const { truncateToolSummary } = loadToolHelpers();
    const longPath = `src/${"deep/".repeat(30)}Target.java`;

    const truncated = truncateToolSummary(longPath);
    expect(truncated.startsWith("…")).toBe(true);
    expect(truncated.endsWith("Target.java")).toBe(true);
  });

  it("unwraps read_file / grep JSON envelopes in the detail pane", () => {
    const { formatToolResultForDetail } = loadToolHelpers();

    const readResult = JSON.stringify({
      ok: true,
      content: "1|package demo;",
      path: "src/Demo.java",
      totalLines: 120,
      previewFromLine: 1,
      previewLineCount: 1,
    });
    const readText = formatToolResultForDetail("read_file", readResult);
    expect(readText).toContain("src/Demo.java");
    expect(readText).toContain("1|package demo;");
    expect(readText).not.toContain('{"ok"');

    const grepResult = JSON.stringify({
      ok: true,
      matchCount: 2,
      matches: "a.ts:1: foo\nb.ts:2: foo",
    });
    const grepText = formatToolResultForDetail("grep", grepResult);
    expect(grepText).toContain("匹配 2 处");
    expect(grepText).toContain("a.ts:1: foo");
  });
});
