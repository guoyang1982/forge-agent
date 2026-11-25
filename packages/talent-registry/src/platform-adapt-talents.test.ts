import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listTalentTemplates } from "./index.js";

const templatesDir = join(import.meta.dirname, "..", "templates");

describe("platform adapt talents", () => {
  it("registers draft adapters without publish tools", async () => {
    const templates = await listTalentTemplates(templatesDir);
    const toutiao = templates.find((item) => item.id === "toutiao-article-adapter");
    const xiaohongshu = templates.find((item) => item.id === "xiaohongshu-note-adapter");
    expect(toutiao).toMatchObject({
      schemaVersion: 2,
      category: "marketing",
      role: "头条稿件适配",
      sourcePath: "marketing/toutiao-article-adapter.md",
      connectors: [],
      suggestedSkills: ["adapt-toutiao-article"],
      suggestedTools: [],
    });
    expect(xiaohongshu).toMatchObject({
      schemaVersion: 2,
      category: "marketing",
      role: "小红书稿件适配",
      sourcePath: "marketing/xiaohongshu-note-adapter.md",
      connectors: [],
      suggestedSkills: ["adapt-xiaohongshu-note"],
      suggestedTools: [],
    });
    for (const talent of [toutiao, xiaohongshu]) {
      expect(talent?.qualityGates?.join("\n")).toContain("不调用发布工具");
      expect(talent?.systemPrompt).toContain("不发布");
      expect(talent?.systemPrompt).not.toContain("connector_publish");
    }
    for (const name of ["toutiao-article-adapter.json", "xiaohongshu-note-adapter.json"]) {
      const text = await readFile(join(templatesDir, name), "utf8");
      expect(text).not.toContain("connector_publish");
      expect(text).not.toContain("connector_list_publish_accounts");
    }
  });
});
