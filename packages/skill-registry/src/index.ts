import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface SkillDoc {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  body: string;
  path: string;
  root: string;
  format: "legacy-md" | "standard-skill";
  metadata?: Record<string, string>;
}

/** Skills are enabled by default; `skills.enabled[id] === false` disables. */
export function filterSkillsByConfig(
  skills: SkillDoc[],
  config?: { skills?: { enabled?: Record<string, boolean> } },
): SkillDoc[] {
  return skills.filter((s) => config?.skills?.enabled?.[s.id] !== false);
}

export function skillEnabledInConfig(
  skillId: string,
  config?: { skills?: { enabled?: Record<string, boolean> } },
): boolean {
  return config?.skills?.enabled?.[skillId] !== false;
}

export async function loadSkills(skillsDir: string): Promise<SkillDoc[]> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillDoc[] = [];
  for (const entry of entries) {
    const path = join(skillsDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const skill = await loadSkillFile(path);
      if (skill) skills.push(skill);
    }
    if (entry.isDirectory()) {
      const skill = await tryLoadSkillFile(join(path, "SKILL.md"));
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

export async function loadSkillsFromPaths(paths: string[]): Promise<SkillDoc[]> {
  const skills: SkillDoc[] = [];
  for (const path of paths) {
    try {
      if (path.endsWith(".md")) {
        const skill = await loadSkillFile(path);
        if (skill) skills.push(skill);
      } else {
        const skill = await tryLoadSkillFile(join(path, "SKILL.md"));
        if (skill) {
          skills.push(skill);
        } else {
          skills.push(...(await loadSkills(path)));
        }
      }
    } catch {
      /* missing or invalid plugin skill paths are ignored */
    }
  }
  return skills;
}

async function tryLoadSkillFile(path: string): Promise<SkillDoc | null> {
  try {
    return await loadSkillFile(path);
  } catch {
    return null;
  }
}

async function loadSkillFile(path: string): Promise<SkillDoc | null> {
  const raw = await readFile(path, "utf-8");
  const isStandard = basename(path) === "SKILL.md";
  const id = isStandard
    ? basename(dirname(path))
    : basename(path).replace(/\.md$/, "");
  return parseSkill(id, path, raw, isStandard ? "standard-skill" : "legacy-md");
}

function parseSkill(
  id: string,
  path: string,
  raw: string,
  format: SkillDoc["format"],
): SkillDoc | null {
  const lines = raw.split("\n");
  let name = id;
  let description = "";
  const triggers: string[] = [];
  const bodyLines: string[] = [];
  const metadata: Record<string, string> = {};

  if (lines[0]?.trim() === "---") {
    let currentMap: string | null = null;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        bodyLines.push(...lines.slice(i + 1));
        break;
      }
      const line = lines[i];
      const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (top) {
        currentMap = null;
        const key = top[1];
        const value = cleanYamlValue(top[2]);
        if (key === "name" && value) name = value;
        if (key === "description") description = value;
        if (key === "triggers") triggers.push(...splitListValue(value));
        if (key === "metadata") currentMap = "metadata";
        continue;
      }
      const nested = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (currentMap === "metadata" && nested) {
        metadata[nested[1]] = cleanYamlValue(nested[2]);
      }
    }
  } else {
    bodyLines.push(...lines);
  }

  if (!triggers.length && format === "legacy-md") {
    triggers.push(id.replace(/-/g, " "));
  }

  return {
    id,
    name,
    description,
    triggers,
    body: bodyLines.join("\n").trim(),
    path,
    root: dirname(path),
    format,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
}

function cleanYamlValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitListValue(value: string): string[] {
  const trimmed = value.trim();
  const unwrapped = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  return unwrapped
    .split(",")
    .map((s) => cleanYamlValue(s).toLowerCase())
    .filter(Boolean);
}

/** Common English words that cause false positives via substring match. */
const DESCRIPTION_STOP_WORDS = new Set([
  "to",
  "or",
  "is",
  "an",
  "at",
  "in",
  "on",
  "as",
  "be",
  "by",
  "do",
  "if",
  "it",
  "no",
  "of",
  "so",
  "we",
  "up",
  "use",
  "all",
  "the",
  "and",
  "for",
  "are",
  "was",
  "has",
  "had",
  "not",
  "but",
  "can",
  "may",
  "via",
  "per",
  "any",
  "you",
  "your",
  "when",
  "that",
  "this",
  "with",
  "from",
  "into",
  "than",
  "then",
  "them",
  "they",
  "will",
  "been",
  "have",
  "each",
  "more",
  "most",
  "some",
  "such",
  "only",
  "also",
  "how",
  "what",
  "who",
  "why",
  "out",
  "off",
  "our",
  "one",
  "two",
  "new",
  "old",
  "get",
  "set",
  "run",
  "add",
  "end",
  "way",
  "need",
  "work",
]);

/** Codex-style catalog budget (~2% of a 128k context window). */
export const DEFAULT_SKILL_CATALOG_MAX_CHARS = 8000;

/** Ignore weak description-only matches (e.g. "skill" → writing-skills). */
export const MIN_IMPLICIT_MATCH_SCORE = 14;

/**
 * Score bump applied to a focused talent's bound skills. Large enough to let a
 * bound skill that is *somewhat* relevant win over a higher-scoring generic
 * skill (and cross the implicit threshold), but it only lifts skills that
 * already have a positive match — a bound skill with no token overlap is never
 * preloaded for an unrelated request.
 */
export const PREFERRED_SKILL_SCORE_BOOST = 12;

export type SkillMatchMode = "explicit" | "implicit" | "none";

export interface ResolvedSkill {
  skill: SkillDoc | null;
  mode: SkillMatchMode;
  score: number;
}

export function matchSkill(skills: SkillDoc[], goal: string): SkillDoc | null {
  return resolveSkill(skills, goal, { minImplicitScore: 0 }).skill;
}

export function resolveSkill(
  skills: SkillDoc[],
  goal: string,
  options?: { minImplicitScore?: number; preferredSkillIds?: string[] },
): ResolvedSkill {
  const g = goal.toLowerCase().trim();
  if (!g) return { skill: null, mode: "none", score: 0 };

  const explicit = findExplicitSkill(skills, goal);
  if (explicit) {
    return { skill: explicit, mode: "explicit", score: Number.POSITIVE_INFINITY };
  }

  const minScore = options?.minImplicitScore ?? MIN_IMPLICIT_MATCH_SCORE;
  // When a talent is focused, bias matching toward its bound skills so an
  // `@talent` run reaches for that talent's skills before generic ones.
  const preferred = preferredSkillIdSet(skills, options?.preferredSkillIds);
  let ranked = rankSkills(skills, g);
  if (preferred.size) {
    ranked = [...ranked]
      .map((entry) =>
        preferred.has(entry.skill.id)
          ? { skill: entry.skill, score: entry.score + PREFERRED_SKILL_SCORE_BOOST }
          : entry,
      )
      .sort((a, b) => b.score - a.score);
  }
  const best = ranked[0];
  if (!best) return { skill: null, mode: "none", score: 0 };

  const parts = scoreSkillMatchParts(best.skill, g);
  const strongSignal =
    parts.triggerScore > 0 ||
    parts.identityScore >= 40 ||
    best.score >= minScore;
  if (strongSignal) {
    return { skill: best.skill, mode: "implicit", score: best.score };
  }
  return { skill: null, mode: "none", score: best.score };
}

export function rankSkills(
  skills: SkillDoc[],
  goal: string,
): Array<{ skill: SkillDoc; score: number }> {
  const g = goal.toLowerCase().trim();
  const ranked: Array<{ skill: SkillDoc; score: number }> = [];
  for (const skill of skills) {
    const score = scoreSkillMatch(skill, g);
    if (score > 0) ranked.push({ skill, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/** Resolve a talent's bound skill ids/names to the canonical skill id set. */
function preferredSkillIdSet(
  skills: SkillDoc[],
  preferredSkillIds?: string[],
): Set<string> {
  const set = new Set<string>();
  for (const raw of preferredSkillIds ?? []) {
    const skill = findSkillById(skills, raw);
    if (skill) set.add(skill.id);
  }
  return set;
}

export function findSkillById(
  skills: SkillDoc[],
  idOrName: string,
): SkillDoc | null {
  const key = idOrName.toLowerCase().trim();
  if (!key) return null;
  return (
    skills.find((s) => s.id.toLowerCase() === key) ??
    skills.find((s) => s.name.toLowerCase() === key) ??
    skills.find((s) => s.name.toLowerCase().replace(/\s+/g, "-") === key) ??
    null
  );
}

const SKILL_BUNDLE_IGNORE = new Set(["node_modules", ".git", "dist", "build"]);

/** List non-SKILL.md files under a skill package (scripts, references, prompts, etc.). */
export async function listSkillBundledFiles(
  skill: SkillDoc,
  options?: { maxFiles?: number },
): Promise<string[]> {
  const maxFiles = options?.maxFiles ?? 48;
  const results: string[] = [];

  async function walk(dir: string, relPrefix: string): Promise<void> {
    if (results.length >= maxFiles) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (SKILL_BUNDLE_IGNORE.has(entry.name)) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (full !== skill.path) {
        results.push(rel.replace(/\\/g, "/"));
      }
    }
  }

  await walk(skill.root, "");
  return results.sort((a, b) => a.localeCompare(b));
}

/** Match read_file path to a loaded skill (SKILL.md or any file under skill root). */
export function findSkillByReadPath(
  skills: SkillDoc[],
  readPath: string,
): SkillDoc | null {
  const normalized = readPath.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  const abs = resolve(normalized);
  const exact = skills.find((s) => s.path === normalized || resolve(s.path) === abs);
  if (exact) return exact;
  for (const skill of skills) {
    const root = skill.root.replace(/\\/g, "/");
    const rootPrefix = root.endsWith("/") ? root : `${root}/`;
    if (
      normalized === root ||
      normalized.startsWith(rootPrefix) ||
      abs.startsWith(resolve(skill.root) + sep)
    ) {
      return skill;
    }
  }
  const base = basename(normalized);
  if (base === "SKILL.md") {
    return (
      skills.find((s) => normalized.startsWith(`${s.root}/`)) ??
      skills.find((s) => normalized.endsWith(`/${s.id}/SKILL.md`)) ??
      null
    );
  }
  return skills.find((s) => s.path.endsWith(normalized)) ?? null;
}

/** `/skill id`, `$id`, `@id`, or `id skill` at message start. */
export function findExplicitSkill(
  skills: SkillDoc[],
  message: string,
): SkillDoc | null {
  const trimmed = message.trim();
  const patterns = [
    /^\/skill(?:\s+|:)([a-z0-9][a-z0-9_-]*)\b/i,
    /^\$([a-z0-9][a-z0-9_-]*)\b/,
    /^@([a-z0-9][a-z0-9_-]*)\b/,
    /^([a-z0-9][a-z0-9_-]*)\s+skill\b/i,
    /^(?:superpowers:)?([a-z0-9][a-z0-9_-]*)\s*:/i,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const id = match?.[1];
    if (!id) continue;
    const skill = findSkillById(skills, id);
    if (skill) return skill;
  }
  return null;
}

export function formatSkillCatalog(
  skills: SkillDoc[],
  options?: { maxChars?: number },
): string {
  const maxChars = options?.maxChars ?? DEFAULT_SKILL_CATALOG_MAX_CHARS;
  if (skills.length === 0) return "";

  const header = [
    "If the user task matches a skill description — or they invoke `/skill <id>`, `$<id>`, or `@<id>` — follow that skill.",
    "When no skill is pre-loaded below, use read_file on the skill path to load full instructions before acting.",
    "",
  ].join("\n");

  const lines: string[] = [];
  let omitted = 0;
  for (const skill of skills) {
    const desc = skill.description.trim() || "(no description)";
    const triggers =
      skill.triggers.length > 0
        ? ` · triggers: ${skill.triggers.slice(0, 6).join(", ")}`
        : "";
    const line = `- **${skill.id}** (${skill.path})${triggers}\n  ${desc}`;
    const next = lines.length ? `${lines.join("\n")}\n${line}` : line;
    if ((header + next).length > maxChars) {
      omitted = skills.length - lines.length;
      break;
    }
    lines.push(line);
  }

  let body = lines.join("\n");
  if (omitted > 0) {
    body += `\n\n(${omitted} more skills omitted — use explicit /skill <id> or ask to list skills.)`;
  }
  return `${header}${body}`;
}

export function formatActiveSkillBlock(
  skill: SkillDoc,
  bundledFiles?: string[],
): string {
  const bundled =
    bundledFiles && bundledFiles.length
      ? [
          "",
          "Bundled files (load with read_file; paths relative to Root):",
          ...bundledFiles.map((f) => `- ${f}`),
          "",
        ].join("\n")
      : "";
  return `# ${skill.name}
Source: ${skill.path}
Root: ${skill.root}
Format: ${skill.format}
${skill.description ? `Description: ${skill.description}\n` : ""}${bundled}${skill.body}`;
}

function scoreSkillMatch(skill: SkillDoc, g: string): number {
  return scoreSkillMatchParts(skill, g).total;
}

function scoreSkillMatchParts(
  skill: SkillDoc,
  g: string,
): { total: number; triggerScore: number; identityScore: number } {
  let triggerScore = 0;
  let identityScore = scoreIdentity(skill.id, g);
  if (skill.name.toLowerCase() !== skill.id.toLowerCase()) {
    identityScore += scoreIdentity(skill.name.replace(/\s+/g, "-"), g) * 0.9;
  }

  for (const trigger of skill.triggers ?? []) {
    triggerScore += scoreExplicitTerm(trigger, g);
  }

  let score = triggerScore + identityScore;
  for (const value of Object.values(skill.metadata ?? {})) {
    score += scorePhrase(value, g, { minLen: 3 });
  }
  if (skill.description) {
    score += scoreDescription(skill.description, g);
  }

  return { total: score, triggerScore, identityScore };
}

function scoreIdentity(idOrSlug: string, g: string): number {
  const id = idOrSlug.toLowerCase().trim();
  if (!id) return 0;

  if (g.includes(id)) return 100 + id.length;

  const spaced = id.replace(/-/g, " ");
  if (spaced !== id && g.includes(spaced)) return 90 + spaced.length;

  let score = 0;
  const words = extractAsciiWords(g);
  for (const part of id.split("-")) {
    if (part.length < 4) continue;
    if (asciiTermMatches(part, g, { allowSubstring: false })) {
      score += part.length * 4;
      continue;
    }
    for (const word of words) {
      if (word.length < 4) continue;
      if (part === word) {
        score += word.length * 4;
        continue;
      }
      if (part.startsWith(word) || word.startsWith(part)) {
        score += Math.min(part.length, word.length) * 1.5;
      }
    }
  }
  return score;
}

function scoreExplicitTerm(term: string, g: string): number {
  const t = term.toLowerCase().trim();
  if (!t) return 0;
  if (/[\u4e00-\u9fff]/.test(t)) {
    return g.includes(t) ? t.length * 3 : 0;
  }
  if (t.length <= 3) {
    return asciiTermMatches(t, g, { allowSubstring: true }) ? t.length * 4 : 0;
  }
  return asciiTermMatches(t, g, { allowSubstring: false })
    ? t.length * 3
    : asciiTermMatches(t, g, { allowSubstring: true })
      ? t.length * 2
      : 0;
}

function scorePhrase(
  phrase: string,
  g: string,
  opts: { minLen: number },
): number {
  const p = phrase.toLowerCase().trim();
  if (!p) return 0;
  if (/[\u4e00-\u9fff]/.test(p)) {
    return g.includes(p) ? p.length * 2 : 0;
  }
  if (p.length < opts.minLen) return 0;
  return asciiTermMatches(p, g, { allowSubstring: false }) ? p.length * 2 : 0;
}

function scoreDescription(description: string, g: string): number {
  let score = 0;
  const tokens = description
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff._-]+/u)
    .map((t) => t.trim())
    .filter(Boolean);

  for (const token of tokens) {
    if (/[\u4e00-\u9fff]/.test(token)) {
      if (token.length >= 2 && g.includes(token)) score += token.length;
      continue;
    }
    if (token.length < 4 || DESCRIPTION_STOP_WORDS.has(token)) continue;
    if (asciiTermMatches(token, g, { allowSubstring: false })) {
      score += token.length;
    }
  }
  return score;
}

function extractAsciiWords(g: string): string[] {
  return g.split(/[^a-z0-9]+/i).filter((w) => w.length >= 4);
}

function asciiTermMatches(
  term: string,
  g: string,
  opts: { allowSubstring: boolean },
): boolean {
  const t = term.toLowerCase();
  if (!t) return false;
  if (/[\u4e00-\u9fff]/.test(t)) return g.includes(t);
  if (opts.allowSubstring) return g.includes(t);
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(g);
}
