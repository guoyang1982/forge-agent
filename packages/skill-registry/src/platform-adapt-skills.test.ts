import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills } from "./index.js";

const skillsDir = join(import.meta.dirname, "..", "..", "..", "skills");

describe("platform adapt skills", () => {
  it("loads toutiao and xiaohongshu draft skills that do not publish", async () => {
    const skills = await loadSkills(skillsDir);
    const toutiao = skills.find((item) => item.id === "adapt-toutiao-article");
    const xiaohongshu = skills.find((item) => item.id === "adapt-xiaohongshu-note");
    expect(toutiao?.description).toContain("不发布");
    expect(xiaohongshu?.description).toContain("不发布");

    const toutiaoText = await readFile(join(skillsDir, "adapt-toutiao-article", "SKILL.md"), "utf8");
    const xiaohongshuText = await readFile(join(skillsDir, "adapt-xiaohongshu-note", "SKILL.md"), "utf8");
    expect(toutiaoText).toContain('{"title":"...","content":"..."}');
    expect(toutiaoText).toContain("2 到 30");
    expect(toutiaoText).toContain("images");
    expect(xiaohongshuText).toContain('{"note":"..."}');
    expect(xiaohongshuText).toContain("生成图片");
    expect(xiaohongshuText).toContain("12 个字");
    expect(xiaohongshuText).toContain("500 个字");
    expect(xiaohongshuText).toContain("再写一张");
    for (const text of [toutiaoText, xiaohongshuText]) {
      expect(text).not.toContain("connector_publish");
      expect(text).toContain("不调用发布工具");
      expect(text).toContain("社交发布专家");
    }
  });
});
