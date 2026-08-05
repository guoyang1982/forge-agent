import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPriorTalentResultsBlock,
  buildTalentSystemBlock,
  bundledTalentTemplatesDir,
  createTalentToolAllowance,
  createCustomTalentTemplate,
  createTalentTeam,
  deleteCustomTalentTemplate,
  deleteTalentTeam,
  ensureTalentTemplatesSeeded,
  extractTalentMentions,
  expandTalentTeamMessage,
  hireTalent,
  isTalentForcedForeground,
  parseAgencyAgentMarkdown,
  parseTalentAssignmentsFromMessage,
  readMergedTalentRoster,
  readTalentTemplate,
  readTalentTeamRoster,
  readTalentRoster,
  recordTalentTeamUsage,
  recordTalentUsage,
  renameTalent,
  detectsSerialDependency,
  resolveTalentExecutionMode,
  resolveTalentStorePaths,
  renderTalentPackagePrompt,
  syncTalentTemplates,
  updateTalentBindings,
  updateCustomTalentTemplate,
  writeTalentTemplate,
} from "./index.js";

describe("talent registry", () => {
  it("parses agency-agents markdown into a talent template", () => {
    const template = parseAgencyAgentMarkdown(
      "engineering/engineering-ai-engineer.md",
      `---
name: AI Engineer
description: Builds AI systems.
color: blue
emoji: robot
vibe: Turns models into product.
---

# AI Engineer Agent
You are an AI Engineer.
`,
    );

    expect(template).toMatchObject({
      id: "engineering-ai-engineer",
      category: "engineering",
      role: "AI 工程师",
      description: "AI 工程师，专注工程场景；负责把复杂问题拆解成可执行建议、产物与验证标准。",
      color: "#2563eb",
      emoji: "robot",
      vibe: "AI 工程师风格：保留原角色的专业气质，同时用中文给出清晰、可执行、可验证的建议。",
    });
    expect(template.avatar).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(template.systemPrompt).toContain("你是AI 工程师");
    expect(template.systemPrompt).toContain("不输出空泛口号");
    expect(template.systemPrompt).not.toContain("You are an AI Engineer.");
    expect(template.suggestedTools).toContain("write_patch");
  });

  it("hires a template into a roster with a unique mention", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-talents-"));
    const templatesDir = join(root, "templates");
    const rosterPath = join(root, "roster.json");
    const template = parseAgencyAgentMarkdown(
      "engineering/engineering-code-reviewer.md",
      `---
name: Code Reviewer
description: Reviews risky code.
---
Body`,
    );
    await writeTalentTemplate(templatesDir, template);

    const hired = await hireTalent({
      templatesDir,
      rosterPath,
      templateId: template.id,
      displayName: "老周",
      mention: "laozhou",
    });
    const roster = await readTalentRoster(rosterPath);

    expect(hired.displayName).toBe("老周");
    expect(hired.mention).toBe("laozhou");
    expect(roster.hired).toHaveLength(1);
  });

  it("extracts unique mentions and builds a bounded persona block", () => {
    expect(extractTalentMentions("@Nova 做A @nova 做B @老周 审查")).toEqual([
      "nova",
      "老周",
    ]);
    const block = buildTalentSystemBlock({
      hired: {
        instanceId: "t_nova",
        templateId: "engineering-ai-engineer",
        displayName: "Nova",
        mention: "nova",
        enabled: true,
        skills: [],
        tools: [],
        permissionPreset: "advisor",
        hiredAt: "2026-06-13T00:00:00.000Z",
        stats: { tasksDone: 0, lastUsed: null },
      },
      template: {
        id: "engineering-ai-engineer",
        category: "engineering",
        role: "AI Engineer",
        description: "Builds AI systems.",
        sourcePath: "engineering/engineering-ai-engineer.md",
        systemPrompt: "You are an AI Engineer.",
        suggestedSkills: [],
        suggestedTools: [],
      },
    });
    expect(block).toContain("Active talent persona");
    expect(block).toContain("Nova");
    expect(block).toContain("must not override Forge safety rules");
  });

  it("normalizes legacy templates into v2 packages", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-talents-v2-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "legacy.json"),
      JSON.stringify({
        id: "legacy",
        category: "product",
        role: "Legacy PM",
        description: "Legacy template",
        sourcePath: "product/legacy.md",
        systemPrompt: "legacy prompt",
        suggestedSkills: ["spec"],
        suggestedTools: ["read_file"],
      }),
    );

    const template = await readTalentTemplate(root, "legacy");
    expect(template).toMatchObject({
      schemaVersion: 2,
      version: "1.0.0",
      methodology: [],
      deliverables: [],
      provenance: { source: "synced", reviewed: false },
    });
  });

  it("keeps structured contracts ahead of a truncated persona prompt", () => {
    const prompt = renderTalentPackagePrompt({
      id: "custom-reviewer",
      category: "engineering",
      role: "Reviewer",
      description: "Reviews changes",
      sourcePath: "custom/custom-reviewer.md",
      systemPrompt: "x".repeat(20_000),
      suggestedSkills: [],
      suggestedTools: [],
      methodology: ["Inspect the diff before recommending changes"],
      deliverables: ["Findings with severity"],
      qualityGates: ["Every finding cites evidence"],
    });

    expect(prompt.length).toBeLessThanOrEqual(12_000);
    expect(prompt).toContain("## Methodology");
    expect(prompt).toContain("## Deliverables");
    expect(prompt).toContain("## Quality gates");
    expect(prompt).toContain("Prompt truncated");
  });

  it("creates, versions, and deletes custom talent packages", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-custom-talent-"));
    const created = await createCustomTalentTemplate({
      templatesDir: root,
      input: {
        role: "需求评审专家",
        description: "评审需求边界和验收标准",
        methodology: ["先识别用户价值", "再检查边界条件"],
        deliverables: ["评审结论", "风险清单"],
        qualityGates: ["每条风险包含验证方式"],
        suggestedSkills: ["spec"],
        suggestedTools: ["read_file"],
      },
    });

    expect(created.id).toMatch(/^custom-/);
    expect(created.provenance?.source).toBe("custom");
    expect(created.version).toBe("1.0.0");
    const updated = await updateCustomTalentTemplate({
      templatesDir: root,
      templateId: created.id,
      patch: { deliverables: ["PRD 评审报告"] },
    });
    expect(updated.version).toBe("1.0.1");
    expect(updated.deliverables).toEqual(["PRD 评审报告"]);
    expect((await deleteCustomTalentTemplate(root, created.id)).removed).toBe(true);
    expect(await readTalentTemplate(root, created.id)).toBeNull();
  });

  it("persists and expands reusable talent teams", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-talent-team-"));
    const rosterPath = join(root, "teams.json");
    const team = await createTalentTeam({
      rosterPath,
      name: "发布审查团",
      mention: "release-team",
      description: "发布前并行检查产品和工程风险",
      members: [
        { mention: "pm", responsibility: "检查需求与验收边界" },
        { mention: "reviewer", responsibility: "检查实现与回归风险", after: ["pm"] },
      ],
      leadMention: "reviewer",
      deliverables: ["发布建议", "风险清单"],
      executionMode: "parallel",
    });

    const expanded = expandTalentTeamMessage("@release-team 审查 1.2.0 发布", team);
    expect(expanded).toContain("@pm 检查需求与验收边界");
    expect(expanded).toContain("@reviewer 检查实现与回归风险");
    expect(expanded).toContain("请基于 @pm 的结果继续");
    expect(expanded).toContain("你是团队内负责人");
    expect(expanded).toContain("(并行)");
    expect(expanded).toContain("最终交付：发布建议、风险清单");
    expect((await readTalentTeamRoster(rosterPath)).teams).toHaveLength(1);
    await recordTalentTeamUsage(rosterPath, team.id);
    expect((await readTalentTeamRoster(rosterPath)).teams[0]?.stats.tasksDone).toBe(1);
    expect((await deleteTalentTeam(rosterPath, team.id)).removed).toBe(true);
  });

  it("validates team leads and avoids talent mention collisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-talent-team-validation-"));
    const rosterPath = join(root, "teams.json");
    await expect(createTalentTeam({
      rosterPath,
      name: "冲突团队",
      mention: "reviewer",
      description: "test",
      reservedMentions: ["reviewer"],
      members: [
        { mention: "pm", responsibility: "需求" },
        { mention: "reviewer", responsibility: "审查" },
      ],
    })).resolves.toMatchObject({ mention: "reviewer2" });

    await expect(createTalentTeam({
      rosterPath,
      name: "错误负责人",
      description: "test",
      leadMention: "outsider",
      members: [
        { mention: "pm", responsibility: "需求" },
        { mention: "reviewer", responsibility: "审查" },
      ],
    })).rejects.toThrow("Team lead must be one of the team members");
  });

  it("syncs templates from a local agency-agents directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-talents-local-"));
    const sourceDir = join(root, "agency-agents");
    const templatesDir = join(root, "templates");
    await mkdir(join(sourceDir, "product"), { recursive: true });
    await writeFile(
      join(sourceDir, "product", "product-manager.md"),
      `---
name: Product Manager
description: Ships the right thing.
---
You are a Product Manager.`,
      "utf-8",
    );
    await writeFile(join(sourceDir, "README.md"), "# ignore", "utf-8");

    const result = await syncTalentTemplates({
      templatesDir,
      sourceDir,
      limitCategories: ["product"],
    });

    expect(result).toEqual({ count: 1, skipped: 0, source: "local" });
  });

  it("falls back to a local agency-agents directory when GitHub fetch fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-talents-fetch-"));
    const fallbackDir = join(root, "agency-agents");
    await mkdir(join(fallbackDir, "product"), { recursive: true });
    await writeFile(
      join(fallbackDir, "product", "product-manager.md"),
      `---
name: Product Manager
description: Ships the right thing.
---
You are a Product Manager.`,
      "utf-8",
    );
    const fetchImpl = async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    };

    const result = await syncTalentTemplates({
      templatesDir: join(root, "templates"),
      fetchImpl: fetchImpl as typeof fetch,
      fallbackLocalDirs: [fallbackDir],
      timeoutMs: 1000,
    });
    expect(result.source).toBe("local");
    expect(result.count).toBeGreaterThan(0);
    expect(result.notice).toMatch(/GitHub sync failed/i);
  });

  it("renames a hired talent and records usage stats", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-talents-meta-"));
    const templatesDir = join(root, "templates");
    const rosterPath = join(root, "roster.json");
    const template = parseAgencyAgentMarkdown(
      "product/product-manager.md",
      `---
name: Product Manager
description: Ships product.
---
Body`,
    );
    await writeTalentTemplate(templatesDir, template);
    const hired = await hireTalent({
      templatesDir,
      rosterPath,
      templateId: template.id,
      mention: "pm",
    });

    const renamed = await renameTalent({
      rosterPath,
      instanceIdOrMention: hired.mention,
      displayName: "方夏",
      mention: "fangxia",
    });
    expect(renamed.displayName).toBe("方夏");
    expect(renamed.mention).toBe("fangxia");

    await updateTalentBindings({
      rosterPath,
      instanceIdOrMention: "fangxia",
      tools: ["read_file", "grep"],
    });
    const gate = createTalentToolAllowance(
      (await readTalentRoster(rosterPath)).hired[0],
      "background",
    );
    expect(gate("read_file")).toBe(true);
    expect(gate("write_patch")).toBe(false);

    await recordTalentUsage(rosterPath, [hired.instanceId]);
    const roster = await readTalentRoster(rosterPath);
    expect(roster.hired[0].stats.tasksDone).toBe(1);
    expect(roster.hired[0].stats.lastUsed).toBeTruthy();
  });

  it("refreshes bundled templates without deleting extra local templates", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-talents-seed-"));
    const templatesDir = join(root, "templates");
    await mkdir(templatesDir, { recursive: true });
    await writeFile(
      join(templatesDir, "product-manager.json"),
      `${JSON.stringify(
        {
          id: "product-manager",
          category: "product",
          role: "产品经理",
          description: "old",
          sourcePath: "product/product-manager.md",
          systemPrompt: "old prompt",
          suggestedSkills: [],
          suggestedTools: [],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await writeFile(
      join(templatesDir, "custom-local.json"),
      `${JSON.stringify(
        {
          id: "custom-local",
          category: "custom",
          role: "自定义顾问",
          description: "keep me",
          sourcePath: "custom/local.md",
          systemPrompt: "custom prompt",
          suggestedSkills: [],
          suggestedTools: [],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const result = await ensureTalentTemplatesSeeded(templatesDir);

    const expected = await readFile(
      join(bundledTalentTemplatesDir(), "product-manager.json"),
      "utf-8",
    );
    expect(result.seeded).toBeGreaterThan(0);
    expect(await readFile(join(templatesDir, "product-manager.json"), "utf-8"))
      .toBe(expected);
    expect(await readFile(join(templatesDir, "custom-local.json"), "utf-8"))
      .toContain("keep me");
  });

  it("persists the strictSkills toggle via updateTalentBindings", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-talents-strict-"));
    const templatesDir = join(root, "templates");
    const rosterPath = join(root, "roster.json");
    const template = parseAgencyAgentMarkdown(
      "engineering/ai-engineer.md",
      `---
name: AI Engineer
description: Ships AI features.
---
Body`,
    );
    await writeTalentTemplate(templatesDir, template);
    const hired = await hireTalent({
      templatesDir,
      rosterPath,
      templateId: template.id,
      mention: "aieng",
    });
    // New hires default to non-strict (prefer bound skills, allow others).
    expect(hired.strictSkills).toBe(false);

    const updated = await updateTalentBindings({
      rosterPath,
      instanceIdOrMention: "aieng",
      skills: ["patch-edit"],
      strictSkills: true,
    });
    expect(updated.strictSkills).toBe(true);
    expect((await readTalentRoster(rosterPath)).hired[0].strictSkills).toBe(true);

    // Omitting strictSkills leaves the stored value untouched.
    await updateTalentBindings({
      rosterPath,
      instanceIdOrMention: "aieng",
      tools: ["read_file"],
    });
    expect((await readTalentRoster(rosterPath)).hired[0].strictSkills).toBe(true);
  });

  it("strips trailing ! from mentions and detects forced foreground", () => {
    expect(extractTalentMentions("@Nova! 请评审 @lumi")).toEqual(["nova", "lumi"]);
    expect(isTalentForcedForeground("@Nova! 请评审 @lumi", "nova")).toBe(true);
    expect(isTalentForcedForeground("@Nova 请评审", "nova")).toBe(false);
  });

  it("merges project roster over global hires by mention", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-talents-merge-"));
    const dataDir = join(root, "agent-data");
    const templatesDir = join(dataDir, "talents", "templates");
    const globalRosterPath = join(dataDir, "talents", "roster.json");
    const projectDir = join(root, "project");
    const projectRosterPath = join(projectDir, ".forge", "talents.json");
    const template = parseAgencyAgentMarkdown(
      "product/product-manager.md",
      `---
name: Product Manager
description: Ships the right thing.
---
Body`,
    );
    await writeTalentTemplate(templatesDir, template);
    await hireTalent({
      templatesDir,
      rosterPath: globalRosterPath,
      templateId: template.id,
      displayName: "Global Nova",
      mention: "nova",
    });
    await hireTalent({
      templatesDir,
      rosterPath: projectRosterPath,
      templateId: template.id,
      displayName: "Project Nova",
      mention: "nova",
    });
    const merged = await readMergedTalentRoster({
      templatesDir,
      rosterPath: projectRosterPath,
      globalRosterPath,
    });
    expect(merged.hired).toHaveLength(1);
    expect(merged.hired[0].displayName).toBe("Project Nova");
    const paths = resolveTalentStorePaths(dataDir, projectDir);
    expect(paths.rosterPath).toBe(projectRosterPath);
  });
});

