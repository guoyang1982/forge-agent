export type RunUiEvent =
  | { kind: "thinking"; text: string }
  | { kind: "session"; sessionId: string }
  | { kind: "text"; delta: string }
  | { kind: "status"; label: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      status: "running" | "done";
      detail?: string;
      output?: string;
    }
  | {
      kind: "file_change";
      path: string;
      status: "added" | "modified" | "deleted";
      additions?: number;
      deletions?: number;
      summary?: string;
    }
  | {
      kind: "permission";
      requestId: string;
      sessionId?: string;
      summary: string;
      options: Array<{ optionId: string; name: string; allow: boolean }>;
    }
  | { kind: "permission_dismissed"; requestId: string; sessionId?: string }
  | { kind: "done"; sessionId: string; finalText?: string }
  | { kind: "error"; message: string };

/**
 * Merge streaming text chunks without duplicating full-message replays
 * (Codex commentary completion often re-sends the whole text as a "delta").
 */
export function appendStreamingText(current: string, delta: string): string {
  if (!delta) return current;
  if (!current) return delta.slice(-100_000);
  if (delta === current) return current;
  if (current.endsWith(delta)) return current;
  if (delta.startsWith(current)) return delta.slice(-100_000);
  // Overlap: current ends with a prefix of delta.
  const maxOverlap = Math.min(current.length, delta.length);
  for (let size = maxOverlap; size >= 16; size -= 1) {
    if (current.endsWith(delta.slice(0, size))) {
      return `${current}${delta.slice(size)}`.slice(-100_000);
    }
  }
  return `${current}${delta}`.slice(-100_000);
}

