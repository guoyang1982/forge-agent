import { describe, expect, it } from "vitest";
import { parseDuckDuckGoHtml } from "./duckduckgo.js";

describe("parseDuckDuckGoHtml", () => {
  it("extracts title and redirect URL from result markup", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Title</a>
      <a class="result__snippet">A short snippet.</a>
    `;
    const hits = parseDuckDuckGoHtml(html, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("Example Title");
    expect(hits[0]?.url).toBe("https://example.com/page");
    expect(hits[0]?.snippet).toBe("A short snippet.");
  });

  it("respects limit", () => {
    const html = `
      <a class="result__a" href="https://a.test">A</a>
      <a class="result__a" href="https://b.test">B</a>
      <a class="result__a" href="https://c.test">C</a>
    `;
    expect(parseDuckDuckGoHtml(html, 2)).toHaveLength(2);
  });
});
