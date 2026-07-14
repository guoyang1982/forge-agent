import type { ReviewResult } from "./types.js";

export interface ReviewInput {
  diff?: string;
  files?: string[];
}

export function createEmptyReview(input: ReviewInput = {}): ReviewResult {
  const scope = input.files?.length
    ? `files: ${input.files.join(", ")}`
    : "current changes";
  return {
    findings: [],
    summary: `No findings produced yet for ${scope}.`,
  };
}

export function buildReviewPrompt(input: ReviewInput): string {
  return `You are Forge in code review mode.

Review target:
${input.files?.length ? input.files.join(", ") : "current git diff"}

Diff:
${input.diff || "(no diff)"}

Instructions:
- Prioritize real bugs, regressions, missing verification, and safety issues.
- Findings first, ordered by severity.
- Cite files when possible.
- Do not praise or summarize before findings.
- If no issues are found, say so clearly and mention residual risk.

Output format:
Return valid JSON only. Do not wrap it in Markdown.
Shape:
{
  "findings": [
    { "severity": "high", "file": "path", "message": "issue and impact", "suggestion": "fix" }
  ],
  "verificationGaps": ["missing test or command"],
  "summary": "short summary",
  "residualRisk": "remaining risk"
}

If no issues are found, return an empty findings array.

Fallback Markdown structure:
## Findings
- [severity] file: issue and impact

## Verification Gaps
- ...

## Summary
...
`;
}
