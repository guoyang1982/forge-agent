import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceGuard } from "./index.js";

describe("WorkspaceGuard.resolveSafe", () => {
  it("resolves paths inside workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-ws-"));
    writeFileSync(join(dir, "foo.txt"), "ok");
    const guard = new WorkspaceGuard(dir);
    expect(guard.resolveSafe("foo.txt")).toBe(join(dir, "foo.txt"));
  });

  it("blocks parent escape", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-ws-"));
    const guard = new WorkspaceGuard(dir);
    expect(() => guard.resolveSafe("../etc/passwd")).toThrow(/escapes/);
  });

  it("blocks symlink escape when target exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "forge-out-"));
    writeFileSync(join(outside, "secret.txt"), "x");
    try {
      symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    } catch {
      return; // skip if symlink not permitted
    }
    const guard = new WorkspaceGuard(dir);
    expect(() => guard.resolveSafe("link.txt")).toThrow(/escapes/);
  });
});
