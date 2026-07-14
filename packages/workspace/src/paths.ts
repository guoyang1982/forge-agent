import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { canAccessPath } from "./permissions.js";

export type WorkspacePathOptions = {
  /** Skill package roots (plugin skills outside project cwd). */
  skillRoots?: string[];
  /** Personal directory roots allowed for read/write. */
  allowedRoots?: string[];
};

export interface PathGuardLike {
  cwdPath: string;
  resolveSafe(relativePath: string): string;
}

/**
 * Undo cwd + absolute-tail joins, e.g.
 * `/proj/Users/alice/.forge-agent/...` → `/Users/alice/.forge-agent/...`
 */
export function stripMistakenWorkspacePrefix(cwd: string, path: string): string {
  const norm = path.trim().replace(/\\/g, "/");
  const base = resolve(cwd).replace(/\\/g, "/").replace(/\/$/, "");
  const glued = `${base}/`;
  if (!norm.startsWith(glued)) return norm;
  const rest = norm.slice(glued.length);
  if (/^(Users|users|home|var)\//.test(rest)) {
    return `/${rest}`;
  }
  return norm;
}

/** Fix common model mistakes (e.g. `Users/alice/...` instead of `/Users/alice/...`). */
export function normalizeAgentFilePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }
  if (/^(Users|users|home)\/[^/]+\//.test(trimmed)) {
    return `/${trimmed}`;
  }
  return trimmed;
}

export function absolutePathCandidates(path: string): string[] {
  const trimmed = path.trim().replace(/\\/g, "/");
  const out: string[] = [];
  const push = (p: string) => {
    const abs = resolve(p);
    if (!out.includes(abs)) out.push(abs);
  };
  push(trimmed);
  const normalized = normalizeAgentFilePath(trimmed);
  if (normalized !== trimmed) push(normalized);
  if (
    !trimmed.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(trimmed) &&
    !trimmed.split("/").includes("..")
  ) {
    push(`/${trimmed}`);
  }
  return out;
}

function resolveExistingUnderSkillRoots(
  path: string,
  skillRoots: string[],
): string | null {
  for (const abs of absolutePathCandidates(path)) {
    if (!existsSync(abs)) continue;
    for (const root of skillRoots) {
      const r = resolve(root);
      const prefix = r.endsWith(sep) ? r : r + sep;
      if (abs === r || abs.startsWith(prefix)) return abs;
    }
  }
  return null;
}

function resolveExistingAbsoluteOutsideCwd(
  guard: PathGuardLike,
  path: string,
  allowedRoots: string[] = [],
): string | null {
  const cwd = guard.cwdPath;
  const prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
  for (const abs of absolutePathCandidates(path)) {
    if (!existsSync(abs)) continue;
    if (abs === cwd || abs.startsWith(prefix)) continue;
    if (
      canAccessPath({
        abs,
        cwd,
        allowedRoots,
        intent: "read",
      })
    ) {
      return abs;
    }
  }
  return null;
}

/**
 * Normalize agent-supplied paths (often wrong absolutes like /work_space/test/foo.py)
 * to a workspace-relative path safe for resolveSafe.
 */
export function toWorkspaceRelativePath(
  guard: PathGuardLike,
  path: string,
  options?: WorkspacePathOptions,
): string {
  const trimmed = normalizeAgentFilePath(
    stripMistakenWorkspacePrefix(guard.cwdPath, path),
  );
  if (!trimmed) throw new Error("Empty path");

  const skillHit = resolveExistingUnderSkillRoots(
    trimmed,
    options?.skillRoots ?? [],
  );
  if (skillHit) return skillHit;

  const allowedRoots = options?.allowedRoots ?? [];
  const outsideHit = resolveExistingAbsoluteOutsideCwd(
    guard,
    trimmed,
    allowedRoots,
  );
  if (outsideHit) return outsideHit;

  if (!trimmed.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    for (const root of options?.skillRoots ?? []) {
      const candidate = join(resolve(root), trimmed);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    guard.resolveSafe(trimmed);
    return trimmed;
  }

  const cwd = guard.cwdPath;
  for (const abs of absolutePathCandidates(trimmed)) {
    const prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
    if (abs === cwd || abs.startsWith(prefix)) {
      return relative(cwd, abs) || ".";
    }
    if (
      existsSync(abs) &&
      canAccessPath({
        abs,
        cwd: guard.cwdPath,
        allowedRoots,
        skillRoots: options?.skillRoots ?? [],
        intent: "read",
      })
    ) {
      return abs;
    }
  }

  const abs = resolve(trimmed);

  const segments = trimmed.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = segments.slice(i).join("/");
    try {
      const resolved = guard.resolveSafe(candidate);
      if (existsSync(resolved)) {
        return candidate;
      }
    } catch {
      /* try shorter suffix */
    }
  }

  if (
    stripMistakenWorkspacePrefix(guard.cwdPath, path) !==
    path.trim().replace(/\\/g, "/")
  ) {
    const abs = resolve(trimmed);
    const cwdPrefix = guard.cwdPath.endsWith(sep) ? guard.cwdPath : guard.cwdPath + sep;
    if (abs !== guard.cwdPath && !abs.startsWith(cwdPrefix)) {
      return abs;
    }
  }

  return guard.resolveSafe(trimmed);
  /* throws if still escapes */
}

/** Rewrite absolute paths in commands to workspace-relative (for python3, etc.). */
export function normalizeCommandForWorkspace(
  guard: PathGuardLike,
  command: string,
): string {
  // Agent often emits: cd <cwd> && <actual command>. run_command already
  // executes inside workspace cwd, so strip this shell-style prefix.
  const cdPrefix = command.match(/^\s*cd\s+(.+?)\s*&&\s*(.+)$/);
  const normalizedInput = cdPrefix?.[2] ? cdPrefix[2].trim() : command;
  const parts = normalizedInput.split(/\s+/);
  return parts
    .map((part) => {
      if (!part.startsWith("/") || part.includes("..")) return part;
      try {
        const rel = toWorkspaceRelativePath(guard, part);
        return rel.includes(" ") ? `"${rel}"` : rel;
      } catch {
        return part;
      }
    })
    .join(" ");
}
