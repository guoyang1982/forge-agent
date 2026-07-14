import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolveDaemonIpcPath } from "@forge/platform";
import { DEFAULT_CONFIG, type ForgeConfig } from "@forge/protocol";
import { resolvePermissions } from "./permissions.js";
import {
  buildModelPatch,
  getProvider,
  resolveModelFromConfig,
} from "./providers.js";
import {
  applyActiveProfile,
  formatProfilesList,
  migrateLegacyProfiles,
  resolveProfileModel,
} from "./profiles.js";

/** Override via FORGE_CONFIG_PATH or --config (set before loadConfig) */
let configFileOverride: string | undefined;

export function setConfigPath(path: string | undefined): void {
  configFileOverride = path ? resolve(path) : undefined;
}

export function getConfigPath(): string {
  if (configFileOverride) return configFileOverride;
  if (process.env.FORGE_CONFIG_PATH) {
    return resolve(process.env.FORGE_CONFIG_PATH);
  }
  return join(getDataDir(), "config.json");
}

export function getDataDir(): string {
  const fromEnv = process.env.FORGE_DATA_DIR;
  if (fromEnv) return resolve(fromEnv);
  return join(homedir(), ".forge-agent");
}

/** Project-level config: <cwd>/.forge/config.json */
export function findProjectConfig(cwd: string): string | null {
  const p = join(resolve(cwd), ".forge", "config.json");
  return existsSync(p) ? p : null;
}

function readJsonFile(path: string): Partial<ForgeConfig> {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ForgeConfig>;
  return raw;
}

function mergeConfig(
  base: ForgeConfig,
  ...layers: Array<Partial<ForgeConfig>>
): ForgeConfig {
  let out = { ...base };
  for (const layer of layers) {
    out = {
      ...out,
      ...layer,
      model: {
        ...out.model,
        ...layer.model,
        options:
          layer.model?.options !== undefined
            ? { ...out.model.options, ...layer.model.options }
            : out.model.options,
      },
      limits: {
        ...out.limits,
        ...layer.limits,
        maxContextTokens:
          layer.limits?.maxContextTokens ?? out.limits.maxContextTokens,
      },
      daemon: { ...out.daemon, ...layer.daemon },
      mcp: layer.mcp ?? out.mcp,
      plugins: {
        ...out.plugins,
        ...layer.plugins,
        enabled: {
          ...out.plugins?.enabled,
          ...layer.plugins?.enabled,
        },
      },
      skills: {
        ...out.skills,
        ...layer.skills,
        enabled: {
          ...out.skills?.enabled,
          ...layer.skills?.enabled,
        },
      },
      ui: { ...out.ui, ...layer.ui },
      network: layer.network
        ? { ...out.network, ...layer.network }
        : out.network,
      permissions: layer.permissions
        ? {
            ...out.permissions,
            ...layer.permissions,
            fileSystem: {
              ...out.permissions?.fileSystem,
              ...layer.permissions.fileSystem,
            },
            software: {
              ...out.permissions?.software,
              ...layer.permissions.software,
            },
            network: {
              ...out.permissions?.network,
              ...layer.permissions.network,
            },
            memory: {
              ...out.permissions?.memory,
              ...layer.permissions.memory,
            },
            automation: {
              ...out.permissions?.automation,
              ...layer.permissions.automation,
            },
            notifications: {
              ...out.permissions?.notifications,
              ...layer.permissions.notifications,
            },
            browser: {
              ...out.permissions?.browser,
              ...layer.permissions.browser,
            },
            apps: {
              ...out.permissions?.apps,
              ...layer.permissions.apps,
            },
            secrets: {
              ...out.permissions?.secrets,
              ...layer.permissions.secrets,
            },
            audit: {
              ...out.permissions?.audit,
              ...layer.permissions.audit,
            },
          }
        : out.permissions,
      profiles:
        layer.profiles === undefined
          ? out.profiles
          : (layer as Partial<ForgeConfig> & { replaceProfiles?: boolean })
                .replaceProfiles
            ? layer.profiles
            : { ...(out.profiles ?? {}), ...layer.profiles },
      activeProfile: layer.activeProfile ?? out.activeProfile,
    };
  }
  return out;
}

