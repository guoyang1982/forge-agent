import type { ConnectorRouteView, PublishRequest, PublishResult } from "./types.js";

export type { ConnectorRouteView, PublishRequest, PublishResult } from "./types.js";

export function routePublishRequest(
  request: PublishRequest,
  view: ConnectorRouteView,
): PublishResult | null {
  const base = {
    connectorId: request.connectorId,
    connectorAccountId: request.connectorAccountId,
  };
  const reject = (status: PublishResult["status"], reason?: string): PublishResult => ({
    ...base,
    status,
    reason,
  });
  if (!view.connectorFound || !view.capabilities.includes("publish")) {
    return reject("capability_unavailable");
  }
  if (!view.account || view.account.connectorId !== request.connectorId) {
    return reject("account_not_found");
  }
  if (view.account.health !== "connected") return reject("needs_auth");
  if (request.idempotencyKey.trim() === "") return reject("invalid_request", "empty_idempotency_key");
  return null;
}