export function parseRunEvent(value: unknown): RunUiEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "thinking":
    case "thinking_delta": {
      const text = typeof event.text === "string"
        ? event.text
        : typeof event.delta === "string"
          ? event.delta
          : null;
      return text ? { kind: "thinking", text: text.slice(0, 20_000) } : null;
    }
    case "session_start":
      return typeof event.sessionId === "string"
        ? { kind: "session", sessionId: event.sessionId }
        : null;
    case "text_delta":
      return typeof event.delta === "string"
        ? { kind: "text", delta: event.delta.slice(0, 20_000) }
        : null;
    case "status": {
      const label = sanitizeStatusLabel(event.message);
      return label ? { kind: "status", label } : null;
    }
    case "step_start":
      return typeof event.step === "number" && typeof event.maxSteps === "number"
        ? { kind: "status", label: `步骤 ${event.step}/${event.maxSteps}` }
        : null;
    case "tool_start":
      return typeof event.name === "string"
        ? {
            kind: "tool",
            callId: typeof event.callId === "string" ? event.callId : event.name,
            name: event.name.slice(0, 120),
            status: "running",
            ...(safeToolDetail(event.args) ? { detail: safeToolDetail(event.args) } : {}),
          }
        : null;
    case "tool_end":
      return typeof event.name === "string"
        ? {
            kind: "tool",
            callId: typeof event.callId === "string" ? event.callId : event.name,
            name: event.name.slice(0, 120),
            status: "done",
            ...(output(event.result)
              ? { output: output(event.result) }
              : {}),
          }
        : null;
    case "tool_result":
    case "command_output":
      return typeof event.name === "string" || typeof event.command === "string"
        ? {
            kind: "tool",
            callId: typeof event.callId === "string"
              ? event.callId
              : typeof event.id === "string"
                ? event.id
                : typeof event.name === "string"
                  ? event.name
                  : event.command as string,
            name: (typeof event.name === "string" ? event.name : event.command as string).slice(0, 120),
            status: "done",
            ...(typeof event.command === "string" && event.command.trim()
              ? { detail: event.command.trim().slice(0, 240) }
              : {}),
            ...(output(event.output ?? event.result ?? event.text)
              ? { output: output(event.output ?? event.result ?? event.text) }
              : {}),
          }
        : null;
    case "runtime_activity":
    case "codex_activity":
      return parseActivityEvent(event);
    case "file_change":
    case "diff":
      return typeof event.path === "string" && fileStatus(event.status ?? event.kind)
        ? {
            kind: "file_change",
            path: event.path.slice(0, 4096),
            status: fileStatus(event.status ?? event.kind)!,
            ...(count(event.additions ?? event.adds) !== undefined
              ? { additions: count(event.additions ?? event.adds) }
              : {}),
            ...(count(event.deletions ?? event.dels) !== undefined
              ? { deletions: count(event.deletions ?? event.dels) }
              : {}),
            ...(typeof event.summary === "string" && event.summary.trim()
              ? { summary: event.summary.trim().slice(0, 300) }
              : typeof event.message === "string" && event.message.trim()
                ? { summary: event.message.trim().slice(0, 300) }
                : typeof event.label === "string" && event.label.trim()
                  ? { summary: event.label.trim().slice(0, 300) }
                  : {}),
          }
        : null;
    case "patch_proposed": {
      if (typeof event.path !== "string") return null;
      const diff = typeof event.unifiedDiff === "string" ? event.unifiedDiff : "";
      const stats = countUnifiedDiff(diff);
      const status = diffLooksLikeCreate(diff) ? "added" as const : "modified" as const;
      return {
        kind: "file_change",
        path: event.path.slice(0, 4096),
        status,
        ...(stats.additions !== undefined ? { additions: stats.additions } : {}),
        ...(stats.deletions !== undefined ? { deletions: stats.deletions } : {}),
        summary: event.applied === true ? "已写入工作区" : "待确认写入",
      };
    }
    case "permission_request":
      return typeof event.id === "string" && typeof event.summary === "string"
        ? {
            kind: "permission",
            requestId: event.id,
            sessionId: typeof event.sessionId === "string" ? event.sessionId : undefined,
            summary: event.summary.slice(0, 300),
            options: parsePermissionOptions(event.options),
          }
        : null;
    case "permission_dismissed":
      return typeof event.id === "string"
        ? {
            kind: "permission_dismissed",
            requestId: event.id,
            sessionId: typeof event.sessionId === "string" ? event.sessionId : undefined,
          }
        : null;
    case "done":
      return typeof event.sessionId === "string"
        ? {
            kind: "done",
            sessionId: event.sessionId,
            finalText: typeof event.finalText === "string" ? event.finalText.slice(0, 100_000) : undefined,
          }
        : null;
    case "error":
    case "warning": {
      const message = sanitizeStatusLabel(event.message, 500);
      return message ? { kind: "error", message } : null;
    }
    default:
      return null;
  }
}

/** Expand multi-file runtime_activity into one or more UI events. */
export function parseRunEvents(value: unknown): RunUiEvent[] {
  if (!value || typeof value !== "object") return [];
  const event = value as Record<string, unknown>;
  if (event.type !== "runtime_activity" && event.type !== "codex_activity") {
    const single = parseRunEvent(value);
    return single ? [single] : [];
  }
  const activityKind = String(event.activityKind ?? event.icon ?? "");
  if (activityKind === "file" || Array.isArray(event.changes)) {
    const changes = Array.isArray(event.changes) ? event.changes : null;
    if (changes?.length) {
      return changes.flatMap((change) => {
        if (!change || typeof change !== "object") return [];
        const row = change as Record<string, unknown>;
        if (typeof row.path !== "string") return [];
        const status = fileStatus(row.kind ?? row.status) ?? "modified";
        return [{
          kind: "file_change" as const,
          path: row.path.slice(0, 4096),
          status,
          ...(count(row.adds ?? row.additions) !== undefined
            ? { additions: count(row.adds ?? row.additions) }
            : {}),
          ...(count(row.dels ?? row.deletions) !== undefined
            ? { deletions: count(row.dels ?? row.deletions) }
            : {}),
          ...(typeof event.label === "string" && event.label.trim()
            ? { summary: event.label.trim().slice(0, 300) }
            : {}),
        }];
      });
    }
  }
  const single = parseRunEvent(value);
  return single ? [single] : [];
}

