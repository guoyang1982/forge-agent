export interface SessionItem {
  id: string;
  cwd: string;
  updatedAt: string;
  messageCount: number;
  lastPreview: string;
}

export interface MessageItem {
  key: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
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
    return text ? [{ key: `${index}:${item.role}`, role: item.role, text }] : [];
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
