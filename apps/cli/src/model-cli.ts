import {
  formatProfilesList,
  formatProvidersList,
  getProvider,
  listProviderIds,
  loadConfig,
  maskApiKey,
  saveModelSelection,
} from "@forge/config";

export function runModelCommand(
  action?: string,
  arg1?: string,
  arg2?: string,
): void {
  const act = action ?? "list";

  if (act === "list") {
    const cfg = loadConfig();
    console.log(formatProfilesList(cfg));
    console.log("");
    console.log(formatProvidersList(arg1));
    console.log("");
    console.log("Current (active):");
    console.log(
      `  provider: ${cfg.model.provider ?? "(unset)"}\n` +
        `  model:    ${cfg.model.name}\n` +
        `  baseUrl:  ${cfg.model.baseUrl}\n` +
        `  apiKey:   ${maskApiKey(cfg.model.apiKey)}`,
    );
    if (cfg.model.options) {
      console.log(`  options:  ${JSON.stringify(cfg.model.options)}`);
    }
    return;
  }

  if (act === "use" || act === "set") {
    if (!arg1) {
      console.error("Usage: forge model use <profile> [model-id]");
      console.error(
        `Profiles: deepseek, openai, dashscope, …  Catalog: ${listProviderIds().join(", ")}`,
      );
      process.exit(1);
    }
    try {
      const next = saveModelSelection(arg1, arg2);
      const p = getProvider(arg1);
      console.log(
        `Switched to ${p?.label ?? arg1} → ${next.model.name} @ ${next.model.baseUrl}`,
      );
      if (!next.model.apiKey) {
        console.log(
          `\n\x1b[33m提示:\x1b[0m 未设置 API Key。请执行:\n` +
            `  forge config set model.apiKey <KEY>\n` +
            (p?.apiKeyEnv
              ? `  或 export ${p.apiKeyEnv}=<KEY>\n`
              : ""),
        );
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    return;
  }

  if (act === "providers") {
    console.log(listProviderIds().join("\n"));
    return;
  }

  console.error("Usage: forge model list | use <provider> [model] | providers");
  process.exit(1);
}
