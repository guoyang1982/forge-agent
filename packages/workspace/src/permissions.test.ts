import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceGuard } from "./index.js";
import {
  canAccessPath,
  expandTildePath,
  isSensitivePath,
  isUnderRoot,
} from "./permissions.js";

describe("permissions", () => {
  it("expands tilde paths", () => {
    expect(expandTildePath("~/Documents")).toBe(
      resolve(homedir(), "Documents"),
    );
  });

  it("detects sensitive home paths", () => {
    expect(isSensitivePath(join(homedir(), ".ssh", "id_rsa"))).toBe(true);
    expect(isSensitivePath(join(homedir(), "Documents", "a.txt"))).toBe(false);
  });

  it("allows workspace and configured personal roots", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-ws-"));
    const personal = mkdtempSync(join(tmpdir(), "forge-personal-"));
    const file = join(personal, "note.txt");
    writeFileSync(file, "hello", "utf-8");
    const guard = await WorkspaceGuard.ensure(workspace, {
      allowedRoots: [personal],
    });
    expect(guard.resolveSafe(file)).toBe(resolve(file));
    expect(guard.resolveSafe(join(workspace, "src/a.ts"), "write")).toBe(
      resolve(workspace, "src/a.ts"),
    );
  });

  it("blocks paths outside workspace and allowed roots", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "forge-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "forge-out-"));
    const file = join(outside, "secret.txt");
    writeFileSync(file, "x", "utf-8");
    const guard = await WorkspaceGuard.ensure(workspace, { allowedRoots: [] });
    expect(() => guard.resolveSafe(file)).toThrow(/not allowed/);
  });

  it("allows skill roots for read only", () => {
    const cwd = "/tmp/project";
    const skillRoot = "/tmp/skills/demo";
    const skillFile = join(skillRoot, "SKILL.md");
    expect(
      canAccessPath({
        abs: skillFile,
        cwd,
        allowedRoots: [],
        skillRoots: [skillRoot],
        intent: "read",
      }),
    ).toBe(true);
    expect(
      canAccessPath({
        abs: skillFile,
        cwd,
        allowedRoots: [],
        skillRoots: [skillRoot],
        intent: "write",
      }),
    ).toBe(false);
  });

  it("isUnderRoot matches descendants", () => {
    const root = "/Users/alice/Documents";
    expect(isUnderRoot("/Users/alice/Documents/a/b.txt", root)).toBe(true);
    expect(isUnderRoot("/Users/alice/Downloads/x", root)).toBe(false);
  });
});
