import type { ToolCall } from "@forge/protocol";

export interface SseStreamCallbacks {
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onThinkingEnd?: (fullReasoning: string) => void;
  onStreamStatus?: (message: string) => void;
}

export interface SseParseState {
  text: string;
  reasoning: string;
  inReasoning: boolean;
  reasoningEnded: boolean;
  toolCalls: Map<number, { id: string; name: string; arguments: string }>;
  lastToolStatusAt: number;
  lastToolStatusKb: number;
}

export interface SseParseResult {
  text: string | null;
  toolCalls: ToolCall[];
  reasoningContent: string | null;
}

/** Strip the standard SSE prefix (`data: ` or `data:`). */
export function extractSseJsonPayload(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  if (trimmed.startsWith("event:")) return null;
  if (trimmed.startsWith("data:")) {
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return null;
    return payload;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }
  return null;
}

export function createSseParseState(): SseParseState {
  return {
    text: "",
    reasoning: "",
    inReasoning: false,
    reasoningEnded: false,
    toolCalls: new Map(),
    lastToolStatusAt: 0,
    lastToolStatusKb: -1,
  };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}

function endReasoningPhase(
  state: SseParseState,
  callbacks?: SseStreamCallbacks,
): void {
  if (!state.inReasoning || state.reasoningEnded) return;
  state.reasoningEnded = true;
  state.inReasoning = false;
  callbacks?.onThinkingEnd?.(state.reasoning);
}

function emitToolStatus(
  state: SseParseState,
  name: string,
  argLen: number,
  callbacks?: SseStreamCallbacks,
): void {
  if (!callbacks?.onStreamStatus || !name) return;
  const now = Date.now();
  const kb = argLen / 1024;
  const kbBucket = kb >= 1024 ? Math.floor(kb / 1024) : Math.floor(kb);
  if (kbBucket === state.lastToolStatusKb && now - state.lastToolStatusAt < 2000) {
    return;
  }
  state.lastToolStatusAt = now;
  state.lastToolStatusKb = kbBucket;
  const size =
    kb >= 1
      ? kb >= 1024
        ? `${(kb / 1024).toFixed(1)}MB`
        : `${kb.toFixed(0)}KB`
      : "";
  callbacks.onStreamStatus(size ? `${name} ${size}` : `${name}…`);
}

type SseChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
  }>;
};

export function applySseChunk(
  state: SseParseState,
  payload: string,
  callbacks?: SseStreamCallbacks,
): void {
  let chunk: SseChunk;
  try {
    chunk = JSON.parse(payload) as SseChunk;
  } catch {
    return;
  }

  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  const message = choice?.message;

  if (delta?.reasoning_content) {
    if (!state.inReasoning) state.inReasoning = true;
    state.reasoning += delta.reasoning_content;
    callbacks?.onThinkingDelta?.(delta.reasoning_content);
  }
  if (delta?.content) {
    endReasoningPhase(state, callbacks);
    state.text += delta.content;
    callbacks?.onTextDelta?.(delta.content);
  }
  if (delta?.tool_calls?.length) {
    endReasoningPhase(state, callbacks);
  }
  for (const tc of delta?.tool_calls ?? []) {
    const cur = state.toolCalls.get(tc.index) ?? {
      id: tc.id ?? "",
      name: "",
      arguments: "",
    };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name && tc.function.name !== cur.name) {
      cur.name = tc.function.name;
      emitToolStatus(state, cur.name, cur.arguments.length, callbacks);
    }
    if (tc.function?.arguments) {
      cur.arguments += tc.function.arguments;
      emitToolStatus(state, cur.name, cur.arguments.length, callbacks);
    }
    state.toolCalls.set(tc.index, cur);
  }

  if (message?.reasoning_content) {
    state.reasoning = message.reasoning_content;
  }
  if (message?.content) {
    endReasoningPhase(state, callbacks);
    state.text += message.content;
    callbacks?.onTextDelta?.(message.content);
  }
  if (message?.tool_calls?.length) {
    endReasoningPhase(state, callbacks);
    state.toolCalls.clear();
    message.tool_calls.forEach((tc, index) => {
      state.toolCalls.set(index, {
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    });
  }
}

export function finalizeSseParseState(
  state: SseParseState,
  callbacks?: SseStreamCallbacks,
): SseParseResult {
  endReasoningPhase(state, callbacks);
  const calls = [...state.toolCalls.values()]
    .filter((tc) => tc.name && tc.id)
    .map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: safeParseArgs(tc.arguments),
    }));
  return {
    text: state.text || null,
    toolCalls: calls,
    reasoningContent: state.reasoning || null,
  };
}

/** Parse full HTTP body that may be SSE (`data: {...}`) or a single JSON object. */
export function parseLlmResponseBody(
  raw: string,
  callbacks?: SseStreamCallbacks,
): SseParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: null, toolCalls: [], reasoningContent: null };
  }

  const state = createSseParseState();

  if (trimmed.startsWith("{") && !trimmed.includes("\ndata:")) {
    try {
      const json = JSON.parse(trimmed) as SseChunk;
      const msg = json.choices?.[0]?.message;
      if (msg) {
        applySseChunk(state, JSON.stringify({ choices: [{ message: msg }] }), callbacks);
        return finalizeSseParseState(state, callbacks);
      }
    } catch {
      /* fall through to SSE */
    }
  }

  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    const payload = extractSseJsonPayload(line);
    if (payload) applySseChunk(state, payload, callbacks);
  }

  return finalizeSseParseState(state, callbacks);
}

export function bodyLooksLikeSse(raw: string): boolean {
  const t = raw.trimStart();
  return t.startsWith("data:") || t.includes("\ndata:") || t.includes("\r\ndata:");
}
