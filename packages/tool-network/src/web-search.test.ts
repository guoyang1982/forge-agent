import { describe, expect, it, vi } from "vitest";
import { webSearch } from "./web-search.js";

describe("webSearch", () => {
  it("returns error for empty query", async () => {
    const result = await webSearch("  ");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/required/i);
  });

  it("searches via mock tavily provider", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Docs",
              url: "https://example.com/docs",
              content: "Hello",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await webSearch("forge agent network", {
      service: { searchProvider: "tavily", searchApiKey: "tvly-test" },
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("tavily");
    expect(result.results?.[0]?.url).toBe("https://example.com/docs");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
