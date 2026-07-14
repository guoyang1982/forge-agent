import { describe, expect, it } from "vitest";
import {
  buildInstallCommand,
  buildListCommand,
  buildUninstallCommand,
  pickManager,
} from "./managers.js";
import { checkSoftwarePermission } from "./software-guard.js";

describe("pickManager", () => {
  it("uses first allowed manager by default", () => {
    expect(pickManager(undefined, ["brew", "winget"])).toBe("brew");
  });

  it("rejects disallowed manager", () => {
    expect(pickManager("choco", ["brew"])).toBeNull();
  });
});

describe("build commands", () => {
  it("builds brew install", () => {
    expect(buildInstallCommand("brew", "ripgrep").summary).toBe("brew install ripgrep");
  });

  it("builds winget uninstall", () => {
    expect(buildUninstallCommand("winget", "Git.Git").summary).toContain(
      "winget uninstall --id Git.Git",
    );
  });

  it("builds brew outdated list", () => {
    expect(buildListCommand("brew", "outdated").argv).toEqual(["outdated", "--formula"]);
  });
});

describe("checkSoftwarePermission", () => {
  const base = {
    enabled: true,
    managers: ["brew"],
    install: "confirm" as const,
    uninstall: "confirm" as const,
  };

  it("allows list when enabled", () => {
    expect(checkSoftwarePermission(base, "list", { manager: "brew" }).ok).toBe(true);
  });

  it("requires confirm for install", () => {
    const result = checkSoftwarePermission(base, "install", {
      manager: "brew",
      package: "jq",
      command: "brew install jq",
    });
    expect(result.ok).toBe("confirm");
  });

  it("rejects when disabled", () => {
    expect(
      checkSoftwarePermission({ ...base, enabled: false }, "list", { manager: "brew" }).ok,
    ).toBe(false);
  });
});
