import type { ChatMessage } from "@forge/protocol";
import { plainTextFromChatContent } from "@forge/protocol";

/** Rough token estimate (chars / 4) for context budgeting */
export function estimateMessageTokens(message: ChatMessage): number {
  const content = message.content;
  if (Array.isArray(content)) {
    let n = Math.ceil(plainTextFromChatContent(content).length / 4);
    for (const p of content) {
      if (p.type === "image_url") {
        const url = p.image_url?.url ?? "";
        n += url.startsWith("data:") ? Math.ceil(url.length / 24) : 512;
      }
    }
    return n;
  }
  return Math.ceil(JSON.stringify(message).length / 4);
}

export interface LoadHistoryResult {
  messages: ChatMessage[];
  truncated: boolean;
  droppedCount: number;
  estimatedTokens: number;
  /** Total tokens in full history before budgeting (for near-limit warnings). */
  totalEstimatedTokens: number;
  /** True when history uses ≥85% of budget but nothing dropped yet. */
  nearLimit: boolean;
}

/** Group messages so assistant+tool_call rounds stay intact when truncating. */
export function groupMessagesIntoTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "user") {
      turns.push([msg]);
      i++;
      continue;
    }
    if (msg.role === "assistant") {
      const turn = [msg];
      i++;
      while (i < messages.length && messages[i].role === "tool") {
        turn.push(messages[i]);
        i++;
      }
      turns.push(turn);
      continue;
    }
    if (msg.role === "tool") {
      turns.push([msg]);
      i++;
      continue;
    }
    turns.push([msg]);
    i++;
  }
  return turns;
}

function turnTokenCount(turn: ChatMessage[]): number {
  return turn.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/** Keep newest turns within maxTokens; never splits assistant/tool pairs. */
export function applyTokenBudget(
  messages: ChatMessage[],
  maxTokens: number,
): LoadHistoryResult {
  const totalEstimatedTokens = messages.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0,
  );

  if (!messages.length) {
    return {
      messages: [],
      truncated: false,
      droppedCount: 0,
      estimatedTokens: 0,
      totalEstimatedTokens: 0,
      nearLimit: false,
    };
  }

  const turns = groupMessagesIntoTurns(messages);
  const kept: ChatMessage[] = [];
  let tokens = 0;
  let truncated = false;
  let droppedCount = 0;

  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t];
    const turnTokens = turnTokenCount(turn);
    if (tokens + turnTokens > maxTokens && kept.length > 0) {
      truncated = true;
      droppedCount = turns
        .slice(0, t + 1)
        .reduce((n, tr) => n + tr.length, 0);
      break;
    }
    kept.unshift(...turn);
    tokens += turnTokens;
  }

  if (!kept.length && turns.length > 0) {
    const last = turns[turns.length - 1];
    kept.push(...last);
    tokens = turnTokenCount(last);
    truncated = turns.length > 1;
    droppedCount = messages.length - last.length;
  }

  const nearLimit =
    !truncated && tokens > maxTokens * 0.85 && tokens <= maxTokens;

  return {
    messages: kept,
    truncated,
    droppedCount,
    estimatedTokens: tokens,
    totalEstimatedTokens,
    nearLimit,
  };
}
