import type { ChatMessage } from "@forge/protocol";
import { plainTextFromChatContent } from "@forge/protocol";

const MAX_HISTORY_CHARS = 24_000;

export function buildExternalHistoryContext(messages: ChatMessage[]): string | undefined {
  if (!messages.length) return undefined;

  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    const text = plainTextFromChatContent(msg.content).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (msg.role === "user") {
      lines.push(`User: ${text}`);
      continue;
    }
    if (msg.role === "assistant") {
      lines.push(`Assistant: ${text}`);
      continue;
    }
    if (msg.role === "tool") {
      const snippet = text.slice(0, 400);
      lines.push(`Tool result: ${snippet}${text.length > 400 ? "…" : ""}`);
    }
  }

  if (!lines.length) return undefined;

  let body = lines.join("\n\n");
  if (body.length > MAX_HISTORY_CHARS) {
    body = `…(truncated)\n\n${body.slice(-MAX_HISTORY_CHARS)}`;
  }

  return `## Prior conversation\n\n${body}`;
}
