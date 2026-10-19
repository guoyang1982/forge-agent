import { describe, expect, it } from "vitest";
import { parseForgeDeepLink, serializeForgeDeepLink } from "./index.js";

describe("parseForgeDeepLink", () => {
  it("parses workbench run and company work links", () => {
    expect(parseForgeDeepLink("forge://workbench/run/r_8f21")).toEqual({
      app: "workbench",
      kind: "run",
      id: "r_8f21",
    });
    expect(parseForgeDeepLink("forge://company/work/WI-118")).toEqual({
      app: "company",
      kind: "work",
      id: "WI-118",
    });
    expect(parseForgeDeepLink("forge://company/home")).toEqual({
      app: "company",
      kind: "home",
    });
  });

  it("rejects traversal and unknown apps", () => {
    expect(() => parseForgeDeepLink("forge://workbench/run/../secret")).toThrow(
      "invalid deep link",
    );
    expect(() => parseForgeDeepLink("forge://desktop/run/r1")).toThrow("invalid deep link");
    expect(() => parseForgeDeepLink("https://workbench/run/r1")).toThrow("invalid deep link");
  });

  it("round-trips", () => {
    const link = { app: "workbench", kind: "session", id: "s1" } as const;
    expect(parseForgeDeepLink(serializeForgeDeepLink(link))).toEqual(link);
  });
});
