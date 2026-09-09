import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentEvent,
  ForgeConfig,
  RunRequest,
  RunResult,
  RuntimeModelListResult,
  RuntimeModelSummary,
} from "@forge/protocol";
import { loadConfig } from "@forge/config";
import { expandRunPromptText } from "./acp-prompt.js";
import {
  buildClaudeApprovalSummary,
  createExternalRuntimePermissionBridge,
} from "./external-runtime-permission.js";
import {
  emitRuntimeActivity,
  type RuntimeActivityPayload,
} from "./external-runtime-events.js";

export interface ClaudeRuntimeOptions {
  cwd: string;
  sessionId: string;
  request: RunRequest;
  priorHistory?: string;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
}

interface ClaudeToolCall {
  name: string;
  args: Record<string, unknown>;
  inputJson: string;
}

export interface ClaudeStreamState {
  sawPartialStream: boolean;
  streamedThinking: boolean;
  toolsByCallId: Map<string, ClaudeToolCall>;
  callIdByBlockIndex: Map<number, string>;
}

export function createClaudeStreamState(): ClaudeStreamState {
  return {
    sawPartialStream: false,
    streamedThinking: false,
    toolsByCallId: new Map(),
    callIdByBlockIndex: new Map(),
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

export function resolveClaudeRuntimePermissionMode(request: RunRequest): string | undefined {
  const explicit = toClaudePermissionMode(request.runtime?.permissionMode);
  if (explicit) return explicit;
  if (request.automationRun) return "bypassPermissions";
  return undefined;
}

function usesClaudeStdioPermissions(request: RunRequest): boolean {
  const mode = resolveClaudeRuntimePermissionMode(request);
  return !mode || mode === "default" || mode === "plan";
}

export function claudeStdioKeepsStdinOpen(request: RunRequest): boolean {
  return usesClaudeStdioPermissions(request);
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
  const permissionMode = resolveClaudeRuntimePermissionMode(request);

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

function compactClaudeToolName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

function claudeActivityKind(name: string): RuntimeActivityPayload["activityKind"] {
  const n = compactClaudeToolName(name);
  if (
    n === "write" ||
    n === "edit" ||
    n === "notebookedit" ||
    n === "strreplace" ||
    n === "writefile" ||
    n === "createfile"
  ) {
    return "file";
  }
  if (n === "read" || n === "readfile") return "read";
  if (n === "grep" || n === "glob" || n === "websearch" || n === "webfetch" || n === "task" || n === "search") {
    return "search";
  }
  if (n === "bash" || n === "shell" || n === "command") return "command";
  return "tool";
}

function extractClaudeToolPath(args: Record<string, unknown>): string | undefined {
  return readString(args, ["file_path", "filePath", "path", "target_file", "notebook_path"]) ?? undefined;
}

function basenamePath(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function contentLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.endsWith("\n") ? content.slice(0, -1) : content;
  return normalized ? normalized.split("\n") : [];
}

function claudeToolLabel(
  name: string,
  args: Record<string, unknown>,
  status: "running" | "done",
  path?: string,
): string {
  const done = status === "done";
  const kind = claudeActivityKind(name);
  const file = path ? basenamePath(path) : "";
  const command = readString(args, ["command", "cmd"]);
  if (kind === "file") return `${done ? "已编辑" : "正在编辑"}${file ? ` ${file}` : "文件"}`;
  if (kind === "read") return `${done ? "已读取" : "正在读取"}${file ? ` ${file}` : ""}`.trim();
  if (kind === "search") return done ? "已搜索" : "正在搜索";
  if (kind === "command") return `${done ? "已运行" : "正在运行"}${command ? ` ${command}` : ""}`;
  return `${done ? "已调用" : "正在调用"} ${name}`;
}

function buildClaudeFilePatch(
  name: string,
  args: Record<string, unknown>,
): {
  path: string;
  unifiedDiff: string;
  adds: number;
  dels: number;
  kind: "add" | "update";
} | null {
  const path = extractClaudeToolPath(args);
  if (!path) return null;
  const compact = compactClaudeToolName(name);
  const content = readString(args, ["content"]);
  if (content && (compact === "write" || compact === "writefile" || compact === "createfile")) {
    const lines = contentLines(content);
    const unifiedDiff = [
      "--- /dev/null",
      `+++ ${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
    return { path, unifiedDiff, adds: lines.length, dels: 0, kind: "add" };
  }
  const oldString =
    typeof args.old_string === "string"
      ? args.old_string
      : typeof args.oldString === "string"
        ? args.oldString
        : null;
  const newString =
    typeof args.new_string === "string"
      ? args.new_string
      : typeof args.newString === "string"
        ? args.newString
        : null;
  if (oldString != null && newString != null) {
    const oldLines = contentLines(oldString);
    const newLines = contentLines(newString);
    const unifiedDiff = [
      `--- ${path}`,
      `+++ ${path}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    ].join("\n");
    return {
      path,
      unifiedDiff,
      adds: newLines.length,
      dels: oldLines.length,
      kind: "update",
    };
  }
  return null;
}

function readToolResultContent(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (isRecord(block)) return readString(block, ["text", "content"]) ?? "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return readString(item, ["text"]) ?? "";
}

function upsertClaudeTool(state: ClaudeStreamState, callId: string, name: string): ClaudeToolCall {
  const existing = state.toolsByCallId.get(callId);
  if (existing) {
    if (name && name !== "claude_tool") existing.name = name;
    return existing;
  }
  const tool: ClaudeToolCall = { name: name || "claude_tool", args: {}, inputJson: "" };
  state.toolsByCallId.set(callId, tool);
  return tool;
}

function mergeClaudeToolArgs(tool: ClaudeToolCall, input: unknown): void {
  if (!isRecord(input)) return;
  tool.args = { ...tool.args, ...input };
}

function flushClaudeToolInput(tool: ClaudeToolCall): void {
  const raw = tool.inputJson.trim();
  if (!raw) return;
  try {
    mergeClaudeToolArgs(tool, JSON.parse(raw) as unknown);
  } catch {
    /* partial JSON still streaming */
  }
}

function emitClaudeToolActivity(
  options: ClaudeRuntimeOptions,
  tool: ClaudeToolCall,
  callId: string,
  status: "running" | "done" | "failed",
  result?: string,
): void {
  const args = tool.args;
  const path = extractClaudeToolPath(args);
  const kind = claudeActivityKind(tool.name);
  const patch = kind === "file" ? buildClaudeFilePatch(tool.name, args) : null;
  const payload: RuntimeActivityPayload = {
    runtime: "claude-code",
    activityKind: kind,
    status,
    callId,
    name: tool.name,
    args,
    label: claudeToolLabel(tool.name, args, status === "running" ? "running" : "done", path),
  };
  if (result !== undefined) payload.result = result;
  if (path) payload.path = path;
  if (patch) {
    payload.patch = { path: patch.path, unifiedDiff: patch.unifiedDiff };
    payload.adds = patch.adds;
    payload.dels = patch.dels;
    payload.changes = [
      {
        path: patch.path,
        kind: patch.kind,
        unifiedDiff: patch.unifiedDiff,
        adds: patch.adds,
        dels: patch.dels,
      },
    ];
  }
  emitRuntimeActivity(options.emit, options.sessionId, payload);
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
  const blockIndex = typeof event.index === "number" ? event.index : null;

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
      return;
    }
    if (deltaType === "input_json_delta") {
      const callId = blockIndex != null ? state.callIdByBlockIndex.get(blockIndex) : undefined;
      if (!callId) return;
      const tool = state.toolsByCallId.get(callId);
      if (!tool) return;
      tool.inputJson += readString(delta, ["partial_json", "text"]) ?? "";
    }
    return;
  }

  if (eventType === "content_block_start") {
    const block = isRecord(event.content_block) ? event.content_block : {};
    if (readString(block, ["type"]) !== "tool_use") return;
    const callId = readString(block, ["id"]);
    if (!callId) return;
    const tool = upsertClaudeTool(state, callId, readString(block, ["name"]) ?? "claude_tool");
    mergeClaudeToolArgs(tool, block.input);
    if (blockIndex != null) state.callIdByBlockIndex.set(blockIndex, callId);
    emitClaudeToolActivity(options, tool, callId, "running");
    return;
  }

  if (eventType === "content_block_stop") {
    const callId = blockIndex != null ? state.callIdByBlockIndex.get(blockIndex) : undefined;
    if (!callId) return;
    const tool = state.toolsByCallId.get(callId);
    if (!tool) return;
    flushClaudeToolInput(tool);
    emitClaudeToolActivity(options, tool, callId, "running");
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
  const writeResponse = (allow: boolean, toolUseId?: string) => {
    if (!requestId || !child.stdin.writable || child.killed) return;
    child.stdin.write(`${buildClaudeControlResponse(requestId, toolUseId, allow)}\n`);
  };

  if (subtype !== "can_use_tool") {
    writeResponse(true);
    return;
  }

  const toolUseId = readString(request, ["tool_use_id", "toolUseId"]) ?? undefined;
  if (options.request.automationRun) {
    writeResponse(true, toolUseId);
    return;
  }

  const summary = buildClaudeApprovalSummary(request);

  void permissionBridge
    .requestDecision(summary, request)
    .then((optionId) => {
      writeResponse(optionId !== "deny" && optionId !== "cancel", toolUseId);
    })
    .catch(() => {
      writeResponse(false, toolUseId);
    });
}

function handleClaudeToolResult(
  options: ClaudeRuntimeOptions,
  state: ClaudeStreamState,
  item: Record<string, unknown>,
): void {
  const toolUseId = readString(item, ["tool_use_id", "toolUseId"]);
  if (!toolUseId) return;
  const tool = upsertClaudeTool(state, toolUseId, "claude_tool");
  const failed = item.is_error === true;
  emitClaudeToolActivity(
    options,
    tool,
    toolUseId,
    failed ? "failed" : "done",
    readToolResultContent(item),
  );
}

export function applyClaudeNdjsonMessage(
  value: unknown,
  options: ClaudeRuntimeOptions,
  finalText: { value: string },
  state: ClaudeStreamState,
  permissionBridge?: ReturnType<typeof createExternalRuntimePermissionBridge>,
  child?: ChildProcessWithoutNullStreams,
): void {
  if (!isRecord(value)) return;
  const type = readString(value, ["type"]);
  const nestedEvent = isRecord(value.event) ? value.event : null;
  const nestedType = nestedEvent ? readString(nestedEvent, ["type"]) : null;
  if (
    type === "control_request" ||
    type === "sdk_control_request" ||
    nestedType === "control_request" ||
    nestedType === "sdk_control_request"
  ) {
    if (permissionBridge && child) {
      handleClaudeControlRequest(
        nestedType === "control_request" || nestedType === "sdk_control_request"
          ? nestedEvent!
          : value,
        options,
        permissionBridge,
        child,
      );
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

  if (type === "user") {
    const message = isRecord(value.message) ? value.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (readString(item, ["type"]) === "tool_result") handleClaudeToolResult(options, state, item);
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
        const callId = readString(item, ["id"]);
        if (!callId) continue;
        const tool = upsertClaudeTool(state, callId, readString(item, ["name"]) ?? "claude_tool");
        mergeClaudeToolArgs(tool, item.input);
        emitClaudeToolActivity(options, tool, callId, "running");
      } else if (itemType === "tool_result") {
        handleClaudeToolResult(options, state, item);
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

const CLAUDE_ALIAS_MODELS: RuntimeModelSummary[] = [
  { id: "sonnet", model: "sonnet", displayName: "Sonnet" },
  { id: "opus", model: "opus", displayName: "Opus" },
  { id: "haiku", model: "haiku", displayName: "Haiku" },
];

export interface ClaudeRuntimeResolveOptions {
  claudeSettingsPath?: string;
}

export function buildClaudeProcessEnv(
  _cfg: ForgeConfig = loadConfig(),
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: ClaudeRuntimeResolveOptions = {},
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...resolveClaudeCodeRuntime(options).env,
  };
}

export function listClaudeModels(
  _cfg: ForgeConfig = loadConfig(),
  options: ClaudeRuntimeResolveOptions = {},
): RuntimeModelListResult {
  const resolved = resolveClaudeCodeRuntime(options);
  const models: RuntimeModelSummary[] = [];
  const seen = new Set<string>();
  const push = (entry: RuntimeModelSummary) => {
    const model = entry.model.trim();
    if (!model || seen.has(model)) return;
    seen.add(model);
    models.push({ ...entry, model, id: entry.id || model });
  };

  for (const item of resolved.models) push(item);
  for (const item of CLAUDE_ALIAS_MODELS) push(item);
  if (models.length && !models.some((item) => item.isDefault)) {
    models[0]!.isDefault = true;
  }
  return { models };
}

function defaultClaudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function readClaudeUserSettingsEnv(filePath = defaultClaudeSettingsPath()): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
      env?: Record<string, unknown>;
    };
    const env = raw?.env;
    if (!env || typeof env !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string" && value.trim()) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function resolveClaudeCodeRuntime(
  options: ClaudeRuntimeResolveOptions = {},
): {
  env: Record<string, string>;
  models: RuntimeModelSummary[];
} {
  const env = readClaudeUserSettingsEnv(options.claudeSettingsPath);
  const models: RuntimeModelSummary[] = [];
  const defaultModel = env.ANTHROPIC_MODEL?.trim();
  if (defaultModel) {
    models.push({
      id: defaultModel,
      model: defaultModel,
      displayName: defaultModel,
      isDefault: true,
    });
  }
  return { env, models };
}

export async function runClaudeRuntime(options: ClaudeRuntimeOptions): Promise<RunResult> {
  const args = buildClaudeArgs(options.request, options.priorHistory);
  const useStdioPermissions = usesClaudeStdioPermissions(options.request);
  emitStatus(options, "Claude Code turn 启动中…");
  const child = spawn("claude", args, {
    cwd: options.cwd,
    env: buildClaudeProcessEnv(),
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
          applyClaudeNdjsonMessage(
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
    if (pipedChild?.stdin.writable) pipedChild.stdin.end();
    if (!child.killed) child.kill("SIGTERM");
  }
}
