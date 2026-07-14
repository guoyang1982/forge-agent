import type {
  ChatMessage,
  ForgeConfig,
  ToolCall,
  ToolDefinition,
} from "@forge/protocol";
import {
  llmErrorMentionsUnsupportedImages,
  sanitizeMessagesForTextOnlyApi,
} from "@forge/protocol";
import { LlmError } from "./errors.js";
import {
  applySseChunk,
  bodyLooksLikeSse,
  createSseParseState,
  extractSseJsonPayload,
  finalizeSseParseState,
  parseLlmResponseBody,
} from "./sse.js";

export { LlmError } from "./errors.js";

export interface LlmChatResult {
  text: string | null;
  toolCalls: ToolCall[];
  /** DeepSeek thinking / reasoner chain-of-thought (not shown to end users by default). */
  reasoningContent?: string | null;
}

export interface LlmChatOptions {
  messages: ChatMessage[];
  /** When false/undefined, image_url parts are flattened to text before the HTTP request. */
  supportsVision?: boolean;
  tools: ToolDefinition[];
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  /** DeepSeek `delta.reasoning_content` — emitted before answer content. */
  onThinkingDelta?: (delta: string) => void;
  /** Called once when reasoning phase ends (answer or tool_calls begin). */
  onThinkingEnd?: (fullReasoning: string) => void;
  /** Throttled hints while streaming tool-call JSON (large write_file, etc.). */
  onStreamStatus?: (message: string) => void;
}

export type LlmModelConfig = ForgeConfig["model"];

/** Avoid indefinite hangs when the upstream API stops responding. */
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

function requestAbortSignal(userSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  if (!userSignal) return timeoutSignal;
  return AbortSignal.any([userSignal, timeoutSignal]);
}

export class LlmClient {
  constructor(private config: LlmModelConfig) {}

  async chat(options: LlmChatOptions): Promise<LlmChatResult> {
    const apiMessages = options.supportsVision
      ? options.messages
      : sanitizeMessagesForTextOnlyApi(options.messages);

    const body: Record<string, unknown> = {
      model: this.config.name,
      messages: apiMessages.map(toApiMessage),
      tools: options.tools.length
        ? options.tools.map(toApiTool)
        : undefined,
      tool_choice: options.tools.length ? "auto" : undefined,
      stream: Boolean(
        options.onTextDelta ||
          options.onStreamStatus ||
          options.onThinkingDelta ||
          options.onThinkingEnd,
      ),
    };
    const opts = this.config.options;
    if (opts?.thinking) body.thinking = opts.thinking;
    if (opts?.reasoning_effort) body.reasoning_effort = opts.reasoning_effort;

    if (!this.config.apiKey) {
      throw new Error(
        "Model API key not set. Run: forge config set model.apiKey <key>",
      );
    }

    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: requestAbortSignal(options.signal),
    });

    if (!res.ok) {
      const errText = await res.text();
      const err = LlmError.fromHttp(res.status, errText);
      if (
        options.supportsVision &&
        res.status === 400 &&
        llmErrorMentionsUnsupportedImages(err.message)
      ) {
        const stripped = sanitizeMessagesForTextOnlyApi(options.messages);
        const retryBody = {
          ...body,
          messages: stripped.map(toApiMessage),
        };
        const retryRes = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(retryBody),
          signal: requestAbortSignal(options.signal),
        });
        if (retryRes.ok) {
          return this.parseCompletionResponse(retryRes, options);
        }
      }
      throw err;
    }

    if (
      body.stream &&
      (options.onTextDelta ||
        options.onStreamStatus ||
        options.onThinkingDelta ||
        options.onThinkingEnd)
    ) {
      const streamed = await parseStream(res, {
        onTextDelta: options.onTextDelta,
        onThinkingDelta: options.onThinkingDelta,
        onThinkingEnd: options.onThinkingEnd,
        onStreamStatus: options.onStreamStatus,
        signal: options.signal,
      });
      if (!streamed.text && !streamed.toolCalls.length) {
        const fallback = await this.chat({
          ...options,
          onTextDelta: undefined,
          onThinkingDelta: undefined,
          onThinkingEnd: undefined,
          onStreamStatus: undefined,
          signal: options.signal,
        });
        return fallback;
      }
      return streamed;
    }

    return this.parseCompletionResponse(res, options);
  }

  private async parseCompletionResponse(
    res: Response,
    options: LlmChatOptions,
  ): Promise<LlmChatResult> {
    const raw = await res.text();
    const parsed = parseLlmResponseBody(raw, {
      onTextDelta: options.onTextDelta,
      onThinkingDelta: options.onThinkingDelta,
      onThinkingEnd: options.onThinkingEnd,
      onStreamStatus: options.onStreamStatus,
    });
    if (parsed.text?.trim() || parsed.toolCalls.length) {
      return parsed;
    }

    if (!bodyLooksLikeSse(raw)) {
      try {
        const json = JSON.parse(raw.trim()) as ApiCompletion;
        const choice = json.choices?.[0]?.message;
        if (choice) {
          const msg = parseMessage(choice);
          if (msg.text?.trim() || msg.toolCalls.length) return msg;
        }
      } catch {
        /* handled below */
      }
    }

    throw new LlmError("模型返回为空内容（无文本且无工具调用）", 502);
  }
}

interface ApiCompletion {
  choices?: Array<{ message?: ApiMessage }>;
}

interface ApiMessage {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

function toApiMessage(m: ChatMessage): Record<string, unknown> {
  const content =
    m.content == null
      ? null
      : typeof m.content === "string"
        ? m.content
        : m.content;
  const base: Record<string, unknown> = {
    role: m.role,
    content,
  };
  if (m.reasoning_content != null && m.role === "assistant") {
    base.reasoning_content = m.reasoning_content;
  }
  if (m.tool_calls) base.tool_calls = m.tool_calls;
  if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
  return base;
}

function toApiTool(t: ToolDefinition) {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  };
}

function parseMessage(msg: ApiMessage): LlmChatResult {
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: safeParseArgs(tc.function.arguments),
  }));
  return {
    text: msg.content ?? null,
    toolCalls,
    reasoningContent: msg.reasoning_content ?? null,
  };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _raw: raw };
  }
}

async function parseStream(
  res: Response,
  callbacks: {
    onTextDelta?: (d: string) => void;
    onThinkingDelta?: (d: string) => void;
    onThinkingEnd?: (full: string) => void;
    onStreamStatus?: (message: string) => void;
    signal?: AbortSignal;
  },
): Promise<LlmChatResult> {
  const { signal, ...streamCallbacks } = callbacks;
  const reader = res.body?.getReader();
  if (!reader) return { text: null, toolCalls: [] };

  const decoder = new TextDecoder();
  let buffer = "";
  const state = createSseParseState();

  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new DOMException("Aborted", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const payload = extractSseJsonPayload(line);
      if (payload) applySseChunk(state, payload, streamCallbacks);
    }
  }

  const tail = extractSseJsonPayload(buffer);
  if (tail) applySseChunk(state, tail, streamCallbacks);

  return finalizeSseParseState(state, streamCallbacks);
}
