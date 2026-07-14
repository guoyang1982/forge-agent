import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, RunRequest, RunResult, RuntimeModelListResult } from "@forge/protocol";
import { expandRunPromptText } from "./acp-prompt.js";
import {
  buildClaudeApprovalSummary,
  createExternalRuntimePermissionBridge,
} from "./external-runtime-permission.js";
import { emitRuntimeActivity } from "./external-runtime-events.js";

interface ClaudeRuntimeOptions {
  cwd: string;
  sessionId: string;
  request: RunRequest;
  priorHistory?: string;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
}

interface ClaudeStreamState {
  sawPartialStream: boolean;
  toolNamesByCallId: Map<string, string>;
  startedToolIds: Set<string>;
  streamedThinking: boolean;
}

function createClaudeStreamState(): ClaudeStreamState {
  return {
    sawPartialStream: false,
    toolNamesByCallId: new Map(),
    startedToolIds: new Set(),
    streamedThinking: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const next = value[key];
    if (typeof next === "string" && next.length > 0) return next;
  }
  return null;
}

function emitStatus(options: ClaudeRuntimeOptions, message: string): void {
  options.emit({ type: "status", sessionId: options.sessionId, phase: "model", message });
}

function toClaudeModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const normalized = model.toLowerCase();
  if (normalized === "opus" || normalized === "sonnet" || normalized === "haiku") {
    return normalized;
  }
  return model;
}

function toClaudePermissionMode(mode: string | undefined): string | undefined {
  switch (mode) {
    case "accept-edits":
      return "acceptEdits";
    case "bypass-permissions":
      return "bypassPermissions";
    case "dont-ask":
      return "dontAsk";
    case "auto":
    case "acceptEdits":
    case "bypassPermissions":
    case "default":
    case "dontAsk":
    case "plan":
      return mode;
    default:
      return undefined;
  }
}

function usesClaudeStdioPermissions(request: RunRequest): boolean {
  const mode = toClaudePermissionMode(request.runtime?.permissionMode);
  return !mode || mode === "default" || mode === "plan";
}

function buildClaudeArgs(request: RunRequest, priorHistory?: string): string[] {
  const runtime = request.runtime;
  const shared = [
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
  ];
  const model = toClaudeModel(runtime?.model);
  const permissionMode = toClaudePermissionMode(runtime?.permissionMode);

  if (usesClaudeStdioPermissions(request)) {
    const args = [
      "--print",
      ...shared,
      "--input-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
    ];
    if (model) args.push("--model", model);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (runtime?.effort) args.push("--effort", runtime.effort);
    return args;
  }

  const args = ["-p", ...shared];
  if (model) args.push("--model", model);
  if (permissionMode) args.push("--permission-mode", permissionMode);
  if (runtime?.effort) args.push("--effort", runtime.effort);
  args.push(expandRunPromptText(request, { priorHistory }));
  return args;
}

function buildClaudeUserMessage(request: RunRequest, priorHistory?: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: expandRunPromptText(request, { priorHistory }),
    },
    parent_tool_use_id: null,
  });
}

function buildClaudeControlResponse(
  requestId: string,
  toolUseId: string | undefined,
  allow: boolean,
): string {
  return JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: allow
        ? {
            behavior: "allow",
            ...(toolUseId ? { toolUseID: toolUseId } : {}),
          }
        : {
            behavior: "deny",
            message: "User denied tool execution",
          },
    },
  });
}

function appendAssistantMessage(
  options: ClaudeRuntimeOptions,
  finalText: { value: string },
  text: string,
): void {
  if (!text) return;
  finalText.value += text;
  options.emit({ type: "text_delta", sessionId: options.sessionId, delta: text });
}

function appendThinkingDelta(options: ClaudeRuntimeOptions, delta: string): void {
  if (!delta) return;
  options.emit({ type: "thinking_delta", sessionId: options.sessionId, delta });
}

function emitClaudeToolStart(
  options: ClaudeRuntimeOptions,
  state: ClaudeStreamState,
  callId: string | undefined,
  name: string,
  args: unknown,
): void {
  if (callId) {
    if (state.startedToolIds.has(callId)) return;
    state.startedToolIds.add(callId);
    state.toolNamesByCallId.set(callId, name);
  }
  emitRuntimeActivity(options.emit, options.sessionId, {
    runtime: "claude-code",
    activityKind: "tool",
    status: "running",
    callId,
    name,
    args: isRecord(args) ? args : {},
  });
}

