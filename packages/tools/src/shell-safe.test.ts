import { describe, it, expect } from "vitest";
import { validateShellCommand, parseCommandLine } from "./shell-safe.js";

describe("parseCommandLine", () => {
  it("parses quoted args", () => {
    expect(parseCommandLine('python3 "a b.py"')).toEqual([
      "python3",
      "a b.py",
    ]);
  });
});

describe("validateShellCommand", () => {
  it("allows python3 script", () => {
    const r = validateShellCommand("python3 game.py");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cmd.args).toEqual(["game.py"]);
  });

  it("rejects shell chaining", () => {
    expect(validateShellCommand("python3 x; rm -rf /").ok).toBe(false);
  });

  it("rejects pipe", () => {
    expect(validateShellCommand("python3 x | sh").ok).toBe(false);
  });

  it("allows git status", () => {
    const r = validateShellCommand("git status");
    expect(r.ok).toBe(true);
  });

  it("allows read-only git branch inspection", () => {
    expect(validateShellCommand("git branch").ok).toBe(true);
    expect(validateShellCommand("git branch -a").ok).toBe(true);
    expect(validateShellCommand("git branch --list feature-retain-refactor").ok).toBe(true);
  });

  it("rejects branch creation and deletion", () => {
    expect(validateShellCommand("git branch feature-retain-refactor").ok).toBe(false);
    expect(validateShellCommand("git branch -D feature-retain-refactor").ok).toBe(false);
  });

  it("allows read-only git log inspection", () => {
    expect(validateShellCommand("git log --oneline -n 20").ok).toBe(true);
    expect(validateShellCommand("git log main..origin/feature-retain-refactor --stat").ok).toBe(true);
  });

  it("allows git diff branch ranges without allowing path traversal", () => {
    expect(validateShellCommand("git diff main...origin/feature-retain-refactor").ok).toBe(true);
    expect(validateShellCommand("git diff ../../outside").ok).toBe(false);
    expect(validateShellCommand("git log ../../outside").ok).toBe(false);
  });

  it("allows git fetch from a named remote branch", () => {
    const r = validateShellCommand("git fetch origin optimize-common-refund");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cmd.file).toBe("git");
      expect(r.cmd.args).toEqual(["fetch", "origin", "optimize-common-refund"]);
    }
  });

  it("allows git fetch maintenance flags", () => {
    expect(validateShellCommand("git fetch --all --prune").ok).toBe(true);
  });

  it("rejects unsafe git fetch options", () => {
    expect(
      validateShellCommand("git fetch --upload-pack=/tmp/evil origin main").ok,
    ).toBe(false);
  });

  it("rejects git checkout", () => {
    expect(validateShellCommand("git checkout main").ok).toBe(false);
  });

  it("rejects semicolon chaining", () => {
    expect(validateShellCommand("git status; rm -rf /").ok).toBe(false);
  });

  it("allows python3 -c with semicolon inside quotes", () => {
    const r = validateShellCommand(
      'python3 -c "import os; os.remove(\'/tmp/x\')"',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cmd.file).toBe("python3");
      expect(r.cmd.args[0]).toBe("-c");
      expect(r.cmd.args[1]).toContain("import os;");
    }
  });

  it("allows python3 -c with single-quoted script", () => {
    const r = validateShellCommand("python3 -c 'print(1); print(2)'");
    expect(r.ok).toBe(true);
  });

  it("allows python3 -c without quotes by normalizing code args", () => {
    const r = validateShellCommand("python3 -c import py_compile; py_compile.compile('x.py')");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cmd.args[0]).toBe("-c");
      expect(r.cmd.args[1]).toContain("import py_compile;");
      expect(r.cmd.args.length).toBe(2);
    }
  });
});
