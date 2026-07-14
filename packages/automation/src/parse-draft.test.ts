import { describe, expect, it } from "vitest";
import {
  parseAutomationDraftFromJson,
  parseAutomationDraftHeuristic,
} from "./parse-draft.js";

describe("parseAutomationDraftHeuristic", () => {
  it("parses every N minutes schedule with informal wording", () => {
    const result = parseAutomationDraftHeuristic(
      "每3分钟收集最新AI编程咨询个我，top3",
      "/tmp/proj",
    );
    expect(result.draft?.cron).toBe("*/3 * * * *");
    expect(result.draft?.prompt).toMatch(/AI编程/);
  });

  it("parses every N minutes schedule", () => {
    const result = parseAutomationDraftHeuristic(
      "每3分钟收集AI编程信息，给我发3条",
      "/tmp/proj",
    );
    expect(result.draft).toMatchObject({
      cron: "*/3 * * * *",
      timezone: "Asia/Shanghai",
      prompt: "收集AI编程信息，给我发3条",
    });
    expect(result.draft?.name).toContain("收集AI编程信息");
  });

  it("enables ilink notification when the request asks to send results", () => {
    const result = parseAutomationDraftHeuristic(
      "每3分钟收集AI编程信息，然后通过微信发给我",
      "/tmp/proj",
    );
    expect(result.draft?.notify).toEqual({
      enabled: true,
      channelKind: "ilink",
    });
  });

  it("parses hourly Chinese schedule and task", () => {
    const result = parseAutomationDraftHeuristic(
      "我想创建一个定时自动化，每小时收集行业AI信息",
      "/tmp/proj",
    );
    expect(result.draft).toMatchObject({
      cron: "0 * * * *",
      timezone: "Asia/Shanghai",
      cwd: "/tmp/proj",
      enabled: true,
    });
    expect(result.draft?.prompt).toContain("收集行业AI信息");
    expect(result.draft?.name).not.toMatch(/^我想创建/);
  });

  it("parses weekday morning schedule", () => {
    const result = parseAutomationDraftHeuristic(
      "每个工作日早上9点检查 README 与未关闭 issue",
      "/repo",
    );
    expect(result.draft?.cron).toBe("0 9 * * 1-5");
  });

  it("asks for details on meta create prompt", () => {
    const result = parseAutomationDraftHeuristic(
      "我想创建一个定时自动化，请帮我整理名称、cron 表达式和任务 prompt。",
    );
    expect(result.questions?.length).toBeGreaterThan(0);
    expect(result.draft).toBeUndefined();
  });
});

describe("parseAutomationDraftFromJson", () => {
  it("parses LLM JSON draft", () => {
    const result = parseAutomationDraftFromJson(
      `\`\`\`json
{"draft":{"name":"AI digest","cron":"0 * * * *","timezone":"Asia/Shanghai","prompt":"Collect AI news"},"questions":[]}
\`\`\``,
      "/ws",
    );
    expect(result?.draft).toMatchObject({
      name: "AI digest",
      cron: "0 * * * *",
      prompt: "Collect AI news",
      cwd: "/ws",
    });
  });

  it("returns questions when LLM asks for clarification", () => {
    const result = parseAutomationDraftFromJson(
      '{"questions":["请说明每天几点运行？"]}',
    );
    expect(result?.questions).toEqual(["请说明每天几点运行？"]);
  });
});
