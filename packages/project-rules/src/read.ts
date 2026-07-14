import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProjectRules, RuleSource } from "./types.js";

export function readProjectRules(cwd: string): ProjectRules {
  const sources: RuleSource[] = [];

  for (const name of ["AGENTS.md", "agents.md"]) {
    const path = join(cwd, name);
    if (existsSync(path) && statSync(path).isFile()) {
      sources.push({
        kind: "project",
        path,
        content: readFileSync(path, "utf-8"),
      });
    }
  }

  const cursorRulesDir = join(cwd, ".cursor", "rules");
  if (existsSync(cursorRulesDir)) {
    for (const name of readdirSync(cursorRulesDir).sort()) {
      if (!/\.(md|mdc|txt)$/.test(name)) continue;
      const path = join(cursorRulesDir, name);
      if (!statSync(path).isFile()) continue;
      sources.push({
        kind: "cursor",
        path,
        content: readFileSync(path, "utf-8"),
      });
    }
  }

  return {
    sources,
    merged: sources
      .map((s) => `# Rules from ${s.path}\n${s.content}`)
      .join("\n\n")
      .slice(0, 8000),
  };
}
