import { describe, expect, it, vi } from "vitest";
import { resolveOpenPathCommand } from "@forge/platform";
import { openFileWithDefaultApp } from "./builtin.js";

describe("openFileWithDefaultApp", () => {
  it("passes the target path as a spawn argument instead of interpolating shell text", () => {
    const spawnImpl = vi.fn(() => ({ unref: vi.fn() }));
    const target = openFileWithDefaultApp(
      "/repo",
      'bad"name; touch /tmp/owned',
      spawnImpl,
    );

    const { command, args } = resolveOpenPathCommand(target);
    expect(target).toBe('/repo/bad"name; touch /tmp/owned');
    expect(spawnImpl).toHaveBeenCalledWith(command, args, {
      detached: true,
      stdio: "ignore",
      ...(command === "cmd" ? { windowsVerbatimArguments: true } : {}),
    });
  });
});
