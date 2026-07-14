import { describe, expect, it } from "vitest";
import {
  talentArtifactDirRelPath,
  talentArtifactRelPath,
  talentArtifactSlug,
} from "./artifacts.js";

describe("talentArtifactSlug", () => {
  it("strips @ and lowercases", () => {
    expect(talentArtifactSlug("@Game-Designer")).toBe("game-designer");
  });

  it("neutralizes path traversal and unsafe characters", () => {
    expect(talentArtifactSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(talentArtifactSlug("a/b\\c")).toBe("a-b-c");
  });

  it("falls back to a default for empty/garbage input", () => {
    expect(talentArtifactSlug("   ")).toBe("talent");
    expect(talentArtifactSlug("///")).toBe("talent");
  });
});

describe("talentArtifactRelPath", () => {
  it("builds a stable workspace-relative path under .forge", () => {
    expect(talentArtifactRelPath(2, "game-designer")).toBe(
      ".forge/talent-artifacts/2/game-designer.md",
    );
  });

  it("clamps invalid turn indexes to 0", () => {
    expect(talentArtifactRelPath(-5, "nova")).toBe(
      ".forge/talent-artifacts/0/nova.md",
    );
    expect(talentArtifactRelPath(Number.NaN, "nova")).toBe(
      ".forge/talent-artifacts/0/nova.md",
    );
  });

  it("dir path is the parent of the file path", () => {
    const dir = talentArtifactDirRelPath(3);
    expect(talentArtifactRelPath(3, "lumi").startsWith(`${dir}/`)).toBe(true);
  });
});
