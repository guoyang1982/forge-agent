import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";

const SENSITIVE_SEGMENTS = [
  ".ssh",
  ".gnupg",
  ".config",
  "Library",
  "Keychains",
  "Cookies",
] as const;

export function expandTildePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

/** Resolve symlinks (e.g. /var → /private/var on macOS); walk up for missing leaf. */
export function safeRealpath(abs: string): string {
  const target = resolve(abs);
  try {
    return realpathSync(target);
  } catch {
    const parent = dirname(target);
    if (parent === target) return target;
    return resolve(safeRealpath(parent), basename(target));
  }
}

export function isUnderRoot(abs: string, root: string): boolean {
  const normalized = resolve(abs);
  const base = resolve(root);
  if (normalized === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (normalized.startsWith(prefix)) return true;
  try {
    const realNorm = safeRealpath(normalized);
    const realBase = safeRealpath(base);
    if (realNorm === realBase) return true;
    const realPrefix = realBase.endsWith(sep) ? realBase : realBase + sep;
    return realNorm.startsWith(realPrefix);
  } catch {
    return false;
  }
}

/** Block common credential and system profile locations. */
export function isSensitivePath(abs: string): boolean {
  const normalized = resolve(abs);
  const home = homedir();
  const homePrefix = home.endsWith(sep) ? home : home + sep;
  if (!normalized.startsWith(homePrefix) && normalized !== home) {
    return false;
  }
  const rel = normalized.slice(homePrefix.length);
  const parts = rel.split(sep).filter(Boolean);
  if (parts.some((p) => (SENSITIVE_SEGMENTS as readonly string[]).includes(p))) {
    return true;
  }
  if (/Chrome|Firefox|Safari|Brave/i.test(normalized) && /Profile|Cookies/i.test(normalized)) {
    return true;
  }
  return false;
}

export function canAccessPath(options: {
  abs: string;
  cwd: string;
  allowedRoots: string[];
  skillRoots?: string[];
  intent: "read" | "write";
}): boolean {
  const { abs, cwd, allowedRoots, skillRoots = [], intent } = options;
  if (isSensitivePath(abs)) return false;
  if (isUnderRoot(abs, cwd)) return true;
  if (allowedRoots.some((root) => isUnderRoot(abs, root))) return true;
  if (intent === "read" && skillRoots.some((root) => isUnderRoot(abs, root))) {
    return true;
  }
  return false;
}
