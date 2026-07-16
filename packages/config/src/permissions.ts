import { homedir } from "node:os";
import { resolve } from "node:path";
import { defaultPackageManagers } from "@forge/platform";
import {
  DEFAULT_PERMISSIONS,
  type PermissionsConfig,
} from "@forge/protocol";

/** Expand `~/…` to the current user home directory. */
export function expandTildePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export function expandAllowedRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    const abs = expandTildePath(root);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

function mergeLevel<T>(base: T, patch?: Partial<T>): T {
  return patch ? { ...base, ...patch } : base;
}

/** Merge user config permissions with defaults; expand `~` in allowedRoots. */
export function resolvePermissions(
  patch?: Partial<PermissionsConfig>,
): PermissionsConfig {
  const base = DEFAULT_PERMISSIONS;
  const merged: PermissionsConfig = {
    fileSystem: mergeLevel(base.fileSystem, patch?.fileSystem),
    software: mergeLevel(base.software, patch?.software),
    network: mergeLevel(base.network, patch?.network),
    memory: mergeLevel(base.memory, patch?.memory),
    automation: mergeLevel(base.automation, patch?.automation),
    channels: mergeLevel(base.channels, patch?.channels),
    mobile: mergeLevel(base.mobile, patch?.mobile),
    notifications: mergeLevel(base.notifications, patch?.notifications),
    browser: mergeLevel(base.browser, patch?.browser),
    apps: mergeLevel(base.apps, patch?.apps),
    secrets: mergeLevel(base.secrets, patch?.secrets),
    audit: mergeLevel(base.audit, patch?.audit),
  };
  merged.fileSystem = {
    ...merged.fileSystem,
    allowedRoots: expandAllowedRoots(
      patch?.fileSystem?.allowedRoots ?? base.fileSystem.allowedRoots,
    ),
  };
  merged.software = {
    ...merged.software,
    managers: patch?.software?.managers ?? defaultPackageManagers(),
  };
  merged.mobile = {
    ...merged.mobile,
    allowedProjects: expandAllowedRoots(
      patch?.mobile?.allowedProjects ?? base.mobile.allowedProjects,
    ),
  };
  return merged;
}
