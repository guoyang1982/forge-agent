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

export interface MessageAttachment {
  kind: "image" | "file";
  name?: string;
  /** Local preview URI for optimistic bubbles only. */
  localUri?: string;
}

export interface MessageItem {
  key: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  messageId?: number;
  toolCalls?: MessageToolCall[];
  toolCallId?: string;
  attachments?: MessageAttachment[];
}

export interface SessionHistoryPage {
  messages: MessageItem[];
  events: RunUiEvent[];
  truncated: boolean;
  oldestMessageId: number | null;
  oldestEventSequence: number | null;
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
    const attachments = messageAttachments(item.content);
    const toolCalls = parseToolCalls(item.tool_calls);
    const toolCallId = typeof item.tool_call_id === "string"
      ? item.tool_call_id.slice(0, 120)
      : undefined;
    if (!text && toolCalls.length === 0 && !toolCallId && attachments.length === 0) return [];
    const messageId = typeof item.id === "number" && Number.isFinite(item.id)
      ? Math.floor(item.id)
      : undefined;
    return [{
      key: messageId != null ? `m:${messageId}` : `${index}:${item.role}`,
      role: item.role,
      text,
      ...(messageId != null ? { messageId } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(attachments.length ? { attachments } : {}),
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

export function parseSessionHistoryPage(value: unknown): SessionHistoryPage {
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const messages = parseMessages(root);
  const events = parseSessionEvents(root);
  const oldestMessageId = typeof root.oldestMessageId === "number"
    ? root.oldestMessageId
    : messages.find((row) => row.messageId != null)?.messageId ?? null;
  const oldestEventSequence = typeof root.oldestEventSequence === "number"
    ? root.oldestEventSequence
    : null;
  return {
    messages,
    events,
    truncated: root.truncated === true,
    oldestMessageId,
    oldestEventSequence,
  };
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

function messageAttachments(content: unknown): MessageAttachment[] {
  if (!Array.isArray(content)) return [];
  const out: MessageAttachment[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const value = part as Record<string, unknown>;
    if (value.type === "image_url") {
      out.push({
        kind: "image",
        name: typeof value.name === "string" ? value.name.slice(0, 120) : "图片",
      });
      continue;
    }
    if (value.type === "file" || value.type === "document") {
      out.push({
        kind: "file",
        name: typeof value.name === "string"
          ? value.name.slice(0, 120)
          : (typeof value.filename === "string" ? value.filename.slice(0, 120) : "文件"),
      });
    }
  }
  return out.slice(0, 8);
}

function isRole(value: unknown): value is MessageItem["role"] {
  return value === "user" || value === "assistant" || value === "tool" || value === "system";
}
