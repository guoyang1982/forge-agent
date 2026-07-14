import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@forge/protocol";
import { permissionService } from "./permission-service.js";

export type ExternalRuntimePermissionKind = "codex" | "claude-code";

export interface ExternalRuntimePermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

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

export function defaultExternalPermissionOptions(
  providerLabel: string,
): ExternalRuntimePermissionOption[] {
  return [
    { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
    {
      optionId: "allow-session",
      name: `本会话总是允许 (${providerLabel})`,
      kind: "allow_always",
    },
    { optionId: "deny", name: "拒绝", kind: "reject_once" },
  ];
}

export function parseExternalPermissionOptions(
  raw: unknown,
  providerLabel: string,
): ExternalRuntimePermissionOption[] {
  if (!Array.isArray(raw)) return defaultExternalPermissionOptions(providerLabel);
  const parsed = raw
    .filter(isRecord)
    .map((item) => ({
      optionId: String(item.optionId ?? item.id ?? item.decision ?? ""),
      name: String(item.name ?? item.label ?? item.optionId ?? item.decision ?? "Option"),
      kind: typeof item.kind === "string" ? item.kind : undefined,
    }))
    .filter((item) => item.optionId);
  return parsed.length ? parsed : defaultExternalPermissionOptions(providerLabel);
}

export function mapCodexDecision(optionId: string): string {
  switch (optionId) {
    case "allow-session":
      return "acceptForSession";
    case "deny":
      return "decline";
    case "cancel":
      return "cancel";
    case "allow-once":
    default:
      return "accept";
  }
}

export function buildCodexApprovalSummary(
  method: string,
  params: Record<string, unknown>,
): string {
  const command = readString(params, ["command"]);
  if (command) return `执行命令: ${command}`;
  const reason = readString(params, ["reason"]);
  if (method.includes("fileChange")) {
    return reason ? `修改文件: ${reason}` : "修改文件";
  }
  if (method.includes("permissions")) {
    return reason ? `请求权限: ${reason}` : "请求额外权限";
  }
  if (method.includes("tool")) {
    const title = readString(params, ["title", "name"]);
    return title ? `工具授权: ${title}` : "工具需要授权";
  }
  return reason ?? `Codex 需要授权 (${method})`;
}

export function buildClaudeApprovalSummary(request: Record<string, unknown>): string {
  const toolName = readString(request, ["tool_name", "toolName"]) ?? "tool";
  const input = isRecord(request.input) ? request.input : {};
  const command = readString(input, ["command"]);
  if (command) return `${toolName}: ${command}`;
  const filePath = readString(input, ["file_path", "path"]);
  if (filePath) return `${toolName}: ${filePath}`;
  return `${toolName} 需要授权`;
}

export function createExternalRuntimePermissionBridge(options: {
  emit: (event: AgentEvent) => void;
  sessionId: string;
  signal?: AbortSignal;
  kind: ExternalRuntimePermissionKind;
  providerLabel: string;
}): {
  requestDecision: (
    summary: string,
    detail: Record<string, unknown>,
    permissionOptions?: ExternalRuntimePermissionOption[],
  ) => Promise<string>;
} {
  return {
    async requestDecision(summary, detail, permissionOptions) {
      const id = randomUUID();
      const opts =
        permissionOptions?.length
          ? permissionOptions
          : defaultExternalPermissionOptions(options.providerLabel);

      options.emit({
        type: "permission_request",
        sessionId: options.sessionId,
        id,
        kind: options.kind,
        summary,
        detail,
        options: opts,
      });

      const decision = await permissionService.waitForResponse(id, {
        sessionId: options.sessionId,
        signal: options.signal,
      });

      if (decision.optionId) return decision.optionId;
      if (!decision.approved) return "deny";
      if (decision.remember) return "allow-session";
      return "allow-once";
    },
  };
}
