import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@forge/protocol";
import { permissionService } from "./permission-service.js";

export type AcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export type AcpPermissionHandler = (
  params: Record<string, unknown>,
) => Promise<AcpPermissionOutcome>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const next = value[key];
    if (typeof next === "string" && next.length > 0) return next;
  }
  return null;
}

function parseAcpPermissionOptions(
  options: unknown,
): Array<{ optionId: string; name: string; kind?: string }> {
  if (!Array.isArray(options)) return [];
  return options
    .filter(isRecord)
    .map((option) => ({
      optionId: String(option.optionId ?? option.id ?? ""),
      name: String(option.name ?? option.label ?? option.optionId ?? "Option"),
      kind: typeof option.kind === "string" ? option.kind : undefined,
    }))
    .filter((option) => option.optionId);
}

function fallbackRejectOptionId(
  options: Array<{ optionId: string; name: string; kind?: string }>,
): string | null {
  const reject = options.find(
    (option) =>
      option.kind?.includes("reject") ||
      /deny|reject|拒绝/i.test(option.name),
  );
  return reject?.optionId ?? options[0]?.optionId ?? null;
}

export function createAcpPermissionHandler(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  signal?: AbortSignal,
): AcpPermissionHandler {
  return async (params) => {
    const id = randomUUID();
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const options = parseAcpPermissionOptions(params.options);
    const summary =
      readString(toolCall, ["title", "name"]) ?? "ACP 工具需要授权";

    emit({
      type: "permission_request",
      sessionId,
      id,
      kind: "acp",
      summary,
      detail: { toolCall, sessionId: params.sessionId },
      options,
    });

    const decision = await permissionService.waitForResponse(id, {
      sessionId,
      signal,
    });

    if (decision.optionId) {
      return { outcome: "selected", optionId: decision.optionId };
    }

    if (!decision.approved) {
      const rejectId = fallbackRejectOptionId(options);
      if (rejectId) return { outcome: "selected", optionId: rejectId };
      return { outcome: "cancelled" };
    }

    const allow =
      options.find((option) => option.kind?.includes("allow")) ??
      options.find((option) => /allow|允许|approve/i.test(option.name)) ??
      options[0];
    if (allow?.optionId) {
      return { outcome: "selected", optionId: allow.optionId };
    }
    return { outcome: "cancelled" };
  };
}
