import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { readPluginManifest } from "@forge/plugin-registry";
import catalog from "./catalog.json" with { type: "json" };
import { gitHubCloneUrl, parseGitHubSource, type ParsedGitHubRepo } from "./github.js";
import type { CatalogEntry, CatalogItemKind } from "./types.js";

const COPY_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  ".turbo",
  "dist",
]);

export type { CatalogEntry, CatalogItemKind };

export function listCatalog(query?: string): CatalogEntry[] {
  const q = (query ?? "").trim().toLowerCase();
  const items = catalog as CatalogEntry[];
  if (!q) return items;
  return items.filter((item) => {
    const hay = [item.id, item.name, item.description, item.repo, ...(item.tags ?? [])]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

export function getCatalogEntry(id: string): CatalogEntry | undefined {
  return listCatalog().find((e) => e.id === id);
}

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr?.on("data", (c) => {
      err += String(c);
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(err.trim() || `git ${args.join(" ")} failed (${code})`));
    });
  });
}

async function cloneRepo(parsed: ParsedGitHubRepo): Promise<string> {
  const tmp = join(
    tmpdir(),
    `forge-import-${randomBytes(6).toString("hex")}`,
  );
  await mkdir(tmp, { recursive: true });
  const cloneArgs = ["clone", "--depth", "1"];
  if (parsed.branch) cloneArgs.push("--branch", parsed.branch);
  cloneArgs.push(gitHubCloneUrl(parsed), tmp);
  try {
    await runGit(cloneArgs, process.cwd());
    return tmp;
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function copyTreeFiltered(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (COPY_SKIP_DIRS.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTreeFiltered(from, to);
    } else if (entry.isFile()) {
      await cp(from, to);
    }
  }
}

function resolveContentRoot(cloneRoot: string, subdir: string): string {
  const base = subdir ? join(cloneRoot, subdir) : cloneRoot;
  if (!existsSync(base)) {
    throw new Error(`Path not found in repository: ${subdir || "(root)"}`);
  }
  return base;
}

async function detectSkillId(contentRoot: string, fallback: string): Promise<string> {
  const skillMd = join(contentRoot, "SKILL.md");
  if (!existsSync(skillMd)) {
    throw new Error("No SKILL.md found — not a standard Agent Skill layout");
  }
  const raw = await readFile(skillMd, "utf-8");
  const nameMatch = raw.match(/^name:\s*(.+)$/m);
  if (nameMatch) return nameMatch[1].trim();
  return basename(contentRoot) || fallback;
}

export async function importSkillFromGitHub(options: {
  source: string;
  destDir: string;
  subdir?: string;
  force?: boolean;
}): Promise<{ id: string; path: string; name: string }> {
  const parsed = parseGitHubSource(options.source);
  if (options.subdir) parsed.subdir = options.subdir;
  const tmp = await cloneRepo(parsed);
  try {
    const contentRoot = resolveContentRoot(tmp, parsed.subdir);
    const id = await detectSkillId(contentRoot, parsed.repo);
    const dest = resolve(options.destDir, id);
    if (existsSync(dest) && !options.force) {
      throw new Error(`Skill already installed: ${id} (${dest})`);
    }
    if (existsSync(dest)) {
      await rm(dest, { recursive: true, force: true });
    }
    await mkdir(options.destDir, { recursive: true });
    await copyTreeFiltered(contentRoot, dest);
    const skillMd = await readFile(join(dest, "SKILL.md"), "utf-8");
    const nameMatch = skillMd.match(/^name:\s*(.+)$/m);
    return {
      id,
      path: dest,
      name: nameMatch?.[1]?.trim() ?? id,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function importPluginFromGitHub(options: {
  source: string;
  destDir: string;
  subdir?: string;
  force?: boolean;
}): Promise<{ id: string; path: string; name: string }> {
  const parsed = parseGitHubSource(options.source);
  if (options.subdir) parsed.subdir = options.subdir;
  const tmp = await cloneRepo(parsed);
  try {
    const contentRoot = resolveContentRoot(tmp, parsed.subdir);
    let manifest;
    try {
      manifest = readPluginManifest(contentRoot);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/不是插件包|ENOENT|no such file|missing/i.test(msg)) {
        throw new Error(
          `仓库 ${parsed.owner}/${parsed.repo}${parsed.subdir ? `/${parsed.subdir}` : ""} 不是 Forge 插件包（缺少 plugin.json 或 .cursor-plugin / .claude-plugin 清单）。请安装带插件清单的仓库，或改用 Skills → 发现 安装 Skill。`,
        );
      }
      throw e;
    }
    const dest = resolve(options.destDir, manifest.id);
    if (existsSync(dest) && !options.force) {
      throw new Error(`Plugin already installed: ${manifest.id} (${dest})`);
    }
    if (existsSync(dest)) {
      await rm(dest, { recursive: true, force: true });
    }
    await mkdir(options.destDir, { recursive: true });
    await copyTreeFiltered(contentRoot, dest);
    return { id: manifest.id, path: dest, name: manifest.name };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function importFromCatalog(options: {
  catalogId: string;
  kind: CatalogItemKind;
  destDir: string;
  force?: boolean;
}): Promise<{ id: string; path: string; name: string }> {
  const entry = getCatalogEntry(options.catalogId);
  if (!entry) throw new Error(`Unknown catalog id: ${options.catalogId}`);
  if (entry.kind !== options.kind) {
    throw new Error(`Catalog entry ${entry.id} is a ${entry.kind}, not ${options.kind}`);
  }
  const source = entry.repo;
  const subdir = entry.subdir ?? "";
  if (options.kind === "skill") {
    return importSkillFromGitHub({ source, destDir: options.destDir, subdir, force: options.force });
  }
  return importPluginFromGitHub({ source, destDir: options.destDir, subdir, force: options.force });
}
