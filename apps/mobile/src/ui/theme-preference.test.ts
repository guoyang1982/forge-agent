import { describe, expect, it } from "vitest";
import { resolveThemePreference } from "../ui/theme-preference.js";

describe("resolveThemePreference", () => {
  it("keeps explicit palette ids", () => {
    expect(resolveThemePreference("ocean", "light")).toBe("ocean");
  });

  it("maps system to forge-light / forge-dark", () => {
    expect(resolveThemePreference("system", "light")).toBe("forge-light");
    expect(resolveThemePreference("system", "dark")).toBe("forge-dark");
    expect(resolveThemePreference("system", null)).toBe("forge-dark");
    expect(resolveThemePreference("system", "unspecified")).toBe("forge-dark");
  });
});
