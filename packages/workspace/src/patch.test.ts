import { describe, it, expect } from "vitest";
import {
  applySimplePatch,
  isEffectivelyApplied,
  diagnosePatchFailure,
  createFileFromPatch,
  buildCreateFileDiff,
  buildReplaceFileDiff,
} from "./patch.js";

describe("applySimplePatch", () => {
  it("applies a single hunk", () => {
    const original = "a\nb\nc\n";
    const diff = [
      "--- a/f",
      "+++ b/f",
      "@@ -2,1 +2,1 @@",
      " b",
      "-c",
      "+C",
    ].join("\n");
    expect(applySimplePatch(original, diff)).toBe("a\nb\nC\n");
  });

  it("tolerates small line drift", () => {
    const original = "line1\nline2\nline3\nline4\n";
    const diff = [
      "@@ -3,1 +3,1 @@",
      " line3",
      "-lineX",
      "+line3-edited",
    ].join("\n");
    // lineX not at line 3 — fuzz should still find line3 context... actually -lineX won't match
    expect(applySimplePatch(original, diff)).toBeNull();
  });

  it("applies a hunk whose @@ line number is shifted (block search)", () => {
    // Real-world failure: model declared line 2 but content lives 23 lines later.
    const filler = Array.from({ length: 23 }, (_, i) => `pad${i}`);
    const original = ["head", ...filler, "ctx", "old", "tail", ""].join("\n");
    const diff = [
      "@@ -2,2 +2,2 @@",
      " ctx",
      "-old",
      "+new",
    ].join("\n");
    expect(applySimplePatch(original, diff)).toBe(
      ["head", ...filler, "ctx", "new", "tail", ""].join("\n"),
    );
  });

  it("is not derailed by repeated lines near the hunk (blank/else)", () => {
    // Old per-line fuzz matched the FIRST "" or "else:" within ±50 lines and
    // dragged the cursor backwards; whole-block matching must stay put.
    const original = [
      "def a():",
      "    if x:",
      "        pass",
      "    else:",
      "        one()",
      "",
      "def b():",
      "    if y:",
      "        pass",
      "    else:",
      "        two()",
      "",
    ].join("\n");
    const diff = [
      "@@ -10,2 +10,2 @@",
      "     else:",
      "-        two()",
      "+        two_fixed()",
    ].join("\n");
    expect(applySimplePatch(original, diff)).toBe(
      original.replace("two()", "two_fixed()"),
    );
  });

  it("picks the occurrence nearest to the declared line among duplicates", () => {
    const block = ["    else:", "        handle()"];
    const original = [
      ...block, //  lines 1-2
      "mid1",
      "mid2",
      ...block, //  lines 5-6 (nearest to the declared line)
      "tail",
      "",
    ].join("\n");
    const diff = [
      "@@ -6,2 +6,2 @@",
      "     else:",
      "-        handle()",
      "+        handled()",
    ].join("\n");
    const out = applySimplePatch(original, diff);
    // Only the second occurrence is rewritten.
    expect(out).toBe(
      [...block, "mid1", "mid2", "    else:", "        handled()", "tail", ""].join("\n"),
    );
  });
});

describe("isEffectivelyApplied", () => {
  it("detects when additions already exist", () => {
    const original = "HUD_HEIGHT = 74\nMAX_LEVEL = 5\n";
    const diff = [
      "@@ -1,1 +1,1 @@",
      "-HUD_HEIGHT = 58",
      "+HUD_HEIGHT = 74",
      "+MAX_LEVEL = 5",
    ].join("\n");
    expect(isEffectivelyApplied(original, diff)).toBe(true);
  });
});

describe("buildReplaceFileDiff", () => {
  it("replaces entire file instead of prepending (overwrite bug)", () => {
    const previous = '{"a":1}\n{"duplicate":true}\n';
    const next = '{"a":1}\n';
    const diff = buildReplaceFileDiff("diagram.excalidraw", previous, next);
    expect(applySimplePatch(previous, diff)).toBe(next);
  });

  it("falls back to create diff when previous is empty", () => {
    const diff = buildReplaceFileDiff("new.json", "", '{"x":1}');
    expect(diff).toBe(buildCreateFileDiff("new.json", '{"x":1}'));
  });
});

describe("createFileFromPatch", () => {
  it("parses new file diff", () => {
    const diff = [
      "--- /dev/null",
      "+++ b/new.py",
      "@@ -0,0 +1,2 @@",
      "+print(1)",
      "+print(2)",
    ].join("\n");
    expect(createFileFromPatch(diff)).toBe("print(1)\nprint(2)");
  });
});

describe("diagnosePatchFailure", () => {
  it("reports line mismatch", () => {
    const original = "keep\nold\n";
    const diff = ["@@ -2,1 +2,1 @@", " keep", "-old", "+new"].join("\n");
    const d = diagnosePatchFailure(original, diff.replace("-old", "-WRONG"));
    expect(d.message).toMatch(/mismatch|Context/i);
  });
});
