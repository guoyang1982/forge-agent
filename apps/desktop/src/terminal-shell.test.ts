import { describe, expect, it } from "vitest";
import {
  clampTerminalSize,
  resolveDefaultShell,
  resolvePipeShell,
  resolveSpawnCwd,
} from "./terminal-shell.js";

describe("resolveDefaultShell", () => {
  it("honors $SHELL on posix with login+interactive flags", () => {
    expect(resolveDefaultShell("darwin", { SHELL: "/bin/fish" })).toEqual({
      file: "/bin/fish",
      args: ["-l", "-i"],
    });
  });

  it("falls back to zsh on macOS and bash on linux", () => {
    expect(resolveDefaultShell("darwin", {}).file).toBe("/bin/zsh");
    expect(resolveDefaultShell("linux", {}).file).toBe("/bin/bash");
  });

  it("uses ComSpec/powershell on windows", () => {
    expect(resolveDefaultShell("win32", { ComSpec: "C:\\cmd.exe" })).toEqual({
      file: "C:\\cmd.exe",
      args: [],
    });
    expect(resolveDefaultShell("win32", {}).file).toBe("powershell.exe");
  });
});

describe("resolvePipeShell", () => {
  it("uses a non-interactive login shell on POSIX because pipes are not TTYs", () => {
    expect(resolvePipeShell("darwin", { SHELL: "/bin/zsh" })).toEqual({
      file: "/bin/zsh",
      args: ["-l"],
    });
  });

  it("matches the default shell on Windows", () => {
    expect(resolvePipeShell("win32", { ComSpec: "C:\\cmd.exe" })).toEqual({
      file: "C:\\cmd.exe",
      args: [],
    });
  });
});

describe("resolveSpawnCwd", () => {
  const exists = (p: string) => p === "/proj" || p === "/home/u";

  it("uses the requested cwd when it exists", () => {
    expect(resolveSpawnCwd("/proj", { HOME: "/home/u" }, exists)).toBe("/proj");
  });

  it("falls back to HOME when cwd is missing/blank", () => {
    expect(resolveSpawnCwd("", { HOME: "/home/u" }, exists)).toBe("/home/u");
    expect(resolveSpawnCwd("/gone", { HOME: "/home/u" }, exists)).toBe("/home/u");
    expect(resolveSpawnCwd(null, { HOME: "/home/u" }, exists)).toBe("/home/u");
  });

  it("falls back to / when nothing is available", () => {
    expect(resolveSpawnCwd("/gone", {}, exists)).toBe("/");
  });
});

describe("clampTerminalSize", () => {
  it("defaults invalid sizes to 80x24", () => {
    expect(clampTerminalSize(undefined, undefined)).toEqual({ cols: 80, rows: 24 });
    expect(clampTerminalSize(0, -3)).toEqual({ cols: 80, rows: 24 });
    expect(clampTerminalSize("x", NaN)).toEqual({ cols: 80, rows: 24 });
  });

  it("passes through and floors valid sizes", () => {
    expect(clampTerminalSize(120.9, 40.2)).toEqual({ cols: 120, rows: 40 });
  });

  it("caps absurd sizes", () => {
    expect(clampTerminalSize(99999, 99999)).toEqual({ cols: 1000, rows: 1000 });
  });
});
