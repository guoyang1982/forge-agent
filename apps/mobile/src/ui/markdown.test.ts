import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks } from "./markdown-parse.js";

describe("MarkdownBody parser", () => {
  it("parses headings, bold, lists, and fenced code blocks", () => {
    const blocks = parseMarkdownBlocks([
      "## 结论",
      "",
      "Port **18789** is open.",
      "",
      "- first",
      "- second",
      "",
      "```bash",
      "lsof -i :18789",
      "```",
    ].join("\n"));

    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "结论" },
      { kind: "paragraph", text: "Port **18789** is open." },
      { kind: "list", ordered: false, items: ["first", "second"] },
      { kind: "code", language: "bash", code: "lsof -i :18789" },
    ]);
  });

  it("parses markdown tables", () => {
    const blocks = parseMarkdownBlocks([
      "| Name | Value |",
      "| --- | ---: |",
      "| port | 18789 |",
      "| ok | yes |",
    ].join("\n"));
    expect(blocks).toEqual([
      {
        kind: "table",
        headers: ["Name", "Value"],
        rows: [
          ["port", "18789"],
          ["ok", "yes"],
        ],
      },
    ]);
  });
});
