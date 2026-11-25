import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills } from "./index.js";

const skillsDir = join(import.meta.dirname, "..", "..", "..", "skills");
const forbidden = /小红书|抖音|头条|xiaohongshu|douyin|toutiao|titleMax|图片张数/i;

describe("publishing-social-post", () => {
  it("loads a channel-agnostic publish skill", async () => {
    const skills = await loadSkills(skillsDir);
    const skill = skills.find((item) => item.id === "publishing-social-post");
    expect(skill?.description).toContain("payload");
    const text = await readFile(join(skillsDir, "publishing-social-post", "SKILL.md"), "utf8");
    expect(text).toContain("connector_publish");
    expect(text).toContain("connector_list_publish_accounts");
    expect(text).toContain("payload");
    expect(text).not.toMatch(forbidden);
  });
});
