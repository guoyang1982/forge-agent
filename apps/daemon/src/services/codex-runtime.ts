import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentEvent,
  RunRequest,
  RunResult,
  RuntimeModeSummary,
  RuntimeModelListResult,
  RuntimeModelSummary,
} from "@forge/protocol";
import { expandRunPromptText } from "./acp-prompt.js";
import {
  buildCodexApprovalSummary,
  createExternalRuntimePermissionBridge,
  defaultExternalPermissionOptions,
  mapCodexDecision,
} from "./external-runtime-permission.js";
import {
  buildCodexCommandChip,
  buildCodexFileChip,
  buildCodexMcpChip,
  codexReasoningText,
  emitCodexRuntimeActivityChip,
  emitTextDelta,
  emitThinkingDelta,
  isCodexChipItemType,
  isCodexToolItemType,
  normalizeCodexToolName,
} from "./external-runtime-events.js";

interface CodexRuntimeOptions {
  cwd: string;
  sessionId: string;
  request: RunRequest;
  priorHistory?: string;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc?: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

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

function extractTextDelta(message: JsonRpcNotification): string | null {
  const params = isRecord(message.params) ? message.params : {};
  return (
    readString(params, ["delta", "text", "chunk"]) ??
    readString(params.item, ["delta", "text", "content"]) ??
    readString(params.message, ["delta", "text", "content"])
  );
}

function readCodexItem(params: unknown): Record<string, unknown> {
  if (!isRecord(params)) return {};
  return isRecord(params.item) ? params.item : {};
}

function codexItemCallId(item: Record<string, unknown>): string | undefined {
  return (
    readString(item, ["id", "callId", "call_id"]) ??
    readString(item.toolCall, ["id", "callId", "call_id"]) ??
    undefined
  );
}

function codexItemToolName(item: Record<string, unknown>): string {
  const type = readString(item, ["type"]) ?? "codex_tool";
  const raw =
    readString(item, ["name", "toolName", "command"]) ??
    readString(item.toolCall, ["name", "toolName"]) ??
    type;
  return normalizeCodexToolName(raw, item);
}

function codexItemResultText(item: Record<string, unknown>): string {
  const text =
    readString(item, ["aggregatedOutput", "result", "output", "text", "content"]) ??
    readString(item.toolCall, ["aggregatedOutput", "result", "output", "text", "content"]);
  if (text) return text;
  try {
    return JSON.stringify(item);
  } catch {
    return "";
  }
}

interface CodexStreamState {
  itemPhaseById: Map<string, string>;
  activeReasoningId: string | null;
  activeChipItems: Map<string, Record<string, unknown>>;
}

function createCodexStreamState(): CodexStreamState {
  return { itemPhaseById: new Map(), activeReasoningId: null, activeChipItems: new Map() };
}

function emitCodexChipFromItem(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  item: Record<string, unknown>,
  running: boolean,
  lifecycle: {
    turnId?: string;
    startedAtMs?: number;
    completedAtMs?: number;
    durationMs?: number;
    emittedAtMs?: number;
  } = {},
): void {
  const type = readString(item, ["type"]) ?? "";
  if (type === "commandExecution") {
    emitCodexRuntimeActivityChip(emit, sessionId, buildCodexCommandChip(item, running));
    return;
  }
  if (type === "fileChange") {
    const chip = buildCodexFileChip(item, running);
    if (chip) emitCodexRuntimeActivityChip(emit, sessionId, { ...chip, ...lifecycle });
    return;
  }
  if (type === "mcpToolCall") {
    const chip = buildCodexMcpChip(item, running);
    if (chip) emitCodexRuntimeActivityChip(emit, sessionId, chip);
  }
}

function readCodexItemId(params: Record<string, unknown>): string | null {
  return readString(params, ["itemId"]) ?? readString(readCodexItem(params), ["id"]);
}

function isCodexSkillBudgetWarning(message: string): boolean {
  return /skills context budget/i.test(message);
}

function emitStatus(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  message: string,
): void {
  emit({ type: "status", sessionId, phase: "model", message });
}

/** Strip ANSI color codes so log lines can be matched/surfaced cleanly. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Codex CLI ↔ ChatGPT app version skew can leave ~/.codex/models_cache.json
 * missing fields the current binary expects. Those ERROR lines are noisy and
 * must not look like the live answer.
 */
export function isCodexModelsCacheStderr(text: string): boolean {
  const cleaned = stripAnsi(text);
  return (
    /codex_models_manager::(cache|manager)/i.test(cleaned)
    && /failed to (load models cache|renew cache TTL)|supports_reasoning_summaries/i.test(cleaned)
  );
}

export function shouldSurfaceCodexStderr(text: string): boolean {
  for (const line of text.split(/\n+/).map((x) => stripAnsi(x).trim()).filter(Boolean)) {
    if (isCodexModelsCacheStderr(line)) continue;
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed) && readString(parsed, ["level"]) === "WARN") continue;
      return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Best-effort repair when models_cache.json predates `supports_reasoning_summaries`.
 * Returns whether the file was rewritten.
 */
export function ensureCodexModelsCacheCompatible(
  cachePath = join(homedir(), ".codex", "models_cache.json"),
): { repaired: boolean; reason?: string } {
  try {
    const raw = readFileSync(cachePath, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (!isRecord(data) || !Array.isArray(data.models)) {
      return { repaired: false, reason: "unexpected models_cache shape" };
    }
    let changed = false;
    for (const entry of data.models) {
      if (!isRecord(entry) || "supports_reasoning_summaries" in entry) continue;
      entry.supports_reasoning_summaries = Boolean(
        entry.default_reasoning_summary != null
          || (Array.isArray(entry.supported_reasoning_levels)
            && entry.supported_reasoning_levels.length > 0),
      );
      changed = true;
    }
    if (!changed) return { repaired: false };
    writeFileSync(cachePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return { repaired: true };
  } catch (cause) {
    return {
      repaired: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** True when Codex reports the thread returned to idle after a turn. */
export function isCodexThreadIdleNotification(message: {
  method: string;
  params?: unknown;
}): boolean {
  if (!message.method.includes("thread/status/changed")) return false;
  const params = isRecord(message.params) ? message.params : {};
  const status = params.status;
  if (typeof status === "string") return status === "idle";
  if (isRecord(status)) return status.type === "idle";
  return false;
}

/**
 * Codex app-server (0.144+) often omits `turn/completed` and only flips the
 * thread to idle. Treat idle-after-armed as a successful terminal signal.
 */
export function classifyCodexTurnNotification(
  message: { method: string; params?: unknown },
  turnArmed: boolean,
): "started" | "completed" | "failed" | "canceled" | "idle" | null {
  if (message.method.includes("turn/started")) return "started";
  if (message.method.includes("turn/completed")) return "completed";
  if (message.method.includes("turn/failed")) return "failed";
  if (message.method.includes("turn/canceled") || message.method.includes("turn/cancelled")) {
    return "canceled";
  }
  if (turnArmed && isCodexThreadIdleNotification(message)) return "idle";
  return null;
}

function getResponseId(message: JsonRpcMessage): number | null {
  return "id" in message && typeof message.id === "number" ? message.id : null;
}

class CodexJsonRpcClient {
  private readonly requestTimeoutMs = 60_000;
  private nextId = 1;
  private pending = new Map<
    number,
    {
      method: string;
      timer: NodeJS.Timeout;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private notificationHandlers = new Set<(message: JsonRpcNotification) => void>();
  private serverRequestHandlers = new Set<
    (message: JsonRpcNotification & { id: number }) => void | Promise<void>
  >();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.once("error", (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${signal ?? code ?? "unknown"})`);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
  }

  onNotification(handler: (message: JsonRpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(
    handler: (message: JsonRpcNotification & { id: number }) => void | Promise<void>,
  ): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  respond(id: number, result: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, timer, resolve, reject });
      console.error(`[forge-codex] -> ${method}`);
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const message = parsed as unknown as JsonRpcMessage;
    const id = getResponseId(message);
    const method = "method" in message && typeof message.method === "string" ? message.method : null;
    const hasResult = "result" in message;
    const hasError = "error" in message;

    if (id != null && method && !hasResult && !hasError) {
      const serverRequest = message as JsonRpcNotification & { id: number };
      console.error(`[forge-codex] <- ${method} (server request)`);
      for (const handler of this.serverRequestHandlers) {
        void Promise.resolve(handler(serverRequest)).catch((cause) => {
          const error = cause instanceof Error ? cause.message : String(cause);
          console.error(`[forge-codex] server request handler failed: ${error}`);
          this.respond(id, { decision: "decline" });
        });
      }
      return;
    }

    if (id != null && (hasResult || hasError)) {
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      console.error(`[forge-codex] <- ${waiter.method}`);
      if (hasError && message.error) {
        waiter.reject(new Error(message.error.message));
      } else {
        waiter.resolve("result" in message ? message.result : undefined);
      }
      return;
    }

    if (method) {
      for (const handler of this.notificationHandlers) {
        handler(message as JsonRpcNotification);
      }
    }
  }
}

function codexOptionsFromParams(
  params: Record<string, unknown>,
): ReturnType<typeof defaultExternalPermissionOptions> {
  const available = params.availableDecisions;
  if (!Array.isArray(available)) return defaultExternalPermissionOptions("Codex");
  const options = available
    .map((item) => {
      const decision =
        typeof item === "string"
          ? item
          : isRecord(item)
            ? readString(item, ["decision", "id"])
            : null;
      if (!decision) return null;
      if (decision === "acceptForSession") {
        return { optionId: "allow-session", name: "本会话总是允许", kind: "allow_always" };
      }
      if (decision === "decline") {
        return { optionId: "deny", name: "拒绝", kind: "reject_once" };
      }
      if (decision === "cancel") {
        return { optionId: "cancel", name: "取消", kind: "reject_once" };
      }
      return { optionId: "allow-once", name: "允许一次", kind: "allow_once" };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return options.length ? options : defaultExternalPermissionOptions("Codex");
}

function isCodexApprovalMethod(method: string): boolean {
  return /requestApproval|Approval$/i.test(method);
}

function toCodexTextInput(text: string): Record<string, unknown> {
  return { type: "text", text, text_elements: [] };
}

const CODEX_APPROVAL_POLICIES = ["untrusted", "on-request", "granular", "never"] as const;
type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

const CODEX_MODES: RuntimeModeSummary[] = [
  { id: "on-request", label: "On Request", isDefault: true },
  { id: "untrusted", label: "Untrusted" },
  { id: "never", label: "Never" },
  { id: "granular", label: "Granular" },
];

export function listCodexModes(): RuntimeModeSummary[] {
  return CODEX_MODES;
}

/** Map mobile/desktop permissionMode values onto Codex approvalPolicy variants. */
export function normalizeCodexApprovalPolicy(value: unknown): CodexApprovalPolicy {
  if (typeof value === "string" && (CODEX_APPROVAL_POLICIES as readonly string[]).includes(value)) {
    return value as CodexApprovalPolicy;
  }
  // Cursor/Claude-style modes (default/plan/ask) must not be forwarded — Codex rejects them.
  return "on-request";
}

function toSandboxPolicy(type: string | undefined): Record<string, unknown> {
  switch (type) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write":
    default:
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

function buildTurnStartParams(options: CodexRuntimeOptions, threadId: string): Record<string, unknown> {
  const runtime = options.request.runtime;
  return {
    threadId,
    input: [toCodexTextInput(expandRunPromptText(options.request, { priorHistory: options.priorHistory }))],
    approvalPolicy: normalizeCodexApprovalPolicy(runtime?.permissionMode),
    sandboxPolicy: toSandboxPolicy(runtime?.sandboxMode ?? "workspace-write"),
    ...(runtime?.model ? { model: runtime.model } : {}),
    ...(runtime?.effort ? { effort: runtime.effort } : {}),
  };
}

function resolveThreadId(response: unknown): string {
  if (!isRecord(response)) throw new Error("Codex thread/start returned no result");
  const direct = readString(response, ["threadId", "thread_id", "id"]);
  if (direct) return direct;
  const nested = readString(response.thread, ["threadId", "thread_id", "id"]);
  if (nested) return nested;
  throw new Error("Codex thread/start returned no thread id");
}

function buildThreadStartParams(options: CodexRuntimeOptions): Record<string, unknown> {
  const runtime = options.request.runtime;
  return {
    cwd: options.cwd,
    ...(runtime?.model ? { model: runtime.model } : {}),
    approvalPolicy: normalizeCodexApprovalPolicy(runtime?.permissionMode),
    ...(runtime?.sandboxMode ? { sandbox: runtime.sandboxMode } : {}),
  };
}

async function withCodexRpc<T>(
  cwd: string,
  fn: (rpc: CodexJsonRpcClient) => Promise<T>,
): Promise<T> {
  const child = spawn("codex", ["app-server"], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = new CodexJsonRpcClient(child);
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) console.error(`[forge-codex:stderr] ${text}`);
  });
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "forge-agent", title: "Forge Agent", version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    rpc.notify("initialized");
    return await fn(rpc);
  } finally {
    child.kill("SIGTERM");
  }
}

function normalizeEffortOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item)) return readString(item, ["id", "value", "name"]);
      return null;
    })
    .filter((item): item is string => Boolean(item));
}

function normalizeCodexModel(value: unknown): RuntimeModelSummary | null {
  if (!isRecord(value)) return null;
  const id = readString(value, ["id"]) ?? readString(value, ["model"]);
  const model = readString(value, ["model"]) ?? id;
  if (!id || !model) return null;
  return {
    id,
    model,
    displayName: readString(value, ["displayName"]) ?? model,
    description: readString(value, ["description"]) ?? undefined,
    defaultReasoningEffort: readString(value, ["defaultReasoningEffort"]),
    supportedReasoningEfforts: normalizeEffortOptions(value.supportedReasoningEfforts),
    isDefault: value.isDefault === true,
  };
}

export async function listCodexModels(cwd: string): Promise<RuntimeModelListResult> {
  return withCodexRpc(cwd, async (rpc) => {
    const result = await rpc.request("model/list", { includeHidden: false });
    const data = isRecord(result) && Array.isArray(result.data) ? result.data : [];
    return { models: data.map(normalizeCodexModel).filter((m): m is RuntimeModelSummary => Boolean(m)) };
  });
}

function mapCodexItemDelta(
  message: JsonRpcNotification,
  emit: (event: AgentEvent) => void,
  sessionId: string,
  finalText: { value: string },
  streamAcc: { value: string },
  streamState: CodexStreamState,
): boolean {
  if (!message.method.includes("/delta")) return false;
  const params = isRecord(message.params) ? message.params : {};
  const item = readCodexItem(params);
  const type = readString(item, ["type"]) ?? codexDeltaItemType(message.method);
  const itemId = readCodexItemId(params);
  const phase = itemId ? streamState.itemPhaseById.get(itemId) : undefined;
  const delta = extractTextDelta(message) ?? codexReasoningText(item);

  if (type === "reasoning" || message.method.includes("reasoning")) {
    emitThinkingDelta(emit, sessionId, delta);
    return true;
  }

  if (isCodexChipItemType(type) || type === "mcpToolCall") {
    emitCodexChipFromItem(emit, sessionId, item, true);
    return true;
  }

  if (type === "agentMessage" || message.method.includes("agentMessage")) {
    if (phase === "commentary") {
      emitTextDelta(emit, sessionId, delta, streamAcc);
      return true;
    }
    emitTextDelta(emit, sessionId, delta, streamAcc, finalText);
    return true;
  }

  if (delta) emitTextDelta(emit, sessionId, delta, streamAcc);
  return true;
}

function codexDeltaItemType(method: string): string {
  const match = method.match(/item\/([^/]+)\/delta/);
  return match?.[1] ?? "item";
}

function terminalizeActiveCodexChips(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  streamState: CodexStreamState,
): void {
  for (const item of streamState.activeChipItems.values()) {
    emitCodexChipFromItem(emit, sessionId, item, false);
  }
  streamState.activeChipItems.clear();
}

function mapCodexNotification(
  message: JsonRpcNotification,
  emit: (event: AgentEvent) => void,
  sessionId: string,
  finalText: { value: string },
  streamAcc: { value: string },
  streamState: CodexStreamState,
): void {
  // Codex may omit turn/completed; idle/cancel/fail also ends activity chips.
  if (
    message.method.includes("turn/completed")
    || message.method.includes("turn/failed")
    || message.method.includes("turn/canceled")
    || message.method.includes("turn/cancelled")
    || isCodexThreadIdleNotification(message)
  ) {
    terminalizeActiveCodexChips(emit, sessionId, streamState);
    return;
  }

  if (message.method === "warning") {
    const params = isRecord(message.params) ? message.params : {};
    const warning = readString(params, ["message"]);
    if (!warning) return;
    if (isCodexSkillBudgetWarning(warning)) return;
    emit({ type: "warning", sessionId, message: warning });
    return;
  }

  if (message.method === "error") {
    const params = isRecord(message.params) ? message.params : {};
    emit({
      type: "error",
      sessionId,
      message: `Codex: ${JSON.stringify(params.error ?? params)}`,
    });
    return;
  }

  if (message.method === "item/fileChange/patchUpdated") {
    const params = isRecord(message.params) ? message.params : {};
    const itemId = readString(params, ["itemId"]) ?? "file-change";
    const changes = Array.isArray(params.changes) ? params.changes : [];
    const item = { type: "fileChange", id: itemId, changes };
    streamState.activeChipItems.set(itemId, item);
    const chip = buildCodexFileChip(item, true);
    if (chip) {
      emitCodexRuntimeActivityChip(emit, sessionId, {
        ...chip,
        turnId: readString(params, ["turnId"]) ?? undefined,
        emittedAtMs:
          typeof (message as unknown as Record<string, unknown>).emittedAtMs === "number"
            ? ((message as unknown as Record<string, unknown>).emittedAtMs as number)
            : undefined,
      });
    }
    return;
  }

  if (mapCodexItemDelta(message, emit, sessionId, finalText, streamAcc, streamState)) {
    return;
  }

  if (message.method.includes("item/started")) {
    const params = isRecord(message.params) ? message.params : {};
    const item = readCodexItem(params);
    const type = readString(item, ["type"]) ?? "item";
    const itemId = readString(item, ["id"]);
    const phase = readString(item, ["phase"]);
    if (itemId && type === "agentMessage" && phase) {
      streamState.itemPhaseById.set(itemId, phase);
    }
    if (type === "reasoning") {
      streamState.activeReasoningId = itemId;
      emit({ type: "thinking_start", sessionId });
      return;
    }
    if (isCodexChipItemType(type) || type === "mcpToolCall") {
      if (itemId) streamState.activeChipItems.set(itemId, item);
      emitCodexChipFromItem(emit, sessionId, item, true, {
        turnId: readString(params, ["turnId"]) ?? undefined,
        startedAtMs: typeof params.startedAtMs === "number" ? params.startedAtMs : undefined,
        emittedAtMs:
          typeof (message as unknown as Record<string, unknown>).emittedAtMs === "number"
            ? ((message as unknown as Record<string, unknown>).emittedAtMs as number)
            : undefined,
      });
      return;
    }
    if (isCodexToolItemType(type)) {
      emit({
        type: "tool_start",
        sessionId,
        callId: codexItemCallId(item),
        name: codexItemToolName(item),
        args: item,
      });
    }
    return;
  }

  if (message.method.includes("item/updated") || message.method.includes("item/changed")) {
    const params = isRecord(message.params) ? message.params : {};
    const item = readCodexItem(params);
    const type = readString(item, ["type"]) ?? "item";
    if (isCodexChipItemType(type) || type === "mcpToolCall") {
      const itemId = readString(item, ["id"]);
      if (itemId) streamState.activeChipItems.set(itemId, item);
      emitCodexChipFromItem(emit, sessionId, item, true);
      return;
    }
  }

  if (message.method.includes("item/completed")) {
    const params = isRecord(message.params) ? message.params : {};
    const item = readCodexItem(params);
    const type = readString(item, ["type"]) ?? "item";
    const itemId = readString(item, ["id"]);
    if (itemId) streamState.itemPhaseById.delete(itemId);
    if (type === "reasoning") {
      const text = codexReasoningText(item);
      if (text) emitThinkingDelta(emit, sessionId, text);
      emit({
        type: "thinking_end",
        sessionId,
        charCount: text.length,
      });
      streamState.activeReasoningId = null;
      return;
    }
    if (isCodexChipItemType(type) || type === "mcpToolCall") {
      if (itemId) streamState.activeChipItems.delete(itemId);
      emitCodexChipFromItem(emit, sessionId, item, false, {
        turnId: readString(params, ["turnId"]) ?? undefined,
        completedAtMs:
          typeof params.completedAtMs === "number" ? params.completedAtMs : undefined,
        durationMs: typeof item.durationMs === "number" ? item.durationMs : undefined,
        emittedAtMs:
          typeof (message as unknown as Record<string, unknown>).emittedAtMs === "number"
            ? ((message as unknown as Record<string, unknown>).emittedAtMs as number)
            : undefined,
      });
      if (type === "fileChange") {
        const chip = buildCodexFileChip(item, false);
        if (chip?.patch) {
          emit({
            type: "patch_proposed",
            sessionId,
            path: chip.patch.path,
            unifiedDiff: chip.patch.unifiedDiff,
            applied: true,
          });
        }
      }
      return;
    }
    if (isCodexToolItemType(type)) {
      emit({
        type: "tool_end",
        sessionId,
        callId: codexItemCallId(item),
        name: codexItemToolName(item),
        result: codexItemResultText(item),
      });
      return;
    }
    if (type === "agentMessage") {
      const phase = readString(item, ["phase"]);
      const text = readString(item, ["text"]);
      if (phase === "commentary" && text) {
        // Deltas already streamed the body; only emit the unsent suffix to avoid
        // mobile/desktop showing the same paragraph twice.
        const already = streamAcc.value;
        if (text.startsWith(already)) {
          const suffix = text.slice(already.length);
          if (suffix) emitTextDelta(emit, sessionId, suffix, streamAcc);
        } else if (!already) {
          emitTextDelta(emit, sessionId, text, streamAcc);
        }
        return;
      }
      if (phase === "final_answer" && text) {
        finalText.value = text;
        streamAcc.value = "";
      }
    }
  }
}

export async function runCodexRuntime(options: CodexRuntimeOptions): Promise<RunResult> {
  const cacheRepair = ensureCodexModelsCacheCompatible();
  if (cacheRepair.repaired) {
    console.error("[forge-codex] repaired ~/.codex/models_cache.json (added supports_reasoning_summaries)");
  } else if (cacheRepair.reason) {
    console.error(`[forge-codex] models_cache check skipped: ${cacheRepair.reason}`);
  }
  console.error(`[forge-codex] spawn codex app-server cwd=${options.cwd}`);
  const child = spawn("codex", ["app-server"], {
    cwd: options.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = new CodexJsonRpcClient(child);
  const finalText = { value: "" };
  const streamAcc = { value: "" };
  const streamState = createCodexStreamState();
  let cancelRequested = false;
  let modelsCacheWarningEmitted = false;
  const permissionBridge = createExternalRuntimePermissionBridge({
    emit: options.emit,
    sessionId: options.sessionId,
    signal: options.signal,
    kind: "codex",
    providerLabel: "Codex",
  });
  const answeredServerRequests = new Set<number>();

  rpc.onServerRequest(async (message) => {
    if (!isCodexApprovalMethod(message.method)) return;
    if (answeredServerRequests.has(message.id)) return;
    answeredServerRequests.add(message.id);
    const params = isRecord(message.params) ? message.params : {};
    const summary = buildCodexApprovalSummary(message.method, params);
    try {
      const optionId = await permissionBridge.requestDecision(
        summary,
        { method: message.method, ...params },
        codexOptionsFromParams(params),
      );
      rpc.respond(message.id, { decision: mapCodexDecision(optionId) });
    } catch {
      rpc.respond(message.id, { decision: "decline" });
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (!text) return;
    console.error(`[forge-codex:stderr] ${text}`);
    if (isCodexModelsCacheStderr(text)) {
      if (!modelsCacheWarningEmitted) {
        modelsCacheWarningEmitted = true;
        options.emit({
          type: "warning",
          sessionId: options.sessionId,
          message: "Codex 模型缓存字段过期（supports_reasoning_summaries），已忽略该错误，不影响本轮完成。",
        });
      }
      return;
    }
    if (!shouldSurfaceCodexStderr(text)) return;
    options.emit({
      type: "status",
      sessionId: options.sessionId,
      phase: "model",
      message: `Codex: ${stripAnsi(text).slice(0, 240)}`,
    });
  });

  const abort = () => {
    cancelRequested = true;
    emitStatus(options.emit, options.sessionId, "Codex 正在停止…");
    rpc.notify("turn/cancel");
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    let turnArmed = false;
    const completion = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleErr = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.once("error", (cause) => {
        settleErr(cause instanceof Error ? cause : new Error(String(cause)));
      });
      child.once("exit", (code, signal) => {
        if (cancelRequested || code === 0) {
          settleOk();
          return;
        }
        settleErr(
          new Error(`codex app-server exited before turn completion (${signal ?? code ?? "unknown"})`),
        );
      });
      rpc.onNotification((message) => {
        const kind = classifyCodexTurnNotification(message, turnArmed);
        if (kind === "started") {
          turnArmed = true;
          return;
        }
        if (kind === "completed" || kind === "canceled" || kind === "idle") {
          settleOk();
          return;
        }
        if (kind === "failed") {
          const params = isRecord(message.params) ? message.params : {};
          settleErr(new Error(readString(params, ["error", "message"]) ?? "Codex turn failed"));
        }
      });
    });
    rpc.onNotification((message) =>
      mapCodexNotification(
        message,
        options.emit,
        options.sessionId,
        finalText,
        streamAcc,
        streamState,
      ),
    );
    emitStatus(options.emit, options.sessionId, "Codex 初始化中…");
    await rpc.request("initialize", {
      clientInfo: { name: "forge-agent", title: "Forge Agent", version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    rpc.notify("initialized");
    const thread = await rpc.request("thread/start", buildThreadStartParams(options));
    const threadId = resolveThreadId(thread);
    emitStatus(options.emit, options.sessionId, "Codex turn 启动中…");
    await rpc.request("turn/start", buildTurnStartParams(options, threadId));
    // Arm even if turn/started notification is skipped/reordered.
    turnArmed = true;
    await completion;
    emitStatus(options.emit, options.sessionId, "Codex turn 完成");
    const answer = String(finalText.value || streamAcc.value || "").trim();
    return { sessionId: options.sessionId, finalText: answer };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    child.kill("SIGTERM");
  }
}
