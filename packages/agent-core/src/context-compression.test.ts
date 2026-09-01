import { describe, expect, it } from "vitest";
import {
  ContextCompressor,
  longContextFixture,
} from "./context-compression.js";

describe("ContextCompressor", () => {
  it("keeps decisions paths failures validation and remaining work", () => {
    const compressor = new ContextCompressor();
    const compressed = compressor.compact(longContextFixture());
    expect(compressed.summary).toContain("architecture decision");
    expect(compressed.summary).toContain("packages/execution/src/store.ts");
    expect(compressed.summary).toContain("validation failed");
    expect(compressed.summary).toContain("remaining: release approval");
    expect(compressed.removedTokenEstimate).toBeGreaterThan(0);
  });

  it("opens the compression circuit after repeated model failures", async () => {
    const compressor = new ContextCompressor({
      modelFailureThreshold: 3,
      maxModelAttempts: 3,
    });
    let modelCalls = 0;
    await compressor.compactWithFallback(longContextFixture(), async () => {
      modelCalls += 1;
      throw new Error("model unavailable");
    });
    expect(modelCalls).toBe(3);
    expect(compressor.circuitState()).toBe("open");
  });
});

export function compressionFixture(options: { modelFailures: number }) {
  const compressor = new ContextCompressor({
    modelFailureThreshold: options.modelFailures,
    maxModelAttempts: options.modelFailures,
  });
  let modelCalls = 0;
  return {
    compressor,
    context: longContextFixture(),
    modelCalls: () => modelCalls,
    circuitState: () => compressor.circuitState(),
    compact: async () =>
      compressor.compactWithFallback(longContextFixture(), async () => {
        modelCalls += 1;
        throw new Error("model unavailable");
      }),
  };
}
