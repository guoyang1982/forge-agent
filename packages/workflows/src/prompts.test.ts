import { describe, expect, it } from "vitest";
import { buildPlanPrompt } from "./plan.js";
import { buildReviewPrompt } from "./review.js";

describe("workflow prompts", () => {
  it("builds a read-only plan prompt", () => {
    const prompt = buildPlanPrompt({
      goal: "add sessions",
      cwd: "/tmp/project",
      context: "existing context",
    });

    expect(prompt).toContain("planning mode");
    expect(prompt).toContain("add sessions");
    expect(prompt).toContain("Do not propose file edits as already done");
    expect(prompt).toContain("Return valid JSON only");
  });

  it("builds a findings-first review prompt", () => {
    const prompt = buildReviewPrompt({
      diff: "diff --git a/a.ts b/a.ts",
      files: ["a.ts"],
    });

    expect(prompt).toContain("code review mode");
    expect(prompt).toContain("Findings");
    expect(prompt).toContain("a.ts");
    expect(prompt).toContain("Return valid JSON only");
  });
});
