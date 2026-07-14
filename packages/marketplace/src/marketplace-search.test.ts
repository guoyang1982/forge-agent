import { describe, expect, it } from "vitest";
import { parseSkillsShId } from "./skills-sh.js";
import { formatInstallCount, searchSkillsMarketplace } from "./marketplace-search.js";

describe("parseSkillsShId", () => {
  it("parses anthropics skill path", () => {
    expect(parseSkillsShId("anthropics/skills/frontend-design")).toEqual({
      repo: "anthropics/skills",
      subdir: "skills/frontend-design",
    });
  });

  it("parses vercel agent-skills path", () => {
    expect(parseSkillsShId("vercel-labs/agent-skills/web-design-guidelines")).toEqual({
      repo: "vercel-labs/agent-skills",
      subdir: "skills/web-design-guidelines",
    });
  });

  it("parses flat repo skill id", () => {
    expect(parseSkillsShId("vercel-labs/next-skills/next-best-practices")).toEqual({
      repo: "vercel-labs/next-skills",
      subdir: "next-best-practices",
    });
  });
});

describe("formatInstallCount", () => {
  it("formats thousands and millions", () => {
    expect(formatInstallCount(146100)).toBe("146.1K");
    expect(formatInstallCount(1845259)).toBe("1.8M");
  });
});

describe("searchSkillsMarketplace", () => {
  it("returns featured items without query", async () => {
    const res = await searchSkillsMarketplace({ mode: "featured" });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.some((i) => i.id === "excalidraw-diagram")).toBe(true);
  });
});
