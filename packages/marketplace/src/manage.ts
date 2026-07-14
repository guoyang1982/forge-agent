import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveConfig, loadConfig, findProjectConfig } from "@forge/config";
import type { ForgeConfig } from "@forge/protocol";

export function isSkillEnabled(
  skillId: string,
  config?: Partial<ForgeConfig>,
): boolean {
  const override = config?.skills?.enabled?.[skillId];
  return override !== false;
}

export function setSkillEnabled(
  skillId: string,
  enabled: boolean,
  options?: { cwd?: string; project?: boolean },
): ForgeConfig {
  if (options?.project && options.cwd) {
    return saveProjectSkillState(options.cwd, skillId, enabled);
  }
  const cfg = loadConfig({ cwd: options?.cwd });
  return saveConfig({
    skills: {
      ...cfg.skills,
      enabled: {
        ...cfg.skills?.enabled,
        [skillId]: enabled,
      },
    },
  });
}

export function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
  options?: { cwd?: string; project?: boolean },
): ForgeConfig {
  if (options?.project && options.cwd) {
    return saveProjectPluginState(options.cwd, pluginId, enabled);
  }
  const cfg = loadConfig({ cwd: options?.cwd });
  return saveConfig({
    plugins: {
      ...cfg.plugins,
      enabled: {
        ...cfg.plugins?.enabled,
        [pluginId]: enabled,
      },
    },
  });
}

function saveProjectSkillState(
  cwd: string,
  skillId: string,
  enabled: boolean,
): ForgeConfig {
  const dir = join(cwd, ".forge");
  const path = join(dir, "config.json");
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf-8")) as Partial<ForgeConfig>)
    : {};
  const next = {
    ...existing,
    skills: {
      ...existing.skills,
      enabled: {
        ...existing.skills?.enabled,
        [skillId]: enabled,
      },
    },
  };
  writeFileSync(path, JSON.stringify(next, null, 2), "utf-8");
  return loadConfig({ cwd });
}

function saveProjectPluginState(
  cwd: string,
  pluginId: string,
  enabled: boolean,
): ForgeConfig {
  const dir = join(cwd, ".forge");
  const path = join(dir, "config.json");
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf-8")) as Partial<ForgeConfig>)
    : {};
  const next = {
    ...existing,
    plugins: {
      ...existing.plugins,
      enabled: {
        ...existing.plugins?.enabled,
        [pluginId]: enabled,
      },
    },
  };
  writeFileSync(path, JSON.stringify(next, null, 2), "utf-8");
  return loadConfig({ cwd });
}

export function projectConfigPath(cwd: string): string | null {
  return findProjectConfig(cwd);
}
