import type { AgentEvent, ReviewRequest, ReviewResult } from "@forge/protocol";
import { loadConfig } from "@forge/config";
import { LlmClient } from "@forge/llm";
import { WorkspaceGuard, gitDiffSummary, readFileLimited } from "@forge/workspace";
import {
  buildReviewPrompt,
  formatStructuredReview,
  parseStructuredReview,
} from "@forge/workflows";

export async function handleReview(
  params: unknown,
  emit: (event: AgentEvent) => void,
): Promise<ReviewResult> {
  const req = params as ReviewRequest;
  const cwd = req.cwd || process.cwd();
  const config = loadConfig({ cwd });
  const guard = await WorkspaceGuard.ensure(cwd, {
    allowedRoots: config.permissions?.fileSystem.allowedRoots,
  });

  emit({ type: "status", phase: "model", message: "正在审查改动…" });

  let diff = await gitDiffSummary(guard, 220);
  if (req.files?.length) {
    const snippets: string[] = [];
    for (const file of req.files.slice(0, 5)) {
      try {
        snippets.push(`## ${file}\n${await readFileLimited(guard, file, 1, 220)}`);
      } catch {
        snippets.push(`## ${file}\n(file not readable)`);
      }
    }
    diff += `\n\n## Selected files\n${snippets.join("\n\n")}`;
  }

  const llm = new LlmClient(config.model);
  try {
    const result = await llm.chat({
      messages: [
        {
          role: "user",
          content: buildReviewPrompt({
            diff,
            files: req.files,
          }),
        },
      ],
      tools: [],
    });

    const text = result.text ?? "";
    const structured = parseStructuredReview(text);
    return {
      text: structured ? formatStructuredReview(structured) : text,
      structured,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "error", message: msg });
    throw e;
  }
}
