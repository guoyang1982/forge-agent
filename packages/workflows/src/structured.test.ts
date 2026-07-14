import { describe, expect, it } from "vitest";
import {
  extractJsonObject,
  formatStructuredPlan,
  formatStructuredReview,
  parseStructuredPlan,
  parseStructuredReview,
} from "./structured.js";

describe("structured workflow parsing", () => {
  it("extracts JSON from fenced and explanatory model output", () => {
    expect(extractJsonObject('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(extractJsonObject('Here is JSON:\n{"ok":{"nested":true}}\nThanks')).toBe(
      '{"ok":{"nested":true}}',
    );
  });

  it("parses and formats structured plans", () => {
    const plan = parseStructuredPlan(`\`\`\`json
{
  "summary": "Add sessions",
  "steps": [{ "title": "Inspect session store" }],
  "filesToInspect": ["packages/session/src/index.ts"],
  "risks": ["history truncation"],
  "verification": ["pnpm test"],
  "questions": ["Need UI?"]
}
\`\`\``);

    expect(plan?.steps[0].id).toBe("step-1");
    expect(plan?.filesToInspect).toEqual(["packages/session/src/index.ts"]);
    expect(formatStructuredPlan(plan!)).toContain("## Verification");
  });

  it("rejects malformed plan shape", () => {
    expect(parseStructuredPlan('{"summary":"missing steps"}')).toBeUndefined();
    expect(parseStructuredPlan('{"summary":"x","steps":[{"description":"no title"}]}')).toBeUndefined();
  });

  it("parses review findings and drops invalid severities", () => {
    const review = parseStructuredReview(`Before:
{
  "findings": [
    { "severity": "high", "file": "a.ts", "message": "Bug", "suggestion": "Fix it" },
    { "severity": "critical", "message": "Unsupported severity" }
  ],
  "verificationGaps": ["missing test"],
  "summary": "One issue"
}
After`);

    expect(review?.findings).toHaveLength(1);
    expect(review?.findings[0].severity).toBe("high");
    expect(formatStructuredReview(review!)).toContain("[high] a.ts: Bug");
  });

  it("supports no-finding reviews", () => {
    const review = parseStructuredReview(
      '{"findings":[],"verificationGaps":[],"summary":"No issues"}',
    );

    expect(review?.findings).toEqual([]);
    expect(formatStructuredReview(review!)).toContain("No issues found");
  });
});
