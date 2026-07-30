import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@forge/protocol";
import type { NetworkConfirmRequest, SoftwareConfirmRequest } from "@forge/tools";
import { emitPermissionDismissedIfNeeded } from "./permission-dismiss.js";
import { permissionService } from "./permission-service.js";

export function createNetworkConfirmHandler(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  signal?: AbortSignal,
): (req: NetworkConfirmRequest) => Promise<boolean> {
  return async (req) => {
    const id = randomUUID();
    emit({
      type: "permission_request",
      sessionId,
      id,
      kind: "network",
      action: req.action,
      summary: req.summary,
      detail: req.detail,
    });
    const decision = await permissionService.waitForResponse(id, {
      sessionId,
      signal,
    });
    emitPermissionDismissedIfNeeded(emit, sessionId, id, decision);
    return decision.approved;
  };
}

export function createSoftwareConfirmHandler(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  signal?: AbortSignal,
): (req: SoftwareConfirmRequest) => Promise<boolean> {
  return async (req) => {
    const id = randomUUID();
    emit({
      type: "permission_request",
      sessionId,
      id,
      kind: "software",
      action: req.action,
      summary: req.summary,
      detail: req.detail,
    });
    const decision = await permissionService.waitForResponse(id, {
      sessionId,
      signal,
    });
    emitPermissionDismissedIfNeeded(emit, sessionId, id, decision);
    return decision.approved;
  };
}

/** Gate run_command behind a per-command confirmation with a session "always allow". */
export function createCommandConfirmHandler(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  signal?: AbortSignal,
): (command: string) => Promise<boolean> {
  return async (command) => {
    if (permissionService.isCommandAllowed(sessionId)) return true;
    const id = randomUUID();
    emit({
      type: "permission_request",
      sessionId,
      id,
      kind: "command",
      summary: command,
      detail: { command },
    });
    const decision = await permissionService.waitForResponse(id, {
      sessionId,
      signal,
    });
    emitPermissionDismissedIfNeeded(emit, sessionId, id, decision);
    if (decision.approved && decision.remember) {
      permissionService.allowCommandsForSession(sessionId);
    }
    return decision.approved;
  };
}

export function handlePermissionResponse(params: unknown): { ok: boolean } {
  const body = params as {
    id?: string;
    approved?: boolean;
    remember?: boolean;
    optionId?: string;
  };
  const id = body?.id?.trim();
  if (!id) throw new Error("id is required");
  const optionId = typeof body.optionId === "string" ? body.optionId.trim() : "";
  if (optionId) {
    const ok = permissionService.respond(id, true, false, optionId);
    return { ok };
  }
  const ok = permissionService.respond(
    id,
    Boolean(body.approved),
    Boolean(body.remember),
  );
  return { ok };
}
