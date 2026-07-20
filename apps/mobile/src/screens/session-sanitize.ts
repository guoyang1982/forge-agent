import { parseRunEvents, type RunUiEvent } from "./run-event-sanitize";

export interface SessionItem {
  id: string;
  cwd: string;
  updatedAt: string;
  messageCount: number;
  lastPreview: string;
}

export interface MessageToolCall {
  id: string;
  name: string;
}

export interface MessageItem {
  key: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolCalls?: MessageToolCall[];
  toolCallId?: string;
}

export function parseSessions(value: unknown): SessionItem[] {
  if (!value || typeof value !== "object") return [];
  const root = value as Record<string, unknown>;
  const rows = Array.isArray(root.sessions) ? root.sessions : Array.isArray(root.hits) ? root.hits : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.cwd !== "string") return [];
    return [{
      id: item.id,
      cwd: item.cwd,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      messageCount: typeof item.messageCount === "number" ? item.messageCount : 0,
      lastPreview: typeof item.lastPreview === "string" ? item.lastPreview.slice(0, 240) : "",
    }];
  });
}

export function parseMessages(value: unknown): MessageItem[] {
  if (!value || typeof value !== "object") return [];
  const rows = (value as Record<string, unknown>).messages;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row, index) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    if (!isRole(item.role)) return [];
    const text = messageText(item.content).slice(0, 20_000);
    const toolCalls = parseToolCalls(item.tool_calls);
    const toolCallId = typeof item.tool_call_id === "string"
      ? item.tool_call_id.slice(0, 120)
      : undefined;
    if (!text && toolCalls.length === 0 && !toolCallId) return [];
    return [{
      key: `${index}:${item.role}`,
      role: item.role,
      text,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    }];
  });
}

/** Sanitize persisted session_events payloads into mobile UI events. */
export function parseSessionEvents(value: unknown): RunUiEvent[] {
  if (!value || typeof value !== "object") return [];
  const rows = (value as Record<string, unknown>).events;
  if (!Array.isArray(rows)) return [];
  const events: RunUiEvent[] = [];
  for (const row of rows.slice(-400)) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const payload = record.event && typeof record.event === "object"
      ? record.event
      : record;
    for (const event of parseRunEvents(payload)) {
      events.push(event);
    }
  }
  return events;
}

function parseToolCalls(value: unknown): MessageToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.slice(0, 120) : "";
    const fn = item.function && typeof item.function === "object"
      ? item.function as Record<string, unknown>
      : null;
    const name = fn && typeof fn.name === "string" ? fn.name.slice(0, 120) : "";
    if (!id || !name) return [];
    return [{ id, name }];
  });
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

function isRole(value: unknown): value is MessageItem["role"] {
  return value === "user" || value === "assistant" || value === "tool" || value === "system";
}
