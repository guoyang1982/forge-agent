import { describe, expect, it } from "vitest";
import {
  buildCodexApprovalSummary,
  mapCodexDecision,
} from "./external-runtime-permission.js";
import {
  codexOptionsFromParams,
  isCodexApprovalMethod,
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

  it("exposes Codex modes for runtime.list with clarifying labels", () => {
    const modes = listCodexModes();
    expect(modes.some((mode) => mode.id === "on-request" && mode.isDefault)).toBe(true);
    expect(modes.map((mode) => mode.id)).toEqual([
      "on-request",
      "untrusted",
      "never",
      "granular",
    ]);
    expect(modes.find((mode) => mode.id === "on-request")?.label).toMatch(/自动执行/);
    expect(modes.find((mode) => mode.id === "untrusted")?.label).toMatch(/需确认/);
  });
});

describe("Codex approval → mobile permission card bridge", () => {
  it("recognizes Codex app-server approval request methods", () => {
    expect(isCodexApprovalMethod("item/commandExecution/requestApproval")).toBe(true);
    expect(isCodexApprovalMethod("item/fileChange/requestApproval")).toBe(true);
    expect(isCodexApprovalMethod("item/permissions/requestApproval")).toBe(true);
    expect(isCodexApprovalMethod("item/commandExecution/outputDelta")).toBe(false);
    expect(isCodexApprovalMethod("turn/started")).toBe(false);
  });

  it("builds a command summary suitable for the sticky permission card", () => {
    expect(
      buildCodexApprovalSummary("item/commandExecution/requestApproval", {
        command: "touch /tmp/forge-permission-probe",
        reason: "write outside sandbox",
      }),
    ).toBe("执行命令: touch /tmp/forge-permission-probe");
    expect(
      buildCodexApprovalSummary("item/fileChange/requestApproval", {
        reason: "edit README.md",
      }),
    ).toBe("修改文件: edit README.md");
  });

  it("maps availableDecisions to 允许一次 / 本会话总是允许 / 拒绝", () => {
    const options = codexOptionsFromParams({
      availableDecisions: ["accept", "acceptForSession", "decline"],
    });
    expect(options).toEqual([
      { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
      { optionId: "allow-session", name: "本会话总是允许", kind: "allow_always" },
      { optionId: "deny", name: "拒绝", kind: "reject_once" },
    ]);
    expect(mapCodexDecision("allow-once")).toBe("accept");
    expect(mapCodexDecision("allow-session")).toBe("acceptForSession");
    expect(mapCodexDecision("deny")).toBe("decline");
  });

  it("falls back to default Codex options when availableDecisions is omitted", () => {
    const options = codexOptionsFromParams({});
    expect(options.map((item) => item.optionId)).toEqual([
      "allow-once",
      "allow-session",
      "deny",
    ]);
  });
});
