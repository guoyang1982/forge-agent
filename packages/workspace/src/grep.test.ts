import { describe, it, expect } from "vitest";
import { parseRgJson } from "./grep.js";

describe("parseRgJson", () => {
  it("counts match lines", () => {
    const stdout = [
      '{"type":"match","data":{"path":{"text":"a.py"},"line_number":1,"lines":{"text":"foo"}}}',
      '{"type":"match","data":{"path":{"text":"b.py"},"line_number":2,"lines":{"text":"bar"}}}',
    ].join("\n");
    const r = parseRgJson(stdout);
    expect(r.matchCount).toBe(2);
    expect(r.preview).toContain("a.py:1");
  });

  it("returns zero for empty", () => {
    const r = parseRgJson("");
    expect(r.matchCount).toBe(0);
  });
});
