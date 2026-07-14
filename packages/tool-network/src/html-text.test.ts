import { describe, expect, it } from "vitest";
import { extractHtmlTitle, htmlToText } from "./html-text.js";

describe("html-text", () => {
  it("extracts title and strips scripts", () => {
    const html = `<!DOCTYPE html><html><head><title>Hello &amp; World</title></head>
      <body><script>alert(1)</script><p>Line one</p><p>Line two</p></body></html>`;
    expect(extractHtmlTitle(html)).toBe("Hello & World");
    const text = htmlToText(html);
    expect(text).toContain("Line one");
    expect(text).toContain("Line two");
    expect(text).not.toContain("alert");
  });
});
