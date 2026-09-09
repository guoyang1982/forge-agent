import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeWorkArtifactFile } from "./artifact-files.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("writeWorkArtifactFile", () => {
  it("writes markdown under company/work/item and returns the relative path", () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "forge-artifact-"));
    roots.push(artifactRoot);
    const relative = writeWorkArtifactFile({
      artifactRoot,
      companyId: "company_a",
      workItemId: "work_b",
      kind: "intent",
      content: "给 SSH 客户端出团队版：窗格一键最大化",
    });
    expect(relative).toBe("company_a/work/work_b/intent.md");
    expect(readFileSync(join(artifactRoot, "company_a", "work", "work_b", "intent.md"), "utf8")).toBe(
      "给 SSH 客户端出团队版：窗格一键最大化",
    );
  });
});
