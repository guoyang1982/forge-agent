import { resolve } from "node:path";
import type { ForgeConfig } from "@forge/protocol";
import { maskApiKey } from "@forge/config";
import { printWelcomeCommandHints } from "./commands-hint.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

export function printWelcome(options: {
  version: string;
  cwd: string;
  config: ForgeConfig;
  sessionId: string | null;
}): void {
  const { version, cwd, config, sessionId } = options;
  const model = config.model.name;
  const provider = config.model.provider;
  const host = config.model.baseUrl
    .replace(/^https?:\/\//, "")
    .replace(/\/v1$/, "")
    .replace(/\/anthropic$/, "");

  console.log("");
  console.log(bold(`  Forge ${version}`) + dim(" — local coding agent"));
  console.log("");
  console.log(`  ${dim("Workspace")}  ${resolve(cwd)}`);
  const providerLabel = provider ? `${cyan(provider)} / ` : "";
  console.log(
    `  ${dim("Model")}      ${providerLabel}${cyan(model)} ${dim("@")} ${host}`,
  );
  console.log(`  ${dim("API Key")}     ${maskApiKey(config.model.apiKey)}`);
  console.log(
    `  ${dim("Session")}     ${sessionId ? sessionId.slice(0, 8) + "…" : dim("(new conversation)")}`,
  );
  console.log("");
  printWelcomeCommandHints();
}

export { printHelp } from "./commands-hint.js";