describe("talent assignment scheduling", () => {
  it("parses per-mention task segments in message order", () => {
    const parsed = parseTalentAssignmentsFromMessage(
      "@game-designer 设计一款有意思的小游戏 @game-audio-engineer 开发设计完的游戏",
      ["game-designer", "game-audio-engineer"],
    );
    expect(parsed).toEqual([
      { mention: "game-designer", task: "设计一款有意思的小游戏" },
      { mention: "game-audio-engineer", task: "开发设计完的游戏" },
    ]);
  });

  it("runs dependent multi-@ tasks serially", () => {
    const message =
      "@game-designer 设计一款有意思的小游戏 @game-audio-engineer 开发设计完的游戏";
    const assignments = parseTalentAssignmentsFromMessage(message, [
      "game-designer",
      "game-audio-engineer",
    ]);
    expect(resolveTalentExecutionMode(message, assignments)).toBe("serial");
  });

  it("runs ordinal-reference multi-@ tasks serially", () => {
    const message =
      "@game-designer 设计一款有意思的小游戏 @game-audio-engineer 用第一个人的方案继续开发";
    const assignments = parseTalentAssignmentsFromMessage(message, [
      "game-designer",
      "game-audio-engineer",
    ]);
    expect(resolveTalentExecutionMode(message, assignments)).toBe("serial");
  });

  it("defaults ambiguous multi-@ tasks to serial as a safe fallback", () => {
    // No explicit marker and no back-reference: the heuristic can't tell
    // independent from dependent-but-unkeyworded, so it picks the safe side
    // (serial never drops upstream context). The model planner is the path
    // that recovers parallelism for genuinely independent work.
    const message = "@nova 写后端接口 @lumi 出登录页样式 @laozhou 审支付模块";
    const assignments = parseTalentAssignmentsFromMessage(message, [
      "nova",
      "lumi",
      "laozhou",
    ]);
    expect(resolveTalentExecutionMode(message, assignments)).toBe("serial");
    // But there is no *positive* dependency signal to force-serialize a flat
    // model plan — that distinction is what keeps the model's parallel call.
    expect(detectsSerialDependency(message, assignments)).toBe(false);
  });

  it("detectsSerialDependency flags back-references but not the safe default", () => {
    const dependent =
      "@game-designer 设计游戏 @game-audio-engineer 给这个游戏配音，基于上面的方案";
    const depAssignments = parseTalentAssignmentsFromMessage(dependent, [
      "game-designer",
      "game-audio-engineer",
    ]);
    expect(detectsSerialDependency(dependent, depAssignments)).toBe(true);

    const independent = "@nova 写接口 @lumi 出样式";
    const indepAssignments = parseTalentAssignmentsFromMessage(independent, [
      "nova",
      "lumi",
    ]);
    expect(detectsSerialDependency(independent, indepAssignments)).toBe(false);
    // Explicit parallel marker overrides any back-reference into "no force".
    expect(
      detectsSerialDependency(`${dependent} (并行)`, depAssignments),
    ).toBe(false);
  });

  it("honors explicit parallel and serial markers in the message", () => {
    const dependent =
      "@game-designer 设计游戏 @game-audio-engineer 开发设计完的游戏";
    const assignments = parseTalentAssignmentsFromMessage(dependent, [
      "game-designer",
      "game-audio-engineer",
    ]);
    expect(
      resolveTalentExecutionMode(`${dependent} (并行)`, assignments),
    ).toBe("parallel");
    const independent = "@nova 写接口 @lumi 出样式";
    const parallelAssignments = parseTalentAssignmentsFromMessage(independent, [
      "nova",
      "lumi",
    ]);
    expect(
      resolveTalentExecutionMode(`${independent} (串行)`, parallelAssignments),
    ).toBe("serial");
  });
});

describe("buildPriorTalentResultsBlock", () => {
  it("returns empty string with no prior results", () => {
    expect(buildPriorTalentResultsBlock([])).toBe("");
  });

  it("inlines results and omits artifact hints when no path is given", () => {
    const block = buildPriorTalentResultsBlock([
      {
        displayName: "Game Designer",
        mention: "game-designer",
        role: "游戏设计",
        task: "设计小游戏",
        result: "一个点击小游戏的 GDD",
      },
    ]);
    expect(block).toContain("一个点击小游戏的 GDD");
    expect(block).not.toContain("read_file");
  });

  it("surfaces the artifact path so downstream can read the full document", () => {
    const block = buildPriorTalentResultsBlock([
      {
        displayName: "Game Designer",
        mention: "game-designer",
        role: "游戏设计",
        task: "设计小游戏",
        result: "（摘要）点击小游戏",
        artifactPath: ".forge/talent-artifacts/0/game-designer.md",
      },
    ]);
    expect(block).toContain(".forge/talent-artifacts/0/game-designer.md");
    expect(block).toContain("read_file");
  });
});
