import { describe, expect, it } from "vitest";
import { ContextCompressor, longContextFixture } from "./index.js";

describe("@forge/context compression re-exports", () => {
  it("re-exports ContextCompressor from agent-core", () => {
    const compressor = new ContextCompressor();
    expect(compressor.compact(longContextFixture()).retainedRefs.length).toBeGreaterThan(0);
  });
});
