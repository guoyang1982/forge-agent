import { describe, expect, it } from "vitest";
import { defaultPackageManagers, formatPackageManagerHint } from "./package-managers.js";

describe("defaultPackageManagers", () => {
  it("returns brew on macOS", () => {
    const prev = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(defaultPackageManagers()).toEqual(["brew"]);
    } finally {
      Object.defineProperty(process, "platform", { value: prev });
    }
  });

  it("returns winget/choco on Windows", () => {
    const prev = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(defaultPackageManagers()).toEqual(["winget", "choco"]);
      expect(formatPackageManagerHint()).toContain("winget");
    } finally {
      Object.defineProperty(process, "platform", { value: prev });
    }
  });
});
