import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@forge/protocol";
import { buildConfigPatchFromDotKey } from "./config-set.js";

describe("buildConfigPatchFromDotKey", () => {
  it("sets permissions.automation.enabled", () => {
    const patch = buildConfigPatchFromDotKey(
      "permissions.automation.enabled",
      "true",
      DEFAULT_CONFIG,
    );
    expect(patch.permissions?.automation?.enabled).toBe(true);
  });

  it("sets permissions.automation.run level", () => {
    const patch = buildConfigPatchFromDotKey(
      "permissions.automation.run",
      "allow",
      DEFAULT_CONFIG,
    );
    expect(patch.permissions?.automation?.run).toBe("allow");
  });

  it("rejects invalid permission level", () => {
    expect(() =>
      buildConfigPatchFromDotKey(
        "permissions.automation.run",
        "maybe",
        DEFAULT_CONFIG,
      ),
    ).toThrow(/allow, confirm, or deny/);
  });

  it("rejects unknown key", () => {
    expect(() =>
      buildConfigPatchFromDotKey("permissions.nope.enabled", "true", DEFAULT_CONFIG),
    ).toThrow(/Unknown permissions section/);
  });
});
