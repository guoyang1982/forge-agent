import { describe, expect, it } from "vitest";
import { webFetch } from "./web-fetch.js";

describe("webFetch", () => {
  it("extracts html text via mock fetch", async () => {
    const html = "<html><head><title>T</title></head><body><p>Hi</p></body></html>";
    const result = await webFetch("https://example.com", {
      fetchImpl: async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    expect(result.ok).toBe(true);
    expect(result.title).toBe("T");
    expect(result.content).toContain("Hi");
  });
});
