import type {
  AgentEvent,
  ChatMessage,
  CompactSessionRequest,
  CompactSessionResult,
} from "@forge/protocol";
import { loadConfig } from "@forge/config";
import { LlmClient } from "@forge/llm";
import { runPreCompactHooks } from "@forge/hooks";
import type { SessionStore } from "@forge/session";
import { hookSessionState } from "@forge/hooks";
import { resolveProjectHooks, type ForgeRuntime } from "../runtime.js";
import { releaseAcpForgeSession } from "./runtime-service.js";

export async function handleCompactSession(
  params: unknown,
  emit: (event: AgentEvent) => void,
  deps: {
    sessions: SessionStore;
    getRuntime: () => Promise<ForgeRuntime>;
  },
): Promise<CompactSessionResult> {
  const req = params as CompactSessionRequest;
  const keepLast = req.keepLast ?? 12;
  const pack = deps.sessions.loadMessagesForCompaction(req.sessionId, keepLast);

  if (!pack.toSummarize.length) {
    return {
      sessionId: req.sessionId,
      keptMessages: pack.kept.length,
      summarizedMessages: 0,
      mode: "local",
      summaryPreview: "",
    };
  }

  const cwd = deps.sessions.getSessionCwd(req.sessionId) ?? process.cwd();
  const config = loadConfig({ cwd });
  hookSessionState.touchSession(req.sessionId);

  const runtime = await deps.getRuntime();
  const { bindings, skills } = await resolveProjectHooks(cwd, runtime);
  const preCompact = await runPreCompactHooks({
    bindings,
    ctx: {
      cwd,
      sessionId: req.sessionId,
      message: "",
      source: "compact",
    },
    skills,
    messagesToSummarize: pack.toSummarize.length,
    keepLast,
  });
  if (preCompact.blocked) {
    emit({
      type: "warning",
      message:
        preCompact.blockReason ?? "PreCompact hook blocked session compression",
    });
    return {
      sessionId: req.sessionId,
      keptMessages: pack.kept.length,
      summarizedMessages: 0,
      mode: "local",
      summaryPreview: "",
      blocked: true,
    };
  }

  let mode: CompactSessionResult["mode"] = "model";
  let summary = "";

  if (config.model.apiKey) {
    try {
      emit({ type: "status", phase: "model", message: "正在智能压缩会话…" });
      const llm = new LlmClient(config.model);
      const result = await llm.chat({
        tools: [],
        messages: [
          {
            role: "user",
            content: buildCompactPrompt(pack.toSummarize),
          },
        ],
      });
      summary = result.text?.trim() ?? "";
    } catch (e) {
      mode = "local";
      emit({
        type: "warning",
        message: `模型摘要失败，改用本地压缩：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  } else {
    mode = "local";
  }

  if (!summary) {
    summary = buildLocalCompactSummary(pack.toSummarize);
  }

  const result = deps.sessions.compactSessionWithSummary(
    req.sessionId,
    summary,
    keepLast,
  );
  hookSessionState.setPendingHookSource(req.sessionId, "compact");
  void releaseAcpForgeSession(req.sessionId).catch(() => {});

  return {
    sessionId: req.sessionId,
    keptMessages: result.keptMessages,
    summarizedMessages: result.summarizedMessages,
    mode,
    summaryPreview: result.summaryPreview ?? "",
  };
}

function buildCompactPrompt(messages: ChatMessage[]): string {
  return `Summarize the following Forge agent conversation history for future continuation.

Preserve:
- User goals and constraints
- Key decisions
- Files changed or discussed
- Current TODOs / pending work
- Commands/tests already run
- Important errors and fixes
- Residual risks

Write a concise but useful summary in the same language as the conversation.
Do not invent completed work.

Conversation:
${formatMessages(messages).slice(0, 24_000)}
`;
}

function buildLocalCompactSummary(messages: ChatMessage[]): string {
  return [
    "Conversation summary from compacted earlier turns.",
    "",
    formatMessages(messages).split("\n").slice(-40).join("\n").slice(0, 4000),
  ].join("\n");
}

function formatMessages(messages: ChatMessage[]): string {
  return messages
    .map((msg) => {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((p) =>
                  p.type === "text" ? p.text : p.type === "image_url" ? "[image]" : "",
                )
                .join(" ")
            : String(msg.content ?? "");
      return `${msg.role}: ${text.replace(/\s+/g, " ").trim()}`;
    })
    .filter((line) => !line.endsWith(": "))
    .join("\n");
}
