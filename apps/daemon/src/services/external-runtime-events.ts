import type { AgentEvent } from "@forge/protocol";

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

export const CODEX_CHIP_PREFIX = "__codex_chip__:";

export type CodexActivityIcon = "search" | "read" | "command" | "file" | "mcp" | "think";

export interface CodexActivityChipPayload {
  callId: string;
  icon: CodexActivityIcon;
  label: string;
  status: "running" | "done";
  path?: string;
  adds?: number;
  dels?: number;
  patch?: { path: string; unifiedDiff: string };
}

export interface RuntimeActivityPayload {
  runtime: "codex" | "claude-code" | "cursor" | string;
  activityKind: "tool" | "command" | "file" | "mcp" | "search" | "read" | "think";
  status: "running" | "done";
  callId?: string;
  label?: string;
  name?: string;
  args?: unknown;
  result?: string;
  path?: string;
  adds?: number;
  dels?: number;
  patch?: { path: string; unifiedDiff: string };
}

/** Codex thread item types rendered as Forge tool lines (non-chip). */
export const CODEX_TOOL_ITEM_TYPES = new Set([
  "mcpToolCall",
  "localShellCall",
  "toolCall",
]);

export function isCodexToolItemType(type: string): boolean {
  return CODEX_TOOL_ITEM_TYPES.has(type);
}

export function isCodexChipItemType(type: string): boolean {
  return type === "commandExecution" || type === "fileChange";
}

export function normalizeCodexToolName(
  rawName: string,
  item: Record<string, unknown>,
): string {
  const type = readString(item, ["type"]) ?? rawName;
  if (type === "commandExecution" || rawName === "commandExecution") return "run_command";
  if (type === "localShellCall" || rawName === "localShellCall") return "run_command";
  return (
    readString(item, ["name", "toolName", "command"]) ??
    readString(item.toolCall, ["name", "toolName"]) ??
    rawName ??
    type ??
    "tool"
  );
}

function diffStatsFromText(diff: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) dels++;
  }
  return { adds, dels };
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function codexFileChangeVerb(change: Record<string, unknown>, running: boolean): string {
  const rawKind = isRecord(change.kind)
    ? readString(change.kind, ["type", "kind", "name"])
    : readString(change, ["kind", "type"]);
  if (rawKind === "delete" || rawKind === "remove") {
    return running ? "正在删除" : "已删除";
  }
  if (rawKind === "add" || rawKind === "create") {
    return running ? "正在编辑" : "已编辑";
  }
  return running ? "正在编辑" : "已编辑";
}

export function buildCodexCommandChip(
  item: Record<string, unknown>,
  running: boolean,
): CodexActivityChipPayload {
  const callId = readString(item, ["id"]) ?? "command";
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  let reads = 0;
  let lists = 0;
  let searches = 0;
  let commands = 0;
  for (const action of actions) {
    if (!isRecord(action)) continue;
    const type = readString(action, ["type"]) ?? "unknown";
    if (type === "read") reads += 1;
    else if (type === "listFiles") lists += 1;
    else if (type === "search") searches += 1;
    else commands += 1;
  }
  const parts: string[] = [];
  if (searches && lists) parts.push("已搜索代码和已列出文件");
  else if (searches) parts.push("已搜索代码");
  else if (lists) parts.push("已列出文件");
  if (reads) parts.push(`已读取 ${reads} 个文件`);
  const cmdCount = commands || (actions.length === 0 ? 1 : 0);
  if (cmdCount) {
    parts.push(running ? `正在运行 ${cmdCount} 条命令` : `已运行 ${cmdCount} 条命令`);
  }
  const label =
    parts.join("") ||
    (running ? "正在运行命令" : readString(item, ["command"])?.slice(0, 72) ?? "已运行 1 条命令");
  const icon: CodexActivityIcon = searches || lists ? "search" : reads ? "read" : "command";
  return { callId, icon, label, status: running ? "running" : "done" };
}

