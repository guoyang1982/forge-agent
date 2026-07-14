import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSearchProvider,
  pickSearchProviderId,
  resolveSearchApiKeys,
} from "./resolve-search-provider.js";

describe("resolveSearchApiKeys", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers TAVILY_API_KEY env", () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    expect(resolveSearchApiKeys({}).tavily).toBe("tvly-test");
  });

  it("uses generic key when provider is brave", () => {
    vi.stubEnv("FORGE_SEARCH_API_KEY", "brave-generic");
    expect(
      resolveSearchApiKeys({ searchProvider: "brave" }).brave,
    ).toBe("brave-generic");
  });
});

describe("pickSearchProviderId", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honors explicit searchProvider", () => {
    expect(pickSearchProviderId({ searchProvider: "duckduckgo" })).toBe(
      "duckduckgo",
    );
  });

  it("defaults to tavily when key present", () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    expect(pickSearchProviderId({})).toBe("tavily");
  });

  it("falls back to duckduckgo without keys", () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    expect(pickSearchProviderId({})).toBe("duckduckgo");
  });
});

describe("createSearchProvider", () => {
  it("throws when tavily selected without API key", () => {
    expect(() =>
      createSearchProvider({ service: { searchProvider: "tavily" } }),
    ).toThrow(/Tavily search requires/);
  });

  it("returns duckduckgo provider without keys", () => {
    const provider = createSearchProvider({
      service: { searchProvider: "duckduckgo" },
    });
    expect(provider.id).toBe("duckduckgo");
  });
});