function emitClaudeToolEnd(
  options: ClaudeRuntimeOptions,
  state: ClaudeStreamState,
  callId: string | undefined,
  result: string,
  fallbackName = "claude_tool",
): void {
  const name = (callId && state.toolNamesByCallId.get(callId)) || fallbackName;
  emitRuntimeActivity(options.emit, options.sessionId, {
    runtime: "claude-code",
    activityKind: "tool",
    status: "done",
    callId,
    name,
    result,
  });
}

function handleClaudeStreamEvent(
  value: Record<string, unknown>,
  options: ClaudeRuntimeOptions,
  finalText: { value: string },
  state: ClaudeStreamState,
): void {
  const event = isRecord(value.event) ? value.event : {};
  const eventType = readString(event, ["type"]);
  if (!eventType) return;
  state.sawPartialStream = true;

  if (eventType === "content_block_delta") {
    const delta = isRecord(event.delta) ? event.delta : {};
    const deltaType = readString(delta, ["type"]);
    if (deltaType === "text_delta") {
      appendAssistantMessage(options, finalText, readString(delta, ["text"]) ?? "");
      return;
    }
    if (deltaType === "thinking_delta") {
      state.streamedThinking = true;
      appendThinkingDelta(
        options,
        readString(delta, ["thinking"]) ?? readString(delta, ["text"]) ?? "",
      );
    }
    return;
  }

  if (eventType === "content_block_start") {
    const block = isRecord(event.content_block) ? event.content_block : {};
    if (readString(block, ["type"]) !== "tool_use") return;
    emitClaudeToolStart(
      options,
      state,
      readString(block, ["id"]) ?? undefined,
      readString(block, ["name"]) ?? "claude_tool",
      block.input ?? {},
    );
  }
}

function handleClaudeControlRequest(
  value: Record<string, unknown>,
  options: ClaudeRuntimeOptions,
  permissionBridge: ReturnType<typeof createExternalRuntimePermissionBridge>,
  child: ChildProcessWithoutNullStreams,
): void {
  const requestId = readString(value, ["request_id", "requestId"]);
  const request = isRecord(value.request) ? value.request : {};
  const subtype = readString(request, ["subtype"]);
  if (subtype !== "can_use_tool") return;

  const toolUseId = readString(request, ["tool_use_id", "toolUseId"]) ?? undefined;
  const summary = buildClaudeApprovalSummary(request);

  void permissionBridge
    .requestDecision(summary, request)
    .then((optionId) => {
      const allow = optionId !== "deny" && optionId !== "cancel";
      if (!child.stdin.writable || child.killed) return;
      child.stdin.write(
        `${buildClaudeControlResponse(requestId ?? "", toolUseId, allow)}\n`,
      );
    })
    .catch(() => {
      if (!child.stdin.writable || child.killed) return;
      child.stdin.write(
        `${buildClaudeControlResponse(requestId ?? "", toolUseId, false)}\n`,
      );
    });
}

