import type { MessageItem } from "./session-sanitize";
import type { RunUiEvent } from "./run-event-sanitize";

export type ToolView = {
  key: string;
  callId: string;
  name: string;
  status: "running" | "done";
  detail?: string;
  output?: string;
};

export type FileView = {
  key: string;
  path: string;
  status: "added" | "modified" | "deleted";
  additions?: number;
  deletions?: number;
  summary?: string;
};

export type TimelineItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "agent"; key: string; answers: string[]; tools: ToolView[] }
  | { kind: "system"; key: string; text: string };

export type ConversationViewModel = {
  messages: MessageItem[];
  thinking: string[];
  tools: ToolView[];
  files: FileView[];
  liveAssistant: string | null;
  agentShown: boolean;
  completedSummary: string;
  keyChanges: string[];
  verifications: Array<{ command: string; result: string }>;
};

const STATUS_LIKE =
  /^(Codex turn|正在启动|正在停止|已完成|思考中|执行中|步骤\s*\d|已允许|已拒绝|等待 Agent)/i;

export function isStatusLikeLine(line: string): boolean {
  return STATUS_LIKE.test(line.trim());
}

export function toolsFromMessages(messages: MessageItem[]): ToolView[] {
  const resultsById = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId && message.text) {
      resultsById.set(message.toolCallId, message.text.slice(0, 4_000));
    }
  }

  const tools: ToolView[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      const output = resultsById.get(call.id);
      tools.push({
        key: `tool:${call.id}`,
        callId: call.id,
        name: call.name,
        status: "done",
        ...(output ? { output } : {}),
      });
    }
  }

  // Fallback: orphan tool results without a matching tool_calls entry.
  for (const message of messages) {
    if (message.role !== "tool" || !message.toolCallId || seen.has(message.toolCallId)) continue;
    seen.add(message.toolCallId);
    tools.push({
      key: `tool:${message.toolCallId}`,
      callId: message.toolCallId,
      name: message.text.slice(0, 80) || "tool",
      status: "done",
      ...(message.text ? { output: message.text.slice(0, 4_000) } : {}),
    });
  }

  return tools;
}

export function toolsFromEvents(events: RunUiEvent[]): ToolView[] {
  const toolsById = new Map<string, ToolView>();
  for (const event of events) {
    if (event.kind !== "tool") continue;
    const prev = toolsById.get(event.callId);
    toolsById.set(event.callId, {
      key: `tool:${event.callId}`,
      callId: event.callId,
      name: event.name || prev?.name || "tool",
      status: event.status,
      detail: event.detail ?? prev?.detail,
      output: event.output ?? prev?.output,
    });
  }
  return [...toolsById.values()];
}

export function filesFromEvents(events: RunUiEvent[]): FileView[] {
  const filesByPath = new Map<string, FileView>();
  for (const event of events) {
    if (event.kind !== "file_change") continue;
    const prev = filesByPath.get(event.path);
    filesByPath.set(event.path, {
      key: `file:${event.path}`,
      path: event.path,
      status: event.status,
      additions: event.additions ?? prev?.additions,
      deletions: event.deletions ?? prev?.deletions,
      summary: event.summary ?? prev?.summary,
    });
  }
  return [...filesByPath.values()];
}

export function mergeTools(primary: ToolView[], fallback: ToolView[]): ToolView[] {
  if (!primary.length) return fallback;
  if (!fallback.length) return primary;
  const byId = new Map<string, ToolView>();
  for (const tool of fallback) byId.set(tool.callId, tool);
  for (const tool of primary) {
    const prev = byId.get(tool.callId);
    byId.set(tool.callId, {
      ...prev,
      ...tool,
      detail: tool.detail ?? prev?.detail,
      output: tool.output ?? prev?.output,
    });
  }
  return [...byId.values()];
}

function thinkingFromEvents(events: RunUiEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.kind !== "thinking") continue;
    const chunks = event.text.split(/\n+/);
    for (const chunk of chunks) {
      const cleaned = chunk.replace(/^[-*·•]\s*/, "").trim().slice(0, 240);
      if (!cleaned || isStatusLikeLine(cleaned)) continue;
      const last = lines[lines.length - 1];
      if (!last) {
        lines.push(cleaned);
      } else if (cleaned.startsWith(last)) {
        lines[lines.length - 1] = cleaned;
      } else if (last.endsWith(cleaned) || cleaned === last) {
        // duplicate or overlapping stream chunk
      } else {
        lines.push(cleaned);
      }
    }
  }
  return lines.slice(-8);
}

