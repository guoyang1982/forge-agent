import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown-preview-entry.js";

describe("company markdown preview", () => {
  it("renders headings, emphasis, and GFM tables instead of raw tags", () => {
    const html = renderMarkdown([
      "# 结论",
      "",
      "判断为 **有条件可行**。",
      "",
      "| 底线 | 结果 |",
      "| --- | --- |",
      "| 技术 | 通过 |",
    ].join("\n"));

    expect(html).toContain('class="md-preview"');
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>");
    expect(html).not.toContain("**有条件可行**");
    expect(html).not.toContain("| 底线 |");
  });

  it("strips script tags from generated reports", () => {
    const html = renderMarkdown('hello <script>alert(1)</script> **ok**');
    expect(html).not.toContain("<script>");
    expect(html).toContain("<strong>ok</strong>");
  });
});
