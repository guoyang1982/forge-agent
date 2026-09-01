import { describe, expect, it } from "vitest";
import {
  buildDynamicStatus,
  formatDynamicStatusTail,
} from "./dynamic-status.js";

describe("buildDynamicStatus", () => {
  it("normalizes run status fields", () => {
    const status = buildDynamicStatus({
      runId: "run-1",
      currentStepId: "step-2",
      modifiedFiles: ["packages/execution/src/store.ts"],
      failures: ["validation failed"],
      remainingWork: ["release approval"],
    });
    expect(status.retryCount).toBe(0);
    expect(formatDynamicStatusTail(status)).toContain("packages/execution/src/store.ts");
    expect(formatDynamicStatusTail(status)).toContain("validation failed");
    expect(formatDynamicStatusTail(status)).toContain("remaining: release approval");
  });
});