/** Apply FORGE_MODEL_API_KEY, FORGE_MODEL_BASE_URL, FORGE_MODEL_NAME, etc. */
function applyEnvOverrides(cfg: ForgeConfig): ForgeConfig {
  const env = process.env;
  let model = { ...cfg.model };
  const limits = { ...cfg.limits };

  if (env.FORGE_MODEL_API_KEY) model.apiKey = env.FORGE_MODEL_API_KEY;
  if (env.FORGE_MODEL_BASE_URL) model.baseUrl = env.FORGE_MODEL_BASE_URL;
  if (env.FORGE_MODEL_NAME) model.name = env.FORGE_MODEL_NAME;

  if (env.FORGE_MODEL_PROVIDER) {
    const patch = buildModelPatch(
      env.FORGE_MODEL_PROVIDER,
      env.FORGE_MODEL_NAME || undefined,
    );
    model = {
      ...model,
      ...patch,
      apiKey: model.apiKey || env.FORGE_MODEL_API_KEY || "",
      name: env.FORGE_MODEL_NAME || patch.name,
    };
  }

  if (model.provider === "deepseek" && env.DEEPSEEK_API_KEY && !model.apiKey) {
    model.apiKey = env.DEEPSEEK_API_KEY;
  }
  if (model.provider === "openai" && env.OPENAI_API_KEY && !model.apiKey) {
    model.apiKey = env.OPENAI_API_KEY;
  }
  if (model.provider === "dashscope" && env.DASHSCOPE_API_KEY && !model.apiKey) {
    model.apiKey = env.DASHSCOPE_API_KEY;
  }

  if (env.FORGE_MAX_STEPS) {
    const n = parseInt(env.FORGE_MAX_STEPS, 10);
    if (!Number.isNaN(n)) limits.maxSteps = n;
  }
  if (env.FORGE_TOOL_RESULT_MAX_CHARS) {
    const n = parseInt(env.FORGE_TOOL_RESULT_MAX_CHARS, 10);
    if (!Number.isNaN(n)) limits.toolResultMaxChars = n;
  }
  if (env.FORGE_MAX_CONTEXT_TOKENS) {
    const n = parseInt(env.FORGE_MAX_CONTEXT_TOKENS, 10);
    if (!Number.isNaN(n)) limits.maxContextTokens = n;
  }

  return { ...cfg, model: resolveModelFromConfig(model), limits };
}

export interface LoadConfigOptions {
  /** Merge project .forge/config.json from this directory */
  cwd?: string;
}

export function loadConfig(options?: LoadConfigOptions): ForgeConfig {
  const dataDir = getDataDir();
  const configPath = getConfigPath();
  mkdirSync(dataDir, { recursive: true });

  const base: ForgeConfig = {
    ...DEFAULT_CONFIG,
    daemon: {
      dataDir,
      socketPath: resolveDaemonIpcPath(dataDir),
    },
  };

  const layers: Array<Partial<ForgeConfig>> = [];

  if (existsSync(configPath)) {
    layers.push(migrateLegacyProfiles(readJsonFile(configPath)));
  } else if (!configFileOverride && !process.env.FORGE_CONFIG_PATH) {
    writeFileSync(configPath, JSON.stringify(stripDaemonForFile(base), null, 2));
  }

  if (options?.cwd) {
    const projectPath = findProjectConfig(options.cwd);
    if (projectPath) {
      layers.push(migrateLegacyProfiles(readJsonFile(projectPath)));
    }
  }

  const merged = mergeConfig(base, ...layers);
  const withProfile = applyActiveProfile(merged);
  const withEnv = applyEnvOverrides(withProfile);
  return {
    ...withEnv,
    model: resolveModelFromConfig(withEnv.model),
    permissions: resolvePermissions(withEnv.permissions),
  };
}

/** Omit auto-managed daemon paths when writing user config */
function stripDaemonForFile(cfg: ForgeConfig): Partial<ForgeConfig> {
  const out: Partial<ForgeConfig> = {
    activeProfile: cfg.activeProfile,
    profiles: cfg.profiles,
    limits: cfg.limits,
    mcp: cfg.mcp,
    plugins: cfg.plugins,
    skills: cfg.skills,
    ui: cfg.ui,
    reflection: cfg.reflection,
    permissions: cfg.permissions,
  };
  // With profiles, active model is derived from activeProfile on load — no duplicate block.
  const hasProfiles =
    cfg.profiles && Object.keys(cfg.profiles).length > 0 && cfg.activeProfile;
  if (!hasProfiles) {
    out.model = cfg.model;
  }
  return out;
}

