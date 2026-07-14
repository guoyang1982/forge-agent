import { describe, expect, it } from "vitest";
import {
  resolveTalentSkillCatalog,
  type TalentSkillResolution,
} from "./runtime.js";
import type { SkillDoc } from "@forge/skill-registry";

function skill(id: string): SkillDoc {
  return {
    id,
    name: id,
    description: `${id} description`,
    triggers: [],
    body: "",
    path: `/skills/${id}/SKILL.md`,
    root: `/skills/${id}`,
    format: "standard-skill",
  };
}

describe("resolveTalentSkillCatalog", () => {
  it("keeps strict focused talents strict even when no skills are bound", () => {
    const skills = [skill("using-superpowers"), skill("brainstorming")];

    const result = resolveTalentSkillCatalog(skills, [], true);

    expect(result.skills).toEqual([]);
    expect(result.resolution).toEqual<TalentSkillResolution>({
      requested: [],
      matched: [],
      missing: [],
      strict: true,
    });
  });
});
