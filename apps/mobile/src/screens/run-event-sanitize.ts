export type RunUiEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; delta: string }
  | { kind: "status"; label: string }
  | { kind: "tool"; callId: string; name: string; status: "running" | "done" }
  | {
      kind: "permission";
      requestId: string;
      sessionId?: string;
      summary: string;
      options: Array<{ optionId: string; name: string; allow: boolean }>;
    }
  | { kind: "done"; sessionId: string; finalText?: string }
  | { kind: "error"; message: string };

export function parseRunEvent(value: unknown): RunUiEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "session_start":
      return typeof event.sessionId === "string"
        ? { kind: "session", sessionId: event.sessionId }
        : null;
    case "text_delta":
      return typeof event.delta === "string"
        ? { kind: "text", delta: event.delta.slice(0, 20_000) }
        : null;
    case "status":
      return typeof event.message === "string"
        ? { kind: "status", label: event.message.slice(0, 240) }
        : null;
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
          }
        : null;
    case "tool_end":
      return typeof event.name === "string"
        ? {
            kind: "tool",
            callId: typeof event.callId === "string" ? event.callId : event.name,
            name: event.name.slice(0, 120),
            status: "done",
          }
        : null;
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
    case "done":
      return typeof event.sessionId === "string"
        ? {
            kind: "done",
            sessionId: event.sessionId,
            finalText: typeof event.finalText === "string" ? event.finalText.slice(0, 100_000) : undefined,
          }
        : null;
    case "error":
    case "warning":
      return typeof event.message === "string"
        ? { kind: "error", message: event.message.slice(0, 500) }
        : null;
    default:
      return null;
  }
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
