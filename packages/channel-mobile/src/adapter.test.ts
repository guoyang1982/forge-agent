import { describe, expect, it } from "vitest";
import { isMobileV2OnlyMethod } from "@forge/mobile-protocol/v2";
import { validateDeviceProjectGrants } from "./adapter.js";

describe("Mobile adapter v2 routing contract", () => {
  it("treats run.resume as a v2-only control method", () => {
    expect(isMobileV2OnlyMethod("run.resume")).toBe(true);
  });
});

describe("Mobile device project grants", () => {
  it("deduplicates grants within the channel permission boundary", () => {
    expect(
      validateDeviceProjectGrants(
        ["/workspace/a", "/workspace/b"],
        ["/workspace/b", "/workspace/b"],
      ),
    ).toEqual(["/workspace/b"]);
  });

  it("rejects renderer attempts to expand beyond channel permissions", () => {
    expect(() =>
      validateDeviceProjectGrants(["/workspace/a"], ["/workspace/a", "/workspace/admin"]),
    ).toThrow("exceeds channel allowed projects");
  });
});
