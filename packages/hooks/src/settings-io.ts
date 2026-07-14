import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RawHookGroup } from "./schema.js";

export type HooksSettingsScope = "user" | "project" | "project-local";

export interface HooksSettingsFile {
  disableAllHooks?: boolean;
  hooks?: Record<string, RawHookGroup[]>;
}

export function resolveHooksSettingsPath(
  scope: HooksSettingsScope,
  options: { cwd?: string; dataDir: string },
): string {
  const dataDir = resolve(options.dataDir);
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  switch (scope) {
    case "user":
      return join(dataDir, "settings.json");
    case "project":
      return join(cwd, ".forge", "settings.json");
    case "project-local":
      return join(cwd, ".forge", "settings.local.json");
  }
}

export function emptyHooksSettings(): HooksSettingsFile {
  return { hooks: {} };
}

export function readHooksSettingsFile(path: string): HooksSettingsFile {
  if (!existsSync(path)) return emptyHooksSettings();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as HooksSettingsFile;
    return {
      disableAllHooks: raw.disableAllHooks,
      hooks: raw.hooks ?? {},
    };
  } catch {
    throw new Error(`Invalid hooks settings JSON: ${path}`);
  }
}

export function writeHooksSettingsFile(
  path: string,
  settings: HooksSettingsFile,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const out: HooksSettingsFile = {
    ...(settings.disableAllHooks ? { disableAllHooks: true } : {}),
    hooks: settings.hooks ?? {},
  };
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
}

export function hooksSettingsLayers(dataDir: string, cwd?: string): Array<{
  scope: HooksSettingsScope;
  path: string;
  label: string;
}> {
  const absCwd = cwd ? resolve(cwd) : undefined;
  const layers: Array<{ scope: HooksSettingsScope; path: string; label: string }> =
    [
      {
        scope: "user",
        path: resolveHooksSettingsPath("user", { dataDir }),
        label: "用户 (~/.forge-agent/settings.json)",
      },
    ];
  if (absCwd) {
    layers.push(
      {
        scope: "project",
        path: resolveHooksSettingsPath("project", { cwd: absCwd, dataDir }),
        label: "项目 (.forge/settings.json)",
      },
      {
        scope: "project-local",
        path: resolveHooksSettingsPath("project-local", {
          cwd: absCwd,
          dataDir,
        }),
        label: "项目本地 (.forge/settings.local.json)",
      },
    );
  }
  layers.push({
    scope: "user",
    path: join(homedir(), ".claude", "settings.json"),
    label: "Claude 用户 (~/.claude/settings.json，只读兼容)",
  });
  if (absCwd) {
    layers.push(
      {
        scope: "project",
        path: join(absCwd, ".claude", "settings.json"),
        label: "Claude 项目 (.claude/settings.json，只读兼容)",
      },
      {
        scope: "project-local",
        path: join(absCwd, ".claude", "settings.local.json"),
        label: "Claude 本地 (.claude/settings.local.json，只读兼容)",
      },
    );
  }
  return layers;
}
