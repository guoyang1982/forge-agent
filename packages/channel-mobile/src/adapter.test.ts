import { describe, expect, it } from "vitest";
import { validateDeviceProjectGrants } from "./adapter.js";

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
