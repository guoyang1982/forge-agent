import type { GenerateAgentsOptions } from "./types.js";

export function generateAgentsMd(options: GenerateAgentsOptions): string {
  const run = options.runCommands?.length
    ? options.runCommands.map((c) => `- \`${c}\``).join("\n")
    : "- Fill in the project run command.";
  const test = options.testCommands?.length
    ? options.testCommands.map((c) => `- \`${c}\``).join("\n")
    : "- Fill in the project test command.";
  const conventions = options.conventions?.length
    ? options.conventions.map((c) => `- ${c}`).join("\n")
    : "- Keep changes focused and verify behavior.";

  return `# AGENTS.md

## Project
${options.projectName}

## Run
${run}

## Test
${test}

## Conventions
${conventions}

## Done Criteria
- Relevant code changes are applied.
- Relevant tests or run commands are executed when available.
- The final response lists verification and remaining risks.
`;
}