export function buildCodexFileChip(
  item: Record<string, unknown>,
  running: boolean,
): CodexActivityChipPayload | null {
  const callId = readString(item, ["id"]) ?? "file";
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const first = changes.find((c) => isRecord(c));
  const change = isRecord(first) ? first : item;
  const path =
    readString(change, ["path", "filePath", "filepath", "filename", "file"]) ??
    readString(item, ["path", "filePath", "filepath", "filename", "file"]);
  if (!path) return null;
  const diff = readString(change, ["diff", "unifiedDiff", "patch"]) ?? "";
  const { adds, dels } = diffStatsFromText(diff);
  const base = basename(path);
  const label = `${codexFileChangeVerb(change, running)} ${base}`;
  return {
    callId,
    icon: "file",
    label,
    status: running ? "running" : "done",
    path,
    adds,
    dels,
    ...(diff ? { patch: { path, unifiedDiff: diff } } : {}),
  };
}

export function buildCodexMcpChip(
  item: Record<string, unknown>,
  running: boolean,
): CodexActivityChipPayload | null {
  const callId = readString(item, ["id"]) ?? "mcp";
  const server = readString(item, ["server", "serverName"]) ?? readString(item, ["name"]);
  const tool = readString(item, ["toolName", "name"]);
  const label = running
    ? `正在调用 MCP${server ? ` · ${server}` : ""}`
    : `Loaded MCP${server ? ` · ${server}` : ""}${tool ? ` · ${tool}` : ""}`;
  return { callId, icon: "mcp", label, status: running ? "running" : "done" };
}

export function codexReasoningText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [];
  const lines: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const text =
      readString(block, ["text", "summary", "content", "title", "name"]) ??
      readString(block, ["message"]);
    if (text) lines.push(text);
  }
  if (lines.length) return lines.join("\n");
  return (
    readString(item, ["summary", "text", "content", "reasoning"]) ??
    readString(item.reasoning, ["summary", "text", "content"]) ??
    ""
  );
}

export function emitCodexActivityChip(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  payload: CodexActivityChipPayload,
): void {
  emit({
    type: "codex_activity",
    sessionId,
    callId: payload.callId,
    icon: payload.icon,
    label: payload.label,
    status: payload.status,
    path: payload.path,
    adds: payload.adds,
    dels: payload.dels,
    patch: payload.patch,
  });
}

export function emitRuntimeActivity(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  payload: RuntimeActivityPayload,
): void {
  const event: AgentEvent = {
    type: "runtime_activity",
    sessionId,
    runtime: payload.runtime,
    activityKind: payload.activityKind,
    status: payload.status,
  };
  if (payload.callId !== undefined) event.callId = payload.callId;
  if (payload.label !== undefined) event.label = payload.label;
  if (payload.name !== undefined) event.name = payload.name;
  if (payload.args !== undefined) event.args = payload.args;
  if (payload.result !== undefined) event.result = payload.result;
  if (payload.path !== undefined) event.path = payload.path;
  if (payload.adds !== undefined) event.adds = payload.adds;
  if (payload.dels !== undefined) event.dels = payload.dels;
  if (payload.patch !== undefined) event.patch = payload.patch;
  emit(event);
}

export function emitCodexRuntimeActivityChip(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  payload: CodexActivityChipPayload,
): void {
  emitRuntimeActivity(emit, sessionId, {
    runtime: "codex",
    activityKind: payload.icon,
    status: payload.status,
    callId: payload.callId,
    label: payload.label,
    path: payload.path,
    adds: payload.adds,
    dels: payload.dels,
    patch: payload.patch,
  });
}

export function emitThinkingDelta(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  delta: string,
): void {
  if (!delta) return;
  emit({ type: "thinking_delta", sessionId, delta });
}

export function emitTextDelta(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  delta: string,
  streamAcc: { value: string },
  finalText?: { value: string },
): void {
  if (!delta) return;
  streamAcc.value += delta;
  if (finalText) finalText.value += delta;
  emit({ type: "text_delta", sessionId, delta });
}