function handleClaudeMessage(
  value: unknown,
  options: ClaudeRuntimeOptions,
  finalText: { value: string },
  state: ClaudeStreamState,
  permissionBridge?: ReturnType<typeof createExternalRuntimePermissionBridge>,
  child?: ChildProcessWithoutNullStreams,
): void {
  if (!isRecord(value)) return;
  const type = readString(value, ["type"]);
  if (type === "control_request" || type === "sdk_control_request") {
    if (permissionBridge && child) {
      handleClaudeControlRequest(value, options, permissionBridge, child);
    }
    return;
  }
  if (type === "stream_event") {
    handleClaudeStreamEvent(value, options, finalText, state);
    return;
  }
  if (type === "system") {
    const subtype = readString(value, ["subtype"]);
    if (subtype === "init") {
      const model = readString(value, ["model"]);
      emitStatus(options, model ? `Claude Code 初始化完成 · ${model}` : "Claude Code 初始化完成");
    } else if (subtype === "status") {
      const status = readString(value, ["status"]);
      if (status) emitStatus(options, `Claude Code: ${status}`);
    } else if (subtype === "api_retry") {
      const attempt = typeof value.attempt === "number" ? `第 ${value.attempt} 次` : "";
      const error = readString(value, ["error"]) ?? "API 请求失败";
      emitStatus(options, `Claude Code API 重试中${attempt ? `（${attempt}）` : ""}: ${error}`);
    } else if (subtype === "error") {
      const error = readString(value, ["error", "message"]) ?? "运行失败";
      options.emit({ type: "warning", sessionId: options.sessionId, message: `Claude Code: ${error}` });
    }
    return;
  }

  if (type === "assistant") {
    const message = isRecord(value.message) ? value.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      const itemType = readString(item, ["type"]);
      if (itemType === "text") {
        if (!state.sawPartialStream) {
          appendAssistantMessage(options, finalText, readString(item, ["text"]) ?? "");
        }
      } else if (itemType === "tool_use") {
        emitClaudeToolStart(
          options,
          state,
          readString(item, ["id"]) ?? undefined,
          readString(item, ["name"]) ?? "claude_tool",
          item.input ?? {},
        );
      } else if (itemType === "tool_result") {
        const toolUseId = readString(item, ["tool_use_id", "toolUseId"]) ?? undefined;
        const content = readString(item, ["content", "text"]) ?? "";
        emitClaudeToolEnd(options, state, toolUseId, content);
      } else if (itemType === "thinking" && !state.streamedThinking) {
        appendThinkingDelta(
          options,
          readString(item, ["thinking", "text"]) ?? "",
        );
      }
    }
    return;
  }

  if (type === "result") {
    const result = readString(value, ["result"]);
    if (!finalText.value && result) appendAssistantMessage(options, finalText, result);
    if (value.is_error === true) {
      options.emit({
        type: "warning",
        sessionId: options.sessionId,
        message: `Claude Code: ${result ?? "运行失败"}`,
      });
    }
  }
}

export function listClaudeModels(): RuntimeModelListResult {
  return {
    models: [
      { id: "sonnet", model: "sonnet", displayName: "Sonnet", isDefault: true },
      { id: "opus", model: "opus", displayName: "Opus" },
      { id: "haiku", model: "haiku", displayName: "Haiku" },
    ],
  };
}

export async function runClaudeRuntime(options: ClaudeRuntimeOptions): Promise<RunResult> {
  const args = buildClaudeArgs(options.request, options.priorHistory);
  const useStdioPermissions = usesClaudeStdioPermissions(options.request);
  emitStatus(options, "Claude Code turn 启动中…");
  const child = spawn("claude", args, {
    cwd: options.cwd,
    env: process.env,
    stdio: useStdioPermissions ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams | ChildProcess;
  const pipedChild = useStdioPermissions
    ? (child as ChildProcessWithoutNullStreams)
    : null;
  const finalText = { value: "" };
  const streamState = createClaudeStreamState();
  let stderr = "";
  let sawResult = false;
  const permissionBridge = useStdioPermissions
    ? createExternalRuntimePermissionBridge({
        emit: options.emit,
        sessionId: options.sessionId,
        signal: options.signal,
        kind: "claude-code",
        providerLabel: "Claude Code",
      })
    : undefined;

  if (pipedChild?.stdin.writable) {
    pipedChild.stdin.write(`${buildClaudeUserMessage(options.request, options.priorHistory)}\n`);
    pipedChild.stdin.end();
  }

  const abort = () => {
    emitStatus(options, "Claude Code 正在停止…");
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    if (!child.stdout) throw new Error("Claude Code stdout is not available");
    const lines = createInterface({ input: child.stdout });
    const done = new Promise<void>((resolve, reject) => {
      child.once("error", (cause) => {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        const trimmed = text.trim();
        if (trimmed) emitStatus(options, `Claude Code: ${trimmed}`);
      });
      lines.on("line", (line) => {
        try {
          const parsed = JSON.parse(line);
          if (isRecord(parsed) && parsed.type === "result") sawResult = true;
          handleClaudeMessage(
            parsed,
            options,
            finalText,
            streamState,
            permissionBridge,
            pipedChild ?? undefined,
          );
        } catch {
          appendAssistantMessage(options, finalText, line);
        }
      });
      child.once("exit", (code, signal) => {
        if (code === 0 || sawResult) {
          resolve();
          return;
        }
        reject(new Error(`Claude Code exited (${signal ?? code ?? "unknown"}): ${stderr.trim()}`));
      });
    });
    await done;
    return { sessionId: options.sessionId, finalText: finalText.value };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (!child.killed) child.kill("SIGTERM");
  }
}
