import type { AgentEvent } from "@forge/protocol";
import type { PermissionDecision } from "./permission-service.js";

/** Emit UI cleanup when a permission waiter ends without user respond. */
export function emitPermissionDismissedIfNeeded(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  id: string,
  decision: PermissionDecision,
): void {
  if (!decision.dismissReason) return;
  emit({
    type: "permission_dismissed",
    sessionId,
    id,
    reason: decision.dismissReason,
  });
}
