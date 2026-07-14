import type { ForgeConfig, ModelOptions } from "@forge/protocol";

export interface ProviderModel {
  id: string;
  label: string;
  note?: string;
  /** Default multimodal / image support for this model id. */
  vision?: boolean;
  defaultOptions?: ModelOptions;
}

export interface ModelProvider {
  id: string;
  label: string;
  baseUrl: string;
  /** Suggested env var for API key when switching provider */
  apiKeyEnv?: string;
  models: ProviderModel[];
  defaultModel: string;
}

export const MODEL_PROVIDERS: Record<string, ModelProvider> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "o1-mini", label: "o1 mini" },
    ],
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek (OpenAI 兼容)",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-flash",
    models: [
      {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        note: "推荐默认",
      },
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        defaultOptions: {
          thinking: { type: "enabled" },
          reasoning_effort: "high",
        },
      },
      {
        id: "deepseek-chat",
        label: "deepseek-chat (legacy)",
        note: "弃用 2026-07-24，等同 v4-flash 非思考",
      },
      {
        id: "deepseek-reasoner",
        label: "deepseek-reasoner (legacy)",
        note: "弃用 2026-07-24，等同 v4-flash 思考",
        defaultOptions: {
          thinking: { type: "enabled" },
          reasoning_effort: "high",
        },
      },
    ],
  },
  dashscope: {
    id: "dashscope",
    label: "阿里云百炼 DashScope（OpenAI 兼容）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    defaultModel: "qwen3.7-plus",
    models: [
      {
        id: "qwen3.7-plus",
        label: "通义千问 3.7 Plus",
        note: "推荐，支持识图",
        vision: true,
      },
      { id: "qwen-plus", label: "qwen-plus", vision: true },
      { id: "qwen-max", label: "qwen-max", vision: true },
      { id: "qwen-vl-max", label: "qwen-vl-max（视觉）", vision: true },
    ],
  },
  "anthropic-deepseek": {
    id: "anthropic-deepseek",
    label: "DeepSeek (Anthropic 兼容)",
    baseUrl: "https://api.deepseek.com/anthropic",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-v4-pro",
    models: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    ],
  },
};

export function listProviderIds(): string[] {
  return Object.keys(MODEL_PROVIDERS);
}

export function getProvider(id: string): ModelProvider | undefined {
  return MODEL_PROVIDERS[id];
}

export function getProviderModel(
  providerId: string,
  modelId: string,
): ProviderModel | undefined {
  return getProvider(providerId)?.models.find((m) => m.id === modelId);
}

export function buildModelPatch(
  providerId: string,
  modelId?: string,
): Pick<
  ForgeConfig["model"],
  "provider" | "baseUrl" | "name" | "options" | "vision"
> {
  const provider = getProvider(providerId);
  if (!provider) {
    throw new Error(
      `Unknown provider: ${providerId}. Use: ${listProviderIds().join(", ")}`,
    );
  }
  const picked =
    modelId && getProviderModel(providerId, modelId)
      ? getProviderModel(providerId, modelId)!
      : provider.models.find((m) => m.id === provider.defaultModel) ??
        provider.models[0];
  if (modelId && !getProviderModel(providerId, modelId)) {
    throw new Error(
      `Unknown model "${modelId}" for ${providerId}. Use: forge model list ${providerId}`,
    );
  }
  return {
    provider: provider.id,
    baseUrl: provider.baseUrl,
    name: picked.id,
    options: picked.defaultOptions,
    vision: picked.vision,
  };
}

export function formatProvidersList(filterProvider?: string): string {
  const ids = filterProvider
    ? [filterProvider].filter((id) => MODEL_PROVIDERS[id])
    : listProviderIds();
  const lines: string[] = [];
  for (const id of ids) {
    const p = MODEL_PROVIDERS[id];
    if (!p) continue;
    lines.push(`${p.id} — ${p.label}`);
    lines.push(`  baseUrl: ${p.baseUrl}`);
    if (p.apiKeyEnv) lines.push(`  apiKey env: ${p.apiKeyEnv}`);
    for (const m of p.models) {
      const mark = m.id === p.defaultModel ? " (default)" : "";
      const note = m.note ? ` — ${m.note}` : "";
      lines.push(`  • ${m.id}${mark}: ${m.label}${note}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Merge provider catalog defaults when config.model.provider is set. */
export function resolveModelFromConfig(
  model: ForgeConfig["model"],
): ForgeConfig["model"] {
  if (!model.provider) return model;
  const provider = getProvider(model.provider);
  if (!provider) return model;
  const catalog = getProviderModel(model.provider, model.name);
  return {
    ...model,
    baseUrl: model.baseUrl || provider.baseUrl,
    options: model.options ?? catalog?.defaultOptions,
    vision: model.vision ?? catalog?.vision,
  };
}
