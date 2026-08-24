import { randomUUID } from "node:crypto";
import type { AgentEvent, AppsPermissions, PermissionLevel } from "@forge/protocol";
import type {
  McpServerRequest,
  McpServerRequestHandler,
} from "@forge/tool-mcp";
import { emitPermissionDismissedIfNeeded } from "./permission-dismiss.js";
import { permissionService } from "./permission-service.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringValue(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createMcpServerRequestHandler(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  signal?: AbortSignal,
  appsPermissions?: AppsPermissions,
): McpServerRequestHandler {
  return async (request: McpServerRequest) => {
    if (request.method !== "elicitation/create") {
      throw new Error(`Unsupported MCP server request: ${request.method}`);
    }

    const params = asRecord(request.params);
    const meta = asRecord(params._meta);
    const permissionScope = stringValue(meta, "permissionScope");
    const policy = resolveAppsPermissionPolicy(permissionScope, appsPermissions);
    if (policy === "allow") return { action: "accept", content: {} };
    if (policy === "deny") return { action: "decline" };
    const id = randomUUID();
    const summary = stringValue(params, "message") ?? "MCP 工具请求授权";
    emit({
      type: "permission_request",
      sessionId,
      id,
      kind: "mcp",
      summary,
      detail: {
        method: request.method,
        subtitle: stringValue(meta, "subtitle"),
        riskLevel: stringValue(meta, "riskLevel"),
        persist: Array.isArray(meta.persist) ? meta.persist : undefined,
        requestedSchema: params.requestedSchema,
      },
    });

    const decision = await permissionService.waitForResponse(id, {
      sessionId,
      signal,
    });
    emitPermissionDismissedIfNeeded(emit, sessionId, id, decision);

    return decision.approved
      ? { action: "accept", content: {} }
      : { action: decision.dismissReason ? "cancel" : "decline" };
  };
}

function resolveAppsPermissionPolicy(
  scope: string | undefined,
  permissions: AppsPermissions | undefined,
): PermissionLevel | undefined {
  if (!permissions || (scope !== "apps.open" && scope !== "apps.control")) {
    return undefined;
  }
  if (!permissions.enabled) return "deny";
  return scope === "apps.open" ? permissions.open : permissions.control;
}
