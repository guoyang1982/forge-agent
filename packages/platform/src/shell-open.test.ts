import { describe, expect, it } from "vitest";
import { resolveOpenPathCommand } from "./shell-open.js";

describe("resolveOpenPathCommand", () => {
  it("uses open on macOS", () => {
    const prev = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(resolveOpenPathCommand("/tmp/a.txt")).toEqual({
        command: "open",
        args: ["/tmp/a.txt"],
      });
    } finally {
      Object.defineProperty(process, "platform", { value: prev });
    }
  });

  it("uses cmd start on Windows", () => {
    const prev = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(resolveOpenPathCommand('C:\\tmp\\a"b.txt')).toEqual({
        command: "cmd",
        args: ["/c", "start", "", 'C:\\tmp\\a"b.txt'],
        windowsVerbatimArguments: true,
      });
    } finally {
      Object.defineProperty(process, "platform", { value: prev });
    }
  });

  it("uses xdg-open on Linux", () => {
    const prev = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(resolveOpenPathCommand("/tmp/a.txt")).toEqual({
        command: "xdg-open",
        args: ["/tmp/a.txt"],
      });
    } finally {
      Object.defineProperty(process, "platform", { value: prev });
    }
  });
});
