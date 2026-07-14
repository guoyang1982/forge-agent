import type { AgentEvent, PlanRequest, PlanResult } from "@forge/protocol";
import { loadConfig } from "@forge/config";
import { buildAgentContext, formatContextForPrompt } from "@forge/context";
import { LlmClient } from "@forge/llm";
import { WorkspaceGuard } from "@forge/workspace";
import {
  buildPlanPrompt,
  formatStructuredPlan,
  parseStructuredPlan,
} from "@forge/workflows";

export async function handlePlan(
  params: unknown,
  emit: (event: AgentEvent) => void,
): Promise<PlanResult> {
  const req = params as PlanRequest;
  const cwd = req.cwd || process.cwd();
  const config = loadConfig({ cwd });
  const guard = await WorkspaceGuard.ensure(cwd, {
    allowedRoots: config.permissions?.fileSystem.allowedRoots,
  });

  emit({ type: "status", phase: "model", message: "正在生成计划…" });

  const ctx = await buildAgentContext({
    guard,
    userMessage: req.message,
    explicitFiles: req.files,
  });
  const formatted = formatContextForPrompt(ctx);
  const prompt = buildPlanPrompt({
    goal: req.message,
    cwd,
    context: [
      formatted.agentsMd ? `## Rules\n${formatted.agentsMd}` : "",
      `## Git\n${formatted.gitStatus}`,
      formatted.extraFiles,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  const llm = new LlmClient(config.model);
  try {
    const result = await llm.chat({
      messages: [{ role: "user", content: prompt }],
      tools: [],
    });

    const text = result.text ?? "";
    const structured = parseStructuredPlan(text);
    return {
      text: structured ? formatStructuredPlan(structured) : text,
      structured,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "error", message: msg });
    throw e;
  }
}
