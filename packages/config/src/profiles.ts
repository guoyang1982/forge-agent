import type { ForgeConfig, ModelProfile } from "@forge/protocol";
import {
  buildModelPatch,
  getProvider,
  getProviderModel,
  resolveModelFromConfig,
} from "./providers.js";

export function inferProfileId(model: ModelProfile): string {
  if (model.provider) return model.provider;
  const url = model.baseUrl.toLowerCase();
  if (url.includes("deepseek")) return "deepseek";
  if (url.includes("dashscope.aliyuncs.com")) return "dashscope";
  if (url.includes("openai.com")) return "openai";
  return "default";
}

/** If only legacy `model` exists, synthesize a single profile for backward compatibility. */
export function migrateLegacyProfiles(
  partial: Partial<ForgeConfig>,
): Partial<ForgeConfig> {
  if (partial.profiles && Object.keys(partial.profiles).length > 0) {
    return partial;
  }
  if (!partial.model?.baseUrl && !partial.model?.apiKey) {
    return partial;
  }
  const id = inferProfileId(partial.model);
  return {
    ...partial,
    activeProfile: partial.activeProfile ?? id,
    profiles: {
      [id]: { ...partial.model },
    },
  };
}

function isProfileEnabled(p: { enabled?: boolean } | undefined): boolean {
  return p != null && p.enabled !== false;
}

function firstEnabledProfileKey(
  profiles: Record<string, { enabled?: boolean }>,
): string | undefined {
  return Object.keys(profiles).find((k) => isProfileEnabled(profiles[k]));
}

export function applyActiveProfile(cfg: ForgeConfig): ForgeConfig {
  const profiles = cfg.profiles ?? {};
  let key = process.env.FORGE_ACTIVE_PROFILE || cfg.activeProfile;
  if (!key || !profiles[key] || !isProfileEnabled(profiles[key])) {
    key = firstEnabledProfileKey(profiles);
    if (!key) return cfg;
  }
  const p = profiles[key];
  return {
    ...cfg,
    activeProfile: key,
    model: resolveModelFromConfig({
      ...cfg.model,
      ...p,
      apiKey: p.apiKey || cfg.model.apiKey,
    }),
  };
}

export function formatProfilesList(cfg: ForgeConfig): string {
  const profiles = cfg.profiles ?? {};
  const active = process.env.FORGE_ACTIVE_PROFILE || cfg.activeProfile;
  const lines: string[] = ["Saved profiles (config.json):"];
  for (const [id, p] of Object.entries(profiles)) {
    const mark = id === active ? " ← active" : "";
    lines.push(
      `  ${id}${mark}: ${p.name} @ ${p.baseUrl.replace(/^https?:\/\//, "")}`,
    );
  }
  if (!Object.keys(profiles).length) {
    lines.push("  (none — using legacy model block only)");
  }
  return lines.join("\n");
}

export function resolveProfileModel(
  profileId: string,
  modelId: string | undefined,
  profiles: Record<string, ModelProfile> | undefined,
  fallbackApiKey: string,
): ModelProfile {
  const catalog = getProvider(profileId);
  if (catalog) {
    const patch = buildModelPatch(profileId, modelId);
    const existing = profiles?.[profileId];
    let apiKey = existing?.apiKey || fallbackApiKey;
    if (catalog.apiKeyEnv) {
      const fromEnv = process.env[catalog.apiKeyEnv];
      if (fromEnv) apiKey = fromEnv;
    }
    const catalogModel = getProviderModel(profileId, patch.name);
    return {
      provider: patch.provider,
      baseUrl: existing?.baseUrl || patch.baseUrl,
      name: patch.name,
      apiKey,
      options: patch.options ?? existing?.options,
      vision: existing?.vision ?? patch.vision ?? catalogModel?.vision,
    };
  }

  const saved = profiles?.[profileId];
  if (!saved) {
    throw new Error(
      `Unknown profile "${profileId}". Saved: ${
        profiles ? Object.keys(profiles).join(", ") : "(none)"
      }. Catalog: see forge model list`,
    );
  }
  return {
    ...saved,
    name: modelId ?? saved.name,
  };
}
