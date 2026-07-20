import { describe, expect, it } from "vitest";
import {
  listCodexModes,
  normalizeCodexApprovalPolicy,
} from "./codex-runtime.js";

describe("normalizeCodexApprovalPolicy", () => {
  it("keeps valid Codex approval policies", () => {
    expect(normalizeCodexApprovalPolicy("on-request")).toBe("on-request");
    expect(normalizeCodexApprovalPolicy("untrusted")).toBe("untrusted");
    expect(normalizeCodexApprovalPolicy("never")).toBe("never");
    expect(normalizeCodexApprovalPolicy("granular")).toBe("granular");
  });

  it("maps Cursor/Claude-style modes to on-request", () => {
    expect(normalizeCodexApprovalPolicy("default")).toBe("on-request");
    expect(normalizeCodexApprovalPolicy("plan")).toBe("on-request");
    expect(normalizeCodexApprovalPolicy("ask")).toBe("on-request");
    expect(normalizeCodexApprovalPolicy("")).toBe("on-request");
    expect(normalizeCodexApprovalPolicy(undefined)).toBe("on-request");
  });

  it("exposes Codex modes for runtime.list", () => {
    const modes = listCodexModes();
    expect(modes.some((mode) => mode.id === "on-request" && mode.isDefault)).toBe(true);
    expect(modes.map((mode) => mode.id)).toEqual([
      "on-request",
      "untrusted",
      "never",
      "granular",
    ]);
  });
});