/** Switch provider/model in config; picks env API key when available. */
export function saveModelSelection(
  profileId: string,
  modelId?: string,
): ForgeConfig {
  const path = getConfigPath();
  const filePartial = existsSync(path)
    ? migrateLegacyProfiles(readJsonFile(path))
    : {};
  const profiles = { ...(filePartial.profiles ?? {}) };
  const profileModel = resolveProfileModel(
    profileId,
    modelId,
    profiles,
    filePartial.model?.apiKey ?? "",
  );
  profiles[profileId] = profileModel;
  return saveConfig({
    activeProfile: profileId,
    profiles,
    model: profileModel,
  });
}

export type SaveConfigOptions = {
  /** Replace `profiles` entirely instead of shallow-merging by key. */
  replaceProfiles?: boolean;
};

export function saveConfig(
  patch: Partial<ForgeConfig>,
  opts?: SaveConfigOptions,
): ForgeConfig {
  const current = loadConfig();
  const layer =
    opts?.replaceProfiles && patch.profiles
      ? ({ ...patch, replaceProfiles: true } as Partial<ForgeConfig> & {
          replaceProfiles?: boolean;
        })
      : patch;
  const next = mergeConfig(current, layer);
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  const toWrite = mergeConfig(
    { ...DEFAULT_CONFIG, daemon: current.daemon },
    stripDaemonForFile(next) as Partial<ForgeConfig>,
  );
  writeFileSync(
    configPath,
    JSON.stringify(stripDaemonForFile(toWrite as ForgeConfig), null, 2),
  );
  const withProfile = applyActiveProfile(next);
  const withEnv = applyEnvOverrides(withProfile);
  return {
    ...withEnv,
    model: resolveModelFromConfig(withEnv.model),
  };
}

export function maskApiKey(key: string): string {
  if (!key) return "(empty)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function formatConfigForDisplay(cfg: ForgeConfig): Record<string, unknown> {
  return {
    configPath: getConfigPath(),
    dataDir: cfg.daemon.dataDir,
    socketPath: cfg.daemon.socketPath,
    activeProfile: cfg.activeProfile ?? "(unset)",
    profiles: cfg.profiles
      ? Object.fromEntries(
          Object.entries(cfg.profiles).map(([k, p]) => [
            k,
            {
              ...p,
              apiKey: maskApiKey(p.apiKey),
            },
          ]),
        )
      : undefined,
    model: {
      provider: cfg.model.provider ?? "(unset)",
      baseUrl: cfg.model.baseUrl,
      name: cfg.model.name,
      apiKey: maskApiKey(cfg.model.apiKey),
      options: cfg.model.options,
    },
    limits: cfg.limits,
    mcp: cfg.mcp,
    plugins: cfg.plugins,
    envOverrides: listActiveEnvOverrides(),
  };
}

function listActiveEnvOverrides(): string[] {
  const keys = [
    "FORGE_CONFIG_PATH",
    "FORGE_DATA_DIR",
    "FORGE_MODEL_API_KEY",
    "FORGE_MODEL_BASE_URL",
    "FORGE_MODEL_NAME",
    "FORGE_MODEL_PROVIDER",
    "FORGE_ACTIVE_PROFILE",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "FORGE_MAX_STEPS",
    "FORGE_TOOL_RESULT_MAX_CHARS",
    "FORGE_MAX_CONTEXT_TOKENS",
  ];
  return keys.filter((k) => process.env[k]);
}

export function getDbPath(): string {
  return join(getDataDir(), "data.db");
}

export function resolveMigrationsDir(monorepoRoot: string): string {
  return join(monorepoRoot, "migrations");
}

export { loadMcpServers } from "./mcp.js";
export {
  MODEL_PROVIDERS,
  buildModelPatch,
  formatProvidersList,
  getProvider,
  listProviderIds,
  resolveModelFromConfig,
} from "./providers.js";
export {
  applyActiveProfile,
  formatProfilesList,
  migrateLegacyProfiles,
} from "./profiles.js";
export { buildConfigPatchFromDotKey } from "./config-set.js";
