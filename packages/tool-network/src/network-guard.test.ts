import { describe, expect, it } from "vitest";
import { DEFAULT_PERMISSIONS } from "@forge/protocol";
import { checkNetworkPermission } from "./network-guard.js";

describe("network-guard", () => {
  it("denies when network disabled", () => {
    const result = checkNetworkPermission(
      { ...DEFAULT_PERMISSIONS.network, enabled: false },
      "web",
      { url: "https://example.com" },
    );
    expect(result.ok).toBe(false);
  });

  it("requires confirm for web when configured", () => {
    const result = checkNetworkPermission(
      { ...DEFAULT_PERMISSIONS.network, web: "confirm" },
      "web",
      { url: "https://example.com" },
    );
    expect(result.ok).toBe("confirm");
  });

  it("allows public https when web is allow", () => {
    const result = checkNetworkPermission(
      DEFAULT_PERMISSIONS.network,
      "web",
      { url: "https://example.com" },
    );
    expect(result.ok).toBe(true);
  });

  it("denies blocked hosts", () => {
    const result = checkNetworkPermission(
      DEFAULT_PERMISSIONS.network,
      "web",
      { url: "http://127.0.0.1/admin" },
    );
    expect(result.ok).toBe(false);
  });
});
