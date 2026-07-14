import { describe, expect, it } from "vitest";
import { validateJsonLikeWrite } from "./json-write-guard.js";

describe("validateJsonLikeWrite", () => {
  it("accepts valid single JSON", () => {
    expect(validateJsonLikeWrite("a.json", '{"x":1}')).toEqual({ ok: true });
  });

  it("rejects concatenated JSON documents", () => {
    const r = validateJsonLikeWrite(
      "x.excalidraw",
      '{"type":"excalidraw"}\n{"type":"duplicate"}',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid JSON/i);
  });

  it("ignores non-json paths", () => {
    expect(validateJsonLikeWrite("a.ts", "not json")).toEqual({ ok: true });
  });
});