function parseActivityEvent(event: Record<string, unknown>): RunUiEvent | null {
  const activityKind = String(event.activityKind ?? event.icon ?? "");
  const status: "running" | "done" =
    event.status === "done" || event.status === "failed" || event.status === "declined"
      ? "done"
      : "running";
  const callId = typeof event.callId === "string"
    ? event.callId
    : typeof event.id === "string"
      ? event.id
      : activityKind || "activity";

  if (activityKind === "file") {
    if (typeof event.path !== "string") return null;
    return {
      kind: "file_change",
      path: event.path.slice(0, 4096),
      status: "modified",
      ...(count(event.adds ?? event.additions) !== undefined
        ? { additions: count(event.adds ?? event.additions) }
        : {}),
      ...(count(event.dels ?? event.deletions) !== undefined
        ? { deletions: count(event.dels ?? event.deletions) }
        : {}),
      ...(typeof event.label === "string" && event.label.trim()
        ? { summary: event.label.trim().slice(0, 300) }
        : {}),
    };
  }

  const name = (
    typeof event.name === "string" && event.name.trim()
      ? event.name
      : typeof event.label === "string" && event.label.trim()
        ? event.label
        : activityKind || "tool"
  ).slice(0, 120);
  const detail = typeof event.path === "string" && event.path.trim()
    ? event.path.trim().slice(0, 240)
    : safeToolDetail(event.args)
      ?? (typeof event.label === "string" && event.label !== name
        ? event.label.slice(0, 240)
        : undefined);

  return {
    kind: "tool",
    callId: callId.slice(0, 120),
    name: formatActivityToolName(activityKind, name),
    status,
    ...(detail ? { detail } : {}),
    ...(output(event.result) ? { output: output(event.result) } : {}),
  };
}

function formatActivityToolName(activityKind: string, name: string): string {
  const pretty: Record<string, string> = {
    read: "ReadFile 读取文件",
    search: "Search 搜索",
    command: "Shell 运行命令",
    tool: "Tool",
    mcp: "MCP",
    think: "Thinking",
  };
  const mapped = pretty[activityKind];
  if (mapped && (name === activityKind || name === "run_command" || !name)) {
    return mapped;
  }
  if (activityKind === "command" && name === "run_command") return pretty.command!;
  if (activityKind === "read") return pretty.read!;
  return name;
}

/** Strip ANSI / collapse models-cache ERROR spam into a short UI label. */
export function sanitizeStatusLabel(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  if (
    /failed to (load models cache|renew cache TTL)/i.test(cleaned)
    || /supports_reasoning_summaries/i.test(cleaned)
  ) {
    return "Codex 模型缓存需刷新（不影响本轮）";
  }
  return cleaned.slice(0, max);
}

function safeToolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filepath", "file", "command", "cmd"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 240);
    }
  }
  return undefined;
}

function parsePermissionOptions(value: unknown): Array<{
  optionId: string;
  name: string;
  allow: boolean;
}> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const option = item as Record<string, unknown>;
    if (typeof option.optionId !== "string" || typeof option.name !== "string") return [];
    const kind = typeof option.kind === "string" ? option.kind : "";
    return [{
      optionId: option.optionId,
      name: option.name.slice(0, 100),
      allow: /allow|approve|accept|允许/i.test(`${kind} ${option.name}`),
    }];
  });
}

function output(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, 50_000) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function fileStatus(value: unknown): "added" | "modified" | "deleted" | null {
  return value === "added" || value === "add" || value === "create"
    ? "added"
    : value === "modified" || value === "modify" || value === "update"
      ? "modified"
      : value === "deleted" || value === "delete" || value === "remove"
        ? "deleted"
        : null;
}

function countUnifiedDiff(diff: string): { additions?: number; deletions?: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return {
    ...(additions > 0 ? { additions } : {}),
    ...(deletions > 0 ? { deletions } : {}),
  };
}

function diffLooksLikeCreate(diff: string): boolean {
  return /^---\s+\/dev\/null/m.test(diff) || /^\+\+\+\s+b\//m.test(diff) && !/^---\s+a\//m.test(diff);
}
