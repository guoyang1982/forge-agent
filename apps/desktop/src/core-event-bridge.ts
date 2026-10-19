import { agentEventFromEnvelope } from "@forge/daemon-client";
import type { AgentEvent, EventEnvelope } from "@forge/protocol";

/** Unwrap a durable `agent.event` CoreEvent into the renderer AgentEvent stream. */
export function agentEventFromCoreNotification(
  event: EventEnvelope,
): AgentEvent | null {
  if (event.type !== "agent.event") return null;
  return agentEventFromEnvelope(event);
}
