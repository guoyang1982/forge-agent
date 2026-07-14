import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashContent, hashDirectory } from "./hash.js";

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "hub-hash-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("hashDirectory", () => {
  it("is stable for identical content regardless of file creation order", async () => {
    const a = makeTree({ "SKILL.md": "hello", "refs/x.md": "world" });
    const b = makeTree({ "refs/x.md": "world", "SKILL.md": "hello" });
    expect(await hashDirectory(a)).toBe(await hashDirectory(b));
  });

  it("changes when file content changes", async () => {
    const a = makeTree({ "SKILL.md": "one" });
    const b = makeTree({ "SKILL.md": "two" });
    expect(await hashDirectory(a)).not.toBe(await hashDirectory(b));
  });

  it("ignores skipped dirs like .git", async () => {
    const a = makeTree({ "SKILL.md": "x" });
    const b = makeTree({ "SKILL.md": "x", ".git/HEAD": "ref: refs/heads/main" });
    expect(await hashDirectory(a)).toBe(await hashDirectory(b));
  });

  it("hashContent returns a sha256-prefixed digest", () => {
    expect(hashContent("abc")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