function verificationsFromTools(tools: ToolView[]): Array<{ command: string; result: string }> {
  return tools.flatMap((tool) => {
    const haystack = `${tool.name} ${tool.detail || ""}`;
    if (!/\b(test|vitest|jest|pytest|pnpm test|npm test|yarn test)\b/i.test(haystack)) {
      return [];
    }
    if (tool.status !== "done") return [];
    const command = (tool.detail || tool.name).slice(0, 120);
    const passed = !/\b(fail|error|失败)\b/i.test(tool.output || "");
    return [{
      command,
      result: passed ? "通过" : "未通过",
    }];
  });
}

export function buildConversationView(
  messages: MessageItem[],
  liveEvents: RunUiEvent[],
  liveText: string,
  _runStatus: string,
  running: boolean,
  persistedEvents: RunUiEvent[] = [],
): ConversationViewModel {
  const events = liveEvents.length ? liveEvents : persistedEvents;
  const thinking = thinkingFromEvents(events);

  const liveTools = toolsFromEvents(liveEvents);
  const persistedTools = mergeTools(toolsFromEvents(persistedEvents), toolsFromMessages(messages));
  const tools = mergeTools(liveTools, persistedTools);
  const files = filesFromEvents(liveEvents.length ? liveEvents : persistedEvents);
  const keyChanges = files
    .map((file) => file.summary)
    .filter((line): line is string => Boolean(line && line.trim()))
    .slice(0, 6);
  const verifications = verificationsFromTools(tools);
  const completedSummary = [
    "已完成",
    tools.length > 0 ? `${tools.length} 步` : null,
    files.length > 0 ? `${files.length} 个文件` : null,
  ].filter(Boolean).join(" · ");

  return {
    messages: messages.filter((item) => item.role !== "tool"),
    thinking,
    tools,
    files,
    // After the run ends, answers come from persisted messages only.
    // Keeping liveText would double-render the same assistant reply (timeline + footer).
    liveAssistant: running ? (liveText || null) : null,
    agentShown: running || liveEvents.length > 0 || persistedEvents.length > 0 || Boolean(liveText)
      || messages.some((item) => item.role === "assistant"),
    completedSummary,
    keyChanges,
    verifications,
  };
}

export function buildTimelineItems(
  messages: MessageItem[],
  running: boolean,
  liveTools: ToolView[] = [],
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let pendingAnswers: string[] = [];
  let pendingTools: ToolView[] = [];
  let agentKey = "";
  const resultById = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId && message.text) {
      resultById.set(message.toolCallId, message.text.slice(0, 4_000));
    }
  }

  const flushAgent = () => {
    if (!pendingAnswers.length && !pendingTools.length && !agentKey) return;
    items.push({
      kind: "agent",
      key: agentKey || `agent:${items.length}`,
      answers: pendingAnswers,
      tools: pendingTools,
    });
    pendingAnswers = [];
    pendingTools = [];
    agentKey = "";
  };

  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role === "user") {
      flushAgent();
      items.push({ kind: "user", key: message.key, text: message.text });
      continue;
    }
    if (message.role === "assistant") {
      if (!agentKey) agentKey = `agent:${message.key}`;
      const answer = message.text.trim();
      if (answer && pendingAnswers[pendingAnswers.length - 1] !== answer) {
        pendingAnswers.push(answer);
      }
      if (message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          if (pendingTools.some((tool) => tool.callId === call.id)) continue;
          const output = resultById.get(call.id);
          pendingTools.push({
            key: `tool:${call.id}`,
            callId: call.id,
            name: call.name,
            status: "done",
            ...(output ? { output } : {}),
          });
        }
      }
      continue;
    }
    flushAgent();
    items.push({ kind: "system", key: message.key, text: message.text });
  }

  if (running) {
    if (!pendingAnswers.length && !pendingTools.length) {
      items.push({
        kind: "agent",
        key: `agent:live:${items.length}`,
        answers: [],
        tools: liveTools,
      });
    } else {
      pendingTools = mergeTools(liveTools, pendingTools);
      flushAgent();
    }
  } else {
    if (liveTools.length) {
      pendingTools = mergeTools(liveTools, pendingTools);
    }
    flushAgent();
  }

  return items;
}
