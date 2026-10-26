import { describe, expect, it } from "vitest";
import { routePublishRequest, type ConnectorRouteView, type PublishRequest } from "./route.js";

const view: ConnectorRouteView = {
  connectorFound: true,
  capabilities: ["publish"],
  account: { id: "account-1", connectorId: "connector-1", health: "connected" },
};

function request(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    connectorId: "connector-1",
    connectorAccountId: "account-1",
    idempotencyKey: "key-1",
    payload: { title: "x".repeat(500), images: [] },
    ...overrides,
  };
}

describe("routePublishRequest", () => {
  it("accepts any payload when the account can publish", () => {
    expect(routePublishRequest(request(), view)).toBeNull();
    expect(routePublishRequest(request({ payload: {} }), view)).toBeNull();
  });

  it("returns capability_unavailable when the connector is missing or cannot publish", () => {
    expect(routePublishRequest(request(), { ...view, connectorFound: false })?.status).toBe(
      "capability_unavailable",
    );
    expect(routePublishRequest(request(), { ...view, capabilities: [] })?.status).toBe(
      "capability_unavailable",
    );
  });

  it("returns account_not_found for a missing or mismatched account", () => {
    expect(routePublishRequest(request(), { ...view, account: null })?.status).toBe(
      "account_not_found",
    );
    expect(
      routePublishRequest(request(), {
        ...view,
        account: { id: "account-1", connectorId: "other", health: "connected" },
      })?.status,
    ).toBe("account_not_found");
  });

  it("returns needs_auth unless health is connected", () => {
    expect(
      routePublishRequest(request(), {
        ...view,
        account: { id: "account-1", connectorId: "connector-1", health: "needs_auth" },
      })?.status,
    ).toBe("needs_auth");
  });

  it("returns invalid_request when the idempotency key is blank", () => {
    expect(routePublishRequest(request({ idempotencyKey: " " }), view)).toMatchObject({
      status: "invalid_request",
      reason: "empty_idempotency_key",
    });
  });
});
