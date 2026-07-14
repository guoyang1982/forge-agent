import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = () => readFileSync(join(here, "app.js"), "utf-8");

/** Extract self-contained helper functions from app.js and evaluate them. */
function loadHelpers() {
  const source = appSource();
  const pick = (name) => {
    const match = source.match(
      new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`),
    );
    if (!match) throw new Error(`helper not found: ${name}`);
    return match[0];
  };
  const code = [
    pick("escapeHtml"),
    pick("sidebarIcon"),
    pick("tokenizeForWordDiff"),
    pick("wordDiffOps"),
    pick("wordDiffHtml"),
    pick("buildWordDiffMap"),
    pick("renderDiffLinesHtml"),
    pick("renderFullFileDiffHtml"),
    pick("diffStatsFromUnifiedDiff"),
    pick("patchStatsHtml"),
    pick("buildInlineDiffHtml"),
  ].join("\n");
  return new Function(
    `${code}\nreturn { buildInlineDiffHtml, renderFullFileDiffHtml, renderDiffLinesHtml, wordDiffHtml };`,
  )();
}

describe("word-level diff highlighting", () => {
  it("highlights only the changed words in a modified line pair", () => {
    const { wordDiffHtml } = loadHelpers();
    const wd = wordDiffHtml("const a = 1;", "const a = 2;");
    expect(wd).not.toBeNull();
    // unchanged tokens stay plain; only the changed token is wrapped
    expect(wd.oldHtml).toBe('const a = <span class="diff-word">1</span>;');
    expect(wd.newHtml).toBe('const a = <span class="diff-word">2</span>;');
  });

  it("falls back to whole-line (null) when lines are mostly different", () => {
    const { wordDiffHtml } = loadHelpers();
    expect(wordDiffHtml("aaaa bbbb", "zzzz qqqq wwww")).toBeNull();
  });

  it("applies word spans inside the merged full-file view", () => {
    const { renderDiffLinesHtml } = loadHelpers();
    const diff = [
      "@@ -1,1 +1,1 @@",
      "-let total = oldValue + 1;",
      "+let total = newValue + 1;",
    ].join("\n");
    const html = renderDiffLinesHtml(diff);
    expect(html).toContain('<span class="diff-word">oldValue</span>');
    expect(html).toContain('<span class="diff-word">newValue</span>');
    // shared tokens are not wrapped
    expect(html).toContain("let total = ");
  });

  it("escapes word-diff content (no HTML injection)", () => {
    const { wordDiffHtml } = loadHelpers();
    const wd = wordDiffHtml("x = a;", "x = <b>a</b>;");
    expect(wd.newHtml).toContain("&lt;");
    expect(wd.newHtml).toContain("&gt;");
    expect(wd.newHtml).not.toContain("<b>");
  });
});

describe("inline diff under patch tool lines", () => {
  it("renders a collapsible card with +/- stats, capped at maxLines", () => {
    const { buildInlineDiffHtml } = loadHelpers();
    const unifiedDiff = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      "-const a = 1;",
      "+const a = 2;",
      ...Array.from({ length: 20 }, (_, i) => `+line${i}`),
    ].join("\n");

    const html = buildInlineDiffHtml({ unifiedDiff, path: "src/x.ts" }, 5);
    // Collapsed by default — the header alone carries file + stats.
    expect(html).toContain('<details class="tool-inline-diff">');
    expect(html).toContain("tool-inline-diff-head");
    expect(html).toContain(">x.ts<");
    expect(html).toContain("+21");
    expect(html).toContain("-1");
    expect(html).toContain("diff-del");
    expect(html).toContain("diff-add");
    expect(html).toContain("还有 20 行");
    expect(html).not.toContain("line19");
  });

  it("renders the merged full-file view with line numbers and inlined hunks", () => {
    const { renderFullFileDiffHtml } = loadHelpers();
    const fullContent = ["head", "ctx", "b2", "ctx2", "tail"].join("\n");
    const unifiedDiff = [
      "--- a/x.py",
      "+++ b/x.py",
      "@@ -2,3 +2,3 @@",
      " ctx",
      "-b1",
      "+b2",
      " ctx2",
    ].join("\n");

    const html = renderFullFileDiffHtml(fullContent, unifiedDiff, true);
    // Plain lines outside the hunk keep their numbers.
    expect(html).toContain('<span class="diff-gutter">1</span>head');
    expect(html).toContain('<span class="diff-gutter">5</span>tail');
    // Deleted line shows red with no line number; added line is numbered.
    expect(html).toContain('diff-del" data-di="4"><span class="diff-gutter"></span>b1');
    expect(html).toContain('diff-add" data-di="5"><span class="diff-gutter">3</span>b2');
  });

  it("auto-detects file orientation when the applied flag lags the disk state", () => {
    const { renderFullFileDiffHtml } = loadHelpers();
    // File already contains the NEW content, but daemon still reports 待应用.
    const fullContent = ["head", "ctx", "b2", "ctx2", "tail"].join("\n");
    const unifiedDiff = [
      "@@ -2,3 +2,3 @@",
      " ctx",
      "-b1",
      "+b2",
      " ctx2",
    ].join("\n");

    const html = renderFullFileDiffHtml(fullContent, unifiedDiff, false);
    // New-file orientation wins: the added line is numbered, deleted is not.
    expect(html).toContain('diff-add" data-di="3"><span class="diff-gutter">3</span>b2');
    expect(html).toContain('diff-del" data-di="2"><span class="diff-gutter"></span>b1');
    expect(html).toContain('<span class="diff-gutter">5</span>tail');
  });

  it("apply-patch feedback is visible and updates pending markers in place", () => {
    const source = appSource();
    expect(source).toContain("markPatchAppliedInUi");
    expect(source).toContain('btn.textContent = "应用中…"');
    // Feedback must use the banner — pushEvent would fold into the collapsed activity.
    const applyBlock = source.match(
      /id="applyPatchBtn">应用补丁[\s\S]*?\n    }\n/,
    )?.[0] ?? "";
    expect(applyBlock).toContain("notifyUser");
    expect(applyBlock).not.toContain("pushEvent(");
  });

  it("clicking an inline diff line scrolls the right panel to it", () => {
    const source = appSource();
    expect(source).toContain("pendingCodeDetailScroll");
    expect(source).toContain("applyPendingCodeDetailScroll(root)");
    // Tool details carry the patch so clicks open the colored diff view.
    const toolDetail = source.match(
      /function buildToolEventDetail[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    expect(toolDetail).toContain("extractPatchFromToolCall");
  });

  it("returns empty for non-patch results and escapes content", () => {
    const { buildInlineDiffHtml } = loadHelpers();
    expect(buildInlineDiffHtml(null)).toBe("");
    expect(buildInlineDiffHtml({})).toBe("");
    const html = buildInlineDiffHtml({ unifiedDiff: '+<script>"x"' });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("is attached on both live completion and restored sessions", () => {
    const source = appSource();
    const liveBlock = source.match(
      /function completeToolLine[\s\S]*?\n}\n/,
    )?.[0] ?? "";
    expect(liveBlock).toContain("buildInlineDiffHtml");
    const restored = source.match(
      /function renderRestoredSession[\s\S]*?\n}\n\nasync function restoreSessionTimeline/,
    )?.[0] ?? "";
    expect(restored).toContain("buildInlineDiffHtml");
  });
});

describe("composer queue while a run is active", () => {
  it("Enter queues instead of stopping; only the button cancels", () => {
    const source = appSource();
    const submit = source.match(
      /async function handleComposerSubmit[\s\S]*?\n  }\n/,
    )?.[0] ?? "";
    expect(submit).toContain("opts.viaEnter");
    expect(submit).toContain("enqueueComposerRun");
    // cancelRun must stay behind the non-Enter path.
    expect(submit).toContain("cancelRun");
  });

  it("queued messages are dispatched when the run finishes, dropped on stop", () => {
    const source = appSource();
    expect(source).toContain("dispatchQueuedRun(finishedSid, wasStopped)");
    const dispatch = source.match(
      /function dispatchQueuedRun[\s\S]*?\n  }\n/,
    )?.[0] ?? "";
    expect(dispatch).toContain("queuedRunsBySession");
    expect(dispatch).toContain("executeAgentRun");
  });

  it("composer input stays editable during a run", () => {
    const ui = readFileSync(join(here, "session-run-ui.js"), "utf-8");
    expect(ui).toContain("input.readOnly = false");
    expect(ui).not.toContain("input.readOnly = viewingRunning");
  });
});
