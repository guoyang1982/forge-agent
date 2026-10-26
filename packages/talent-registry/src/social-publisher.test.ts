import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listTalentTemplates } from "./index.js";

const templatesDir = join(import.meta.dirname, "..", "templates");
const forbidden = /小红书|抖音|头条|xiaohongshu|douyin|toutiao|titleMax|图片张数/i;

describe("social-publisher", () => {
  it("registers a channel-agnostic publisher talent", async () => {
    const templates = await listTalentTemplates(templatesDir);
    const talent = templates.find((item) => item.id === "social-publisher");
    expect(talent).toMatchObject({
      schemaVersion: 2,
      category: "marketing",
      role: "社交发布专家",
      sourcePath: "marketing/social-publisher.md",
      connectors: [],
      suggestedSkills: ["publishing-social-post"],
      suggestedTools: ["connector.publish", "connector.list_publish_accounts"],
    });
    expect(talent?.methodology?.join("\n")).toContain("payload");
    expect(talent?.qualityGates?.join("\n")).toContain("payload");
    expect(talent?.systemPrompt).toContain("payload");
    const text = await readFile(join(templatesDir, "social-publisher.json"), "utf8");
    expect(text).not.toMatch(forbidden);
  });
});
