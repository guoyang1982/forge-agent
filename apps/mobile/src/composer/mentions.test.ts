import { describe, expect, it } from "vitest";
import { extractMentionedPaths, formatMentionToken } from "./mentions.js";

describe("composer mentions", () => {
  it("formats mention tokens", () => {
    expect(formatMentionToken("src/a.ts")).toBe("`src/a.ts`");
  });

  it("extracts path-like backtick mentions", () => {
    expect(extractMentionedPaths("请看 `src/app.ts` 和 `README.md`，忽略 `普通词`")).toEqual([
      "src/app.ts",
      "README.md",
    ]);
  });

  it("dedupes and caps mentions", () => {
    const message = Array.from({ length: 25 }, (_, i) => `\`f${i}.ts\``).join(" ");
    expect(extractMentionedPaths(`${message} \`f0.ts\``)).toHaveLength(20);
  });
});
