import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findExplicitSkill,
  findSkillByReadPath,
  formatSkillCatalog,
  listSkillBundledFiles,
  loadSkills,
  loadSkillsFromPaths,
  matchSkill,
  resolveSkill,
} from "./index.js";

describe("skill registry", () => {
  it("loads standard directory skills from SKILL.md metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-skills-"));
    const skillRoot = join(root, "skill-creator");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---
name: skill-creator
description: Guide for creating effective skills.
metadata:
  short-description: Create or update a skill
---

# Skill Creator

Use bundled references relative to this skill root.
`,
    );

    const skills = await loadSkills(root);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: "skill-creator",
      name: "skill-creator",
      description: "Guide for creating effective skills.",
      root: skillRoot,
      path: join(skillRoot, "SKILL.md"),
      format: "standard-skill",
    });
    expect(skills[0].metadata?.["short-description"]).toBe(
      "Create or update a skill",
    );
    expect(skills[0].body).toContain("Use bundled references");
  });

  it("matches standard skills by description and metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-skill-match-"));
    const skillRoot = join(root, "documents");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---
name: documents
description: Create, edit, redline, and comment on .docx and Word documents.
metadata:
  short-description: Word document toolkit
---

Document instructions.
`,
    );

    const skills = await loadSkills(root);

    expect(matchSkill(skills, "帮我 redline 这个 Word 文件")?.id).toBe(
      "documents",
    );
  });

  it("keeps legacy markdown skills with triggers compatible", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-legacy-skills-"));
    const legacyPath = join(root, "fix-bug.md");
    writeFileSync(
      legacyPath,
      `---
name: Fix bug
triggers: bug, 修复
---

Legacy body.
`,
    );

    const skills = await loadSkillsFromPaths([legacyPath]);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      id: "fix-bug",
      name: "Fix bug",
      description: "",
      triggers: ["bug", "修复"],
      path: legacyPath,
      root,
      format: "legacy-md",
    });
    expect(matchSkill(skills, "这里有个 bug")?.id).toBe("fix-bug");
    expect(resolveSkill(skills, "这里有个 bug").mode).toBe("implicit");
  });

  it("does not preload on short-trigger substrings inside unrelated words", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-skill-ci-fp-"));
    writeFileSync(
      join(root, "run-ci-local.md"),
      `---
name: Run CI locally
triggers: ci, pipeline, github actions, 流水线, workflow
---
Body.
`,
    );
    const skills = await loadSkillsFromPaths([join(root, "run-ci-local.md")]);

    // "ci" inside "special" / URLs must not preload the CI skill.
    expect(resolveSkill(skills, "这个 special 需求怎么梳理").mode).toBe("none");
    expect(
      resolveSkill(
        skills,
        "梳理下这个产品需求，和现有代码里的实现对比下，给下改造点以及需求规则的总结",
      ).mode,
    ).toBe("none");
    // A real word-boundary "ci" still preloads.
    expect(resolveSkill(skills, "帮我跑一下 ci").mode).toBe("implicit");
    expect(resolveSkill(skills, "帮我跑一下 ci").skill?.id).toBe("run-ci-local");
    expect(resolveSkill(skills, "看看 github actions").mode).toBe("implicit");
  });

  it("matches brainstorm prefix but not unrelated skill mentions", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-skill-false-positive-"));
    const skillRoot = join(root, "finishing-a-development-branch");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---
name: finishing-a-development-branch
description: Use when implementation is complete, all tests pass, and you need to decide how to integrate the work
---

Finish branch guidance.
`,
    );
    const brainstormRoot = join(root, "brainstorming");
    mkdirSync(brainstormRoot, { recursive: true });
    writeFileSync(
      join(brainstormRoot, "SKILL.md"),
      `---
name: brainstorming
description: You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior.
---

Brainstorm guidance.
`,
    );
    const writingSkillsRoot = join(root, "writing-skills");
    mkdirSync(writingSkillsRoot, { recursive: true });
    writeFileSync(
      join(writingSkillsRoot, "SKILL.md"),
      `---
name: writing-skills
description: Use when creating new skills, editing existing skills, or verifying skills work before deployment
---

Writing skills guidance.
`,
    );

    const skills = await loadSkills(root);

    expect(
      matchSkill(skills, "brainstorm: 给登录页做个改版方案")?.id,
    ).toBe("brainstorming");
    expect(
      resolveSkill(skills, "头脑风暴下怎么解决 skill 命中问题").skill?.id,
    ).toBeUndefined();
  });

  it("prefers a focused talent's bound skill over a higher-scoring generic one", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-skill-prefer-"));
    writeFileSync(
      join(root, "generic-orders.md"),
      `---
name: generic-orders
triggers: 订单, 数据
---
Generic body.
`,
    );
    writeFileSync(
      join(root, "talent-orders.md"),
      `---
name: talent-orders
triggers: 订单
---
Talent body.
`,
    );

    const skills = await loadSkillsFromPaths([
      join(root, "generic-orders.md"),
      join(root, "talent-orders.md"),
    ]);

    // Without a focused talent, the higher-scoring generic skill wins.
    expect(resolveSkill(skills, "帮我处理订单数据").skill?.id).toBe(
      "generic-orders",
    );
    // The bound skill is preferred once the talent is focused.
    expect(
      resolveSkill(skills, "帮我处理订单数据", {
        preferredSkillIds: ["talent-orders"],
      }).skill?.id,
    ).toBe("talent-orders");
  });

  it("does not preload an irrelevant bound skill for an unrelated request", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-skill-prefer-none-"));
    writeFileSync(
      join(root, "talent-orders.md"),
      `---
name: talent-orders
triggers: 订单
---
Talent body.
`,
    );

    const skills = await loadSkillsFromPaths([join(root, "talent-orders.md")]);

    expect(
      resolveSkill(skills, "今天天气怎么样", {
        preferredSkillIds: ["talent-orders"],
      }).skill,
    ).toBeNull();
  });

  it("matches skill id prefix and explicit skill invocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-skill-prefix-"));
    const skillRoot = join(root, "test-driven-development");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code
---

TDD guidance.
`,
    );

    const skills = await loadSkills(root);

    expect(matchSkill(skills, "use test driven development")?.id).toBe(
      "test-driven-development",
    );
    expect(matchSkill(skills, "按 test-driven-development skill 做")?.id).toBe(
      "test-driven-development",
    );
    expect(findExplicitSkill(skills, "/skill test-driven-development")?.id).toBe(
      "test-driven-development",
    );
    expect(findExplicitSkill(skills, "$brainstorming")?.id).toBeUndefined();
    expect(
      resolveSkill(skills, "/skill test-driven-development").mode,
    ).toBe("explicit");
  });

  it("renders a skill catalog with paths and descriptions", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-skill-catalog-"));
    const skillRoot = join(root, "brainstorming");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---
name: brainstorming
description: Use before creative work.
---

Body.
`,
    );

    const skills = await loadSkills(root);
    const catalog = formatSkillCatalog(skills, { maxChars: 500 });

    expect(catalog).toContain("brainstorming");
    expect(catalog).toContain("SKILL.md");
    expect(catalog).toContain("Use before creative work.");
    expect(catalog).toContain("read_file");
  });

  it("lists bundled files under skill root", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-skill-bundle-"));
    const skillRoot = join(root, "demo-skill");
    mkdirSync(join(skillRoot, "scripts"), { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---
name: demo
description: Demo skill
---
# Demo
`,
      "utf-8",
    );
    writeFileSync(join(skillRoot, "scripts", "run.sh"), "#!/bin/sh\n", "utf-8");
    writeFileSync(join(skillRoot, "helper.md"), "help\n", "utf-8");
    const skills = await loadSkills(root);
    const bundled = await listSkillBundledFiles(skills[0]);
    expect(bundled).toContain("scripts/run.sh");
    expect(bundled).toContain("helper.md");
    expect(bundled).not.toContain("SKILL.md");
  });

  it("matches read_file paths under skill root", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-skill-match-"));
    const skillRoot = join(root, "brainstorming");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---
name: brainstorming
description: Brainstorm
---
`,
      "utf-8",
    );
    const script = join(skillRoot, "scripts", "helper.js");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, "export {};\n", "utf-8");
    const skills = await loadSkills(root);
    const hit = findSkillByReadPath(skills, script);
    expect(hit?.id).toBe("brainstorming");
  });
});
