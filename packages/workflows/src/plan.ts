import type { PlanResult } from "./types.js";

export interface CreatePlanInput {
  goal: string;
  cwd: string;
  context?: string;
}

export function createPlanSkeleton(input: CreatePlanInput): PlanResult {
  return {
    summary: input.goal,
    steps: [
      {
        id: "inspect",
        title: "Read relevant context",
        description: `Inspect project files under ${input.cwd}`,
      },
      {
        id: "design",
        title: "Design the change",
        description: "Identify files, risks, and verification path",
      },
      {
        id: "execute",
        title: "Implement after confirmation",
      },
    ],
    filesToInspect: [],
    risks: [],
    verification: [],
  };
}

export function buildPlanPrompt(input: CreatePlanInput): string {
  return `You are Forge in planning mode.

Goal:
${input.goal}

Workspace:
${input.cwd}

Context:
${input.context || "(no extra context)"}

Rules:
- Do not propose file edits as already done.
- Do not call tools or assume implementation has happened.
- Produce a concise, actionable implementation plan.
- Include files to inspect/change, risks, questions, and verification commands.
- If requirements are ambiguous, ask focused questions.

Output format:
Return valid JSON only. Do not wrap it in Markdown.
Shape:
{
  "summary": "short summary",
  "steps": [
    { "id": "inspect", "title": "Inspect context", "description": "..." }
  ],
  "filesToInspect": ["path"],
  "risks": ["risk"],
  "verification": ["command or check"],
  "questions": ["question"]
}

If you cannot produce JSON, use this fallback Markdown structure:
## Plan
<short summary>

## Steps
1. ...

## Files
- ...

## Risks / Questions
- ...

## Verification
- ...
`;
}
