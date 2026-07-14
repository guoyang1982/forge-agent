#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAEMON_METHODS,
  type AgentEvent,
  type CompactSessionResult,
  type HireTalentResult,
  type ListTalentRosterResult,
  type ListTalentTemplatesResult,
  type RenameTalentResult,
  type UpdateTalentBindingsResult,
  type ListSessionsResult,
  type SessionListItem,
  type TalentSyncResult,
} from "@forge/protocol";
import { connectDaemon } from "@forge/bus";
import { formatSessionsList } from "@forge/session-manager";
import {
  collectPluginMcpServers,
  collectPluginSkillPaths,
  discoverPlugins,
  readPluginManifest,
  type DiscoveredPlugin,
} from "@forge/plugin-registry";
import { generateAgentsMd } from "@forge/project-rules";
import { detectRunHints } from "@forge/workspace";
import {
  loadConfig,
  saveConfig,
  saveModelSelection,
  getDataDir,
  getConfigPath,
  setConfigPath,
  formatConfigForDisplay,
  findProjectConfig,
  buildConfigPatchFromDotKey,
} from "@forge/config";
import {
  importFromCatalog,
  importPluginFromGitHub,
  importSkillFromGitHub,
  listCatalog,
  setPluginEnabled as savePluginEnabled,
  setSkillEnabled as saveSkillEnabled,
} from "@forge/marketplace";
import { homedir } from "node:os";
import { startRepl } from "./repl.js";
import { ensureDaemon } from "./daemon-util.js";
import {
  applyPendingPatches,
  createEventPrinter,
  executeRun,
  printRunError,
} from "./runner.js";
import { printNextSteps } from "./next-steps.js";
import { askPatchConfirmOnce } from "./patch-confirm.js";
import { wrapRunEventHandler } from "./network-confirm.js";
import { createProgressReporter } from "./progress.js";
import { runModelCommand } from "./model-cli.js";
import { registerAutomationCommands } from "./automation-cli.js";
import { registerExtCommands } from "./ext-cli.js";

export const VERSION = "0.2.0";
const __dirname = dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = join(__dirname, "..", "..", "..");

const program = new Command();

program
  .name("forge")
  .description("Forge — local coding agent (like Claude Code)")
  .version(VERSION)
  .option(
    "-C, --config <path>",
    "use custom config file (or set FORGE_CONFIG_PATH)",
  )
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts() as { config?: string };
    if (opts.config) setConfigPath(opts.config);
  });

program
  .command("chat")
  .description("Interactive chat (default)")
  .option("-c, --cwd <path>", "workspace directory", process.cwd())
  .option("-y, --yes", "auto-apply patches")
  .action(async (opts: { cwd: string; yes?: boolean }) => {
    await startRepl({ cwd: opts.cwd, yes: opts.yes, version: VERSION });
  });

program
  .command("init")
  .description("Initialize config file and data directory")
  .option("--example", "print example config JSON to stdout")
  .option("--agents", "create AGENTS.md for this project")
  .option("-c, --cwd <path>", "workspace directory", process.cwd())
  .option("--force", "overwrite AGENTS.md if it already exists")
  .action((opts: { example?: boolean; agents?: boolean; cwd: string; force?: boolean }) => {
    if (opts.example) {
      const example = join(
        new URL("../../../config.example.json", import.meta.url).pathname,
      );
      if (existsSync(example)) {
        console.log(readFileSync(example, "utf-8"));
      }
      return;
    }
    if (opts.agents) {
      initAgentsMd(opts.cwd, Boolean(opts.force));
      return;
    }
    const cfg = loadConfig();
    console.log(`Config file: ${getConfigPath()}`);
    console.log(`Data dir:    ${getDataDir()}`);
    console.log(`Socket:      ${cfg.daemon.socketPath}`);
  });

function initAgentsMd(cwd: string, force: boolean): void {
  const target = join(cwd, "AGENTS.md");
  if (existsSync(target) && !force) {
    console.log(`AGENTS.md already exists: ${target}`);
    console.log("Use `forge init --agents --force` to overwrite it.");
    return;
  }

  const hints = detectRunHints(cwd, []);
  const runCommands = hints.hints
    .filter((hint) => !/test/i.test(hint.label))
    .map((hint) => hint.command);
  const testCommands = hints.hints
    .filter((hint) => /test/i.test(hint.label))
    .map((hint) => hint.command);

  const pkgPath = join(cwd, "package.json");
  const projectName = existsSync(pkgPath)
    ? readPackageName(pkgPath) || basename(cwd)
    : basename(cwd);

  const content = generateAgentsMd({
    projectName,
    runCommands: runCommands.length ? runCommands : undefined,
    testCommands: testCommands.length ? testCommands : undefined,
    conventions: [
      "Follow existing project patterns before adding new abstractions.",
      "Keep changes scoped and avoid unrelated refactors.",
      "Prefer focused tests or run commands for changed behavior.",
    ],
  });

  writeFileSync(target, content, "utf-8");
  console.log(`${force ? "Updated" : "Created"} ${target}`);
  console.log("Agents can now read this project guidance automatically.");
}

function readPackageName(pkgPath: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
    return pkg.name;
  } catch {
    return undefined;
  }
}

program
  .command("config")
  .description("Show or edit configuration")
  .argument("[action]", "show | path | set")
  .argument("[key]", "e.g. model.apiKey (for set)")
  .argument("[value]", "value (for set)")
  .action((action?: string, key?: string, value?: string) => {
    const act = action ?? "show";
    if (act === "show" || act === "path") {
      if (act === "path") {
        console.log(getConfigPath());
        return;
      }
      const cfg = loadConfig({ cwd: process.cwd() });
      console.log(JSON.stringify(formatConfigForDisplay(cfg), null, 2));
      const proj = findProjectConfig(process.cwd());
      if (proj) console.log(`\nProject overlay: ${proj}`);
      return;
    }
    if (act === "set") {
      if (!key || value === undefined) {
        console.error("Usage: forge config set <key> <value>");
        process.exit(1);
      }
      const cfg = loadConfig();
      if (key === "model.provider") {
        saveModelSelection(value);
        console.log(`Updated provider → ${value}`);
        return;
      }
      try {
        const patch = buildConfigPatchFromDotKey(key, value, cfg);
        saveConfig(patch);
        console.log(`Updated ${getConfigPath()} → ${key}`);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exit(1);
      }
      return;
    }
    console.error("Usage: forge config show | path | set <key> <value>");
    process.exit(1);
  });

program
  .command("model")
  .description("List or switch LLM provider / model")
  .argument("[action]", "list | use | providers", "list")
  .argument("[provider]", "provider id (for use)")
  .argument("[modelId]", "model id (for use)")
  .action((action?: string, provider?: string, modelId?: string) => {
    runModelCommand(action, provider, modelId);
  });

program
  .command("skills")
  .description("Manage Agent Skills (install, enable, catalog)")
  .argument("[action]", "list | enable | disable | import | catalog", "list")
  .argument("[arg]", "skill id, GitHub URL, or catalog id")
  .option("-c, --cwd <path>", "workspace directory", process.cwd())
  .option("--project", "write enable state to <cwd>/.forge/config.json")
  .option("--force", "overwrite existing install")
  .option("--catalog <id>", "install from built-in catalog")
  .action(async (action: string, arg: string | undefined, opts) => {
    const act = action ?? "list";
    if (act === "catalog") {
      const items = listCatalog(arg);
      if (!items.length) {
        console.log("No catalog entries matched.");
        return;
      }
      for (const item of items) {
        console.log(`${item.id}  [${item.kind}]  ${item.name}`);
        console.log(`  ${item.description}`);
        console.log(`  repo: ${item.repo}`);
      }
      return;
    }
    if (act === "import") {
      const catalogId = opts.catalog ?? (arg && !arg.includes("/") ? arg : undefined);
      const source = opts.catalog ? undefined : arg;
      if (!catalogId && !source) {
        console.error(
          "Usage: forge skills import <github-url|owner/repo> | forge skills import --catalog excalidraw-diagram",
        );
        process.exit(1);
      }
      const destDir = userSkillsInstallDir();
      const result = catalogId
        ? await importFromCatalog({
            catalogId,
            kind: "skill",
            destDir,
            force: Boolean(opts.force),
          })
        : await importSkillFromGitHub({
            source: source!,
            destDir,
            force: Boolean(opts.force),
          });
      saveSkillEnabled(result.id, true);
      console.log(`Installed skill ${result.name} → ${result.path}`);
      const cfg = loadConfig();
      await reloadRuntimeIfPossible(cfg.daemon.socketPath);
      return;
    }
    if (act === "enable" || act === "disable") {
      if (!arg) {
        console.error(`Usage: forge skills ${act} <skill-id>`);
        process.exit(1);
      }
      saveSkillEnabled(arg, act === "enable", {
        cwd: opts.cwd,
        project: Boolean(opts.project),
      });
      console.log(`${act === "enable" ? "Enabled" : "Disabled"} skill: ${arg}`);
      const cfg = loadConfig({ cwd: opts.cwd });
      await reloadRuntimeIfPossible(cfg.daemon.socketPath);
      return;
    }
    if (act === "list") {
      const cfg = loadConfig({ cwd: opts.cwd });
      await ensureDaemon(cfg.daemon.socketPath);
      const result = (await requestDaemon(
        cfg.daemon.socketPath,
        DAEMON_METHODS.LIST_SKILLS,
        { cwd: opts.cwd },
      )) as { groups?: Array<{ title: string; skills: Array<{ id: string; enabled?: boolean }> }> };
      for (const group of result.groups ?? []) {
        console.log(`\n${group.title}`);
        for (const skill of group.skills ?? []) {
          const state = skill.enabled === false ? "disabled" : "enabled";
          console.log(`  ${skill.id}  ${state}`);
        }
      }
      return;
    }
    console.error(
      "Usage: forge skills list | catalog [query] | import <url> | import --catalog <id> | enable|disable <id>",
    );
    process.exit(1);
  });

program
  .command("plugins")
  .description("Manage Forge plugins")
  .argument("[action]", "list | enable | disable | validate | import", "list")
  .argument("[pluginId]", "plugin id for enable/disable/validate/import")
  .option("-c, --cwd <path>", "workspace directory", process.cwd())
  .option("--project", "write plugin state to <cwd>/.forge/config.json")
  .option("--force", "overwrite existing install")
  .option("--catalog <id>", "install from built-in catalog")
  .action(async (action: string, pluginId: string | undefined, opts) => {
    const act = action ?? "list";
    if (act === "import") {
      const catalogId = opts.catalog ?? (pluginId && !pluginId.includes("/") ? pluginId : undefined);
      const source = opts.catalog ? undefined : pluginId;
      if (!catalogId && !source) {
        console.error(
          "Usage: forge plugins import <github-url|owner/repo> | forge plugins import --catalog <id>",
        );
        process.exit(1);
      }
      const destDir = userPluginsInstallDir();
      const result = catalogId
        ? await importFromCatalog({
            catalogId,
            kind: "plugin",
            destDir,
            force: Boolean(opts.force),
          })
        : await importPluginFromGitHub({
            source: source!,
            destDir,
            force: Boolean(opts.force),
          });
      savePluginEnabled(result.id, true);
      console.log(`Installed plugin ${result.name} → ${result.path}`);
      const cfg = loadConfig();
      await reloadRuntimeIfPossible(cfg.daemon.socketPath);
      return;
    }
    if (act === "list") {
      printPlugins(opts.cwd);
      return;
    }
    if (act === "enable" || act === "disable") {
      if (!pluginId) {
        console.error(`Usage: forge plugins ${act} <plugin-id>`);
        process.exit(1);
      }
      const cfg = savePluginEnabled(pluginId, act === "enable", {
        cwd: opts.cwd,
        project: Boolean(opts.project),
      });
      const scope = opts.project ? "project" : "global";
      console.log(`${act === "enable" ? "Enabled" : "Disabled"} plugin: ${pluginId} (${scope})`);
      await reloadRuntimeIfPossible(cfg.daemon.socketPath);
      return;
    }
    if (act === "validate") {
      validatePlugin(pluginId, opts.cwd);
      return;
    }
    console.error(
      "Usage: forge plugins list | import <url> | enable|disable <id> | validate [id]",
    );
    process.exit(1);
  });

program
  .command("talents")
  .description("Manage hired AI talents")
  .argument("[action]", "sync | catalog | hire | list | fire | rename | bind", "list")
  .argument("[arg]", "category, template id, or hired talent mention")
  .option("-c, --cwd <path>", "workspace directory", process.cwd())
  .option("--name <name>", "display name when hiring or renaming")
  .option("--mention <mention>", "@mention handle when hiring or renaming")
  .option("--categories <list>", "comma-separated categories for sync")
  .option("--source <dir>", "import from a local agency-agents checkout (skips GitHub)")
  .option("--timeout-ms <ms>", "GitHub fetch timeout in milliseconds", "30000")
  .option("--skills <list>", "comma-separated skill ids (bind)")
  .option("--tools <list>", "comma-separated tool names (bind)")
  .option("--enable", "enable hired talent (bind)")
  .option("--disable", "disable hired talent (bind)")
  .option("-q, --query <query>", "catalog search query")
  .action(async (action: string, arg: string | undefined, opts) => {
    const act = action ?? "list";
    const cfg = loadConfig({ cwd: opts.cwd });
    await ensureDaemon(cfg.daemon.socketPath);

    if (act === "sync") {
      const categories = opts.categories
        ? String(opts.categories).split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      const timeoutMs = opts.timeoutMs ? Number(opts.timeoutMs) : undefined;
      if (opts.timeoutMs && (!timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        console.error("--timeout-ms must be a positive number");
        process.exit(1);
      }
      const result = (await requestDaemon(
        cfg.daemon.socketPath,
        DAEMON_METHODS.TALENTS_SYNC_TEMPLATES,
        {
          categories,
          sourceDir: opts.source ? resolve(String(opts.source)) : undefined,
          timeoutMs,
        },
      )) as TalentSyncResult;
      const skipped = result.skipped ? ` (${result.skipped} skipped)` : "";
      const via = result.source === "local" ? "from local source" : "from GitHub";
      console.log(`Synced ${result.count} talent templates ${via}${skipped}.`);
      if (result.notice) console.warn(result.notice);
      return;
    }

    if (act === "catalog") {
      const result = (await requestDaemon(
        cfg.daemon.socketPath,
        DAEMON_METHODS.TALENTS_LIST_TEMPLATES,
        { category: arg, query: opts.query },
      )) as ListTalentTemplatesResult;
      if (!result.templates.length) {
        console.log("No talent templates found. Run `forge talents sync` first.");
        return;
      }
      for (const item of result.templates) {
        const hired = item.hired ? " hired" : "";
        const icon = item.emoji ? `${item.emoji} ` : "";
        console.log(`${icon}${item.id}  [${item.category}]${hired}`);
        console.log(`  ${item.role}${item.vibe ? ` — ${item.vibe}` : ""}`);
        if (item.description) console.log(`  ${item.description}`);
      }
      return;
    }

    if (act === "hire") {
      if (!arg) {
        console.error("Usage: forge talents hire <template-id> [--name Nova] [--mention nova]");
        process.exit(1);
      }
      const result = (await requestDaemon(
        cfg.daemon.socketPath,
        DAEMON_METHODS.TALENTS_HIRE,
        { templateId: arg, displayName: opts.name, mention: opts.mention, cwd: opts.cwd },
      )) as HireTalentResult;
      console.log(`Hired ${result.talent.displayName} (@${result.talent.mention}) — ${result.talent.role}`);
      await reloadRuntimeIfPossible(cfg.daemon.socketPath);
      return;
    }

    if (act === "rename") {
      if (!arg) {
        console.error("Usage: forge talents rename <mention> [--name Nova] [--mention nova2]");
        process.exit(1);
      }
      const result = (await requestDaemon(
        cfg.daemon.socketPath,
        DAEMON_METHODS.TALENTS_RENAME,
        {
          instanceIdOrMention: arg,
          displayName: opts.name,
          mention: opts.mention,
          cwd: opts.cwd,
        },
      )) as RenameTalentResult;
      console.log(`Renamed to ${result.talent.displayName} (@${result.talent.mention})`);
      await reloadRuntimeIfPossible(cfg.daemon.socketPath);
      return;
    }

    if (act === "bind") {
      if (!arg) {
        console.error("Usage: forge talents bind <mention> [--skills a,b] [--tools read_file,grep] [--enable|--disable]");
        process.exit(1);
      }
      const skills = splitCsvOption(opts.skills);
      const tools = splitCsvOption(opts.tools);
      const enabled =
        opts.enable ? true : opts.disable ? false : undefined;
      if (!skills && !tools && enabled === undefined) {
        console.error("Provide --skills, --tools, and/or --enable|--disable");
        process.exit(1);
      }
      const result = (await requestDaemon(
        cfg.daemon.socketPath,
        DAEMON_METHODS.TALENTS_UPDATE_BINDINGS,
        {
          instanceIdOrMention: arg,
          skills,
          tools,
          enabled,
          cwd: opts.cwd,
        },
      )) as UpdateTalentBindingsResult;
      const state = result.talent.enabled ? "enabled" : "disabled";
      console.log(
        `Updated @${result.talent.mention}: [${state}] tools=${result.talent.tools.join(", ") || "none"}`,
      );
      await reloadRuntimeIfPossible(cfg.daemon.socketPath);
      return;
    }

    if (act === "fire") {
      if (!arg) {
        console.error("Usage: forge talents fire <instance-id|mention>");
        process.exit(1);
      }
      const result = (await requestDaemon(
        cfg.daemon.socketPath,
        DAEMON_METHODS.TALENTS_FIRE,
        { instanceIdOrMention: arg, cwd: opts.cwd },
      )) as { removed: boolean };
      console.log(result.removed ? `Removed talent ${arg}.` : `Talent not found: ${arg}`);
      if (result.removed) await reloadRuntimeIfPossible(cfg.daemon.socketPath);
      return;
    }

    if (act === "list") {
      const result = (await requestDaemon(
        cfg.daemon.socketPath,
        DAEMON_METHODS.TALENTS_LIST_ROSTER,
        { cwd: opts.cwd },
      )) as ListTalentRosterResult;
      if (!result.talents.length) {
        console.log("No hired talents yet. Run `forge talents catalog` then `forge talents hire <template-id>`.");
        return;
      }
      for (const talent of result.talents) {
        const state = talent.enabled ? "enabled" : "disabled";
        console.log(`${talent.displayName}  @${talent.mention}  ${talent.role}  [${state}]`);
        console.log(`  ${talent.category} · ${talent.permissionPreset} · skills: ${talent.skills.join(", ") || "none"}`);
        console.log(`  tasks: ${talent.stats.tasksDone} · last used: ${talent.stats.lastUsed ?? "never"}`);
      }
      return;
    }

    console.error(
      "Usage: forge talents sync | catalog [category] | hire <id> | list | fire <mention> | rename <mention> | bind <mention>",
    );
    process.exit(1);
  });

program
  .command("status")
  .description("Show daemon and runtime status")
  .option("--json", "print raw JSON")
  .action(async (opts: { json?: boolean }) => {
    const cfg = loadConfig();
    await ensureDaemon(cfg.daemon.socketPath);
    const result = await requestDaemon(cfg.daemon.socketPath, DAEMON_METHODS.STATUS);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const status = result as {
      version: string;
      activeRun: boolean;
      runtime: { loaded: boolean; skills: number; plugins: number };
      sessions: { count: number };
    };
    console.log(`Forge daemon ${status.version}`);
    console.log(`Active run: ${status.activeRun ? "yes" : "no"}`);
    console.log(
      `Runtime: ${status.runtime.loaded ? "loaded" : "not loaded"} · ${status.runtime.skills} skills · ${status.runtime.plugins} plugins`,
    );
    console.log(`Sessions: ${status.sessions.count}`);
  });

program
  .command("sessions")
  .description("List recent sessions")
  .option("-n, --limit <number>", "number of sessions", "12")
  .option("--json", "print raw JSON")
  .action(async (opts: { limit: string; json?: boolean }) => {
    const cfg = loadConfig();
    await ensureDaemon(cfg.daemon.socketPath);
    const result = (await requestDaemon(
      cfg.daemon.socketPath,
      DAEMON_METHODS.LIST_SESSIONS,
      { limit: parseInt(opts.limit, 10) || 12 },
    )) as ListSessionsResult;
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(formatSessionsList(result.sessions));
  });

program
  .command("session")
  .description("Show one session from recent history")
  .argument("<session-id-prefix>", "session id or prefix")
  .option("--json", "print raw JSON")
  .action(async (prefix: string, opts: { json?: boolean }) => {
    const cfg = loadConfig();
    await ensureDaemon(cfg.daemon.socketPath);
    const result = (await requestDaemon(
      cfg.daemon.socketPath,
      DAEMON_METHODS.LIST_SESSIONS,
      { limit: 100 },
    )) as ListSessionsResult;
    const session = resolveSessionPrefix(result.sessions, prefix);
    if (!session) process.exit(1);
    if (opts.json) {
      console.log(JSON.stringify(session, null, 2));
      return;
    }
    console.log(formatSessionsList([session], session.id));
  });

program
  .command("compact")
  .description("Compact a session using model summary when available")
  .argument("<session-id-prefix>", "session id or prefix")
  .option("--keep-last <number>", "messages to keep after summary", "12")
  .option("--json", "print raw JSON")
  .action(async (prefix: string, opts: { keepLast: string; json?: boolean }) => {
    const cfg = loadConfig();
    await ensureDaemon(cfg.daemon.socketPath);
    const sessions = (await requestDaemon(
      cfg.daemon.socketPath,
      DAEMON_METHODS.LIST_SESSIONS,
      { limit: 100 },
    )) as ListSessionsResult;
    const session = resolveSessionPrefix(sessions.sessions, prefix);
    if (!session) process.exit(1);
    const result = (await requestDaemon(
      cfg.daemon.socketPath,
      DAEMON_METHODS.COMPACT_SESSION,
      {
        sessionId: session.id,
        keepLast: parseInt(opts.keepLast, 10) || 12,
      },
    )) as CompactSessionResult;
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `Compacted ${result.sessionId.slice(0, 8)} (${result.mode}): summarized ${result.summarizedMessages}, kept ${result.keptMessages}`,
    );
    if (result.summaryPreview) console.log(`Summary: ${result.summaryPreview}`);
  });

program
  .command("plan")
  .description("Generate a read-only implementation plan")
  .argument("<goal>", "planning goal")
  .option("-c, --cwd <path>", "workspace directory", process.cwd())
  .option("-f, --file <paths...>", "include files in context")
  .option("--json", "print structured JSON")
  .action(async (goal: string, opts: { cwd: string; file?: string[]; json?: boolean }) => {
    const cfg = loadConfig({ cwd: opts.cwd });
    await ensureDaemon(cfg.daemon.socketPath);
    const progress = opts.json
      ? null
      : createProgressReporter({
          quietSession: true,
          thinking: cfg.ui?.thinking ?? "collapse",
          progress: cfg.ui?.progress ?? "compact",
        });
    const result = (await requestDaemon(
      cfg.daemon.socketPath,
      DAEMON_METHODS.PLAN,
      {
        cwd: opts.cwd,
        message: goal,
        files: opts.file,
      },
      progress ? (event) => progress.handle(event) : undefined,
    )) as { text?: string; structured?: unknown };
    progress?.finish();
    console.log(
      opts.json
        ? JSON.stringify(result.structured ?? { text: result.text ?? "" }, null, 2)
        : `\n${result.text ?? ""}\n`,
    );
  });

program
  .command("review")
  .description("Review current git diff")
  .option("-c, --cwd <path>", "workspace directory", process.cwd())
  .option("-f, --file <paths...>", "include files in review")
  .option("--json", "print structured JSON")
  .action(async (opts: { cwd: string; file?: string[]; json?: boolean }) => {
    const cfg = loadConfig({ cwd: opts.cwd });
    await ensureDaemon(cfg.daemon.socketPath);
    const progress = opts.json
      ? null
      : createProgressReporter({
          quietSession: true,
          thinking: cfg.ui?.thinking ?? "collapse",
          progress: cfg.ui?.progress ?? "compact",
        });
    const result = (await requestDaemon(
      cfg.daemon.socketPath,
      DAEMON_METHODS.REVIEW,
      {
        cwd: opts.cwd,
        files: opts.file,
      },
      progress ? (event) => progress.handle(event) : undefined,
    )) as { text?: string; structured?: unknown };
    progress?.finish();
    console.log(
      opts.json
        ? JSON.stringify(result.structured ?? { text: result.text ?? "" }, null, 2)
        : `\n${result.text ?? ""}\n`,
    );
  });

function managedPluginDirs(cwd: string): {
  builtinDir: string;
  userDir: string;
  projectDir: string;
} {
  return {
    builtinDir: join(MONOREPO_ROOT, "plugins"),
    userDir: join(getDataDir(), "plugins"),
    projectDir: join(cwd, ".forge", "plugins"),
  };
}

function loadManagedPlugins(cwd: string): DiscoveredPlugin[] {
  return discoverPlugins({
    ...managedPluginDirs(cwd),
    config: loadConfig({ cwd }),
  });
}

function printPlugins(cwd: string): void {
  const plugins = loadManagedPlugins(cwd);
  if (!plugins.length) {
    console.log("No plugins found.");
    console.log(`Search paths:`);
    const dirs = managedPluginDirs(cwd);
    console.log(`  builtin: ${dirs.builtinDir}`);
    console.log(`  user:    ${dirs.userDir}`);
    console.log(`  project: ${dirs.projectDir}`);
    return;
  }

  for (const plugin of plugins) {
    const state = plugin.enabled ? "enabled" : "disabled";
    const caps = plugin.manifest.capabilities ?? {};
    const parts = [
      `${caps.skills?.length ?? 0} skills`,
      `${caps.mcpServers?.length ?? 0} MCP`,
      `${caps.commands?.length ?? 0} commands`,
      `${caps.workflows?.length ?? 0} workflows`,
    ];
    console.log(
      `${plugin.manifest.id}  ${state}  ${plugin.source}  v${plugin.manifest.version}`,
    );
    console.log(`  ${plugin.manifest.name}`);
    if (plugin.manifest.description) console.log(`  ${plugin.manifest.description}`);
    console.log(`  ${parts.join(" · ")}`);
    console.log(`  root: ${plugin.root}`);
  }

  const enabled = plugins.filter((p) => p.enabled);
  const skillCount = collectPluginSkillPaths(enabled).length;
  const mcpCount = collectPluginMcpServers(enabled).length;
  console.log(`\nEnabled contributions: ${skillCount} skills, ${mcpCount} MCP servers`);
}

function userSkillsInstallDir(): string {
  return join(homedir(), ".forge-agent", "skills");
}

function userPluginsInstallDir(): string {
  return join(getDataDir(), "plugins");
}

function splitCsvOption(value: unknown): string[] | undefined {
  if (value == null || value === "") return undefined;
  const items = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

async function reloadRuntimeIfPossible(socketPath: string): Promise<void> {
  try {
    const result = (await requestDaemon(
      socketPath,
      DAEMON_METHODS.RELOAD_RUNTIME,
    )) as { skills?: number; plugins?: number };
    console.log(
      `Runtime reloaded: ${result.skills ?? 0} skills, ${result.plugins ?? 0} plugins.`,
    );
  } catch {
    console.log("Daemon not running; changes will apply on next daemon start.");
  }
}

function validatePlugin(pluginId: string | undefined, cwd: string): void {
  const dirs = managedPluginDirs(cwd);
  const roots = [
    ...pluginRoots(dirs.builtinDir),
    ...pluginRoots(dirs.userDir),
    ...pluginRoots(dirs.projectDir),
  ];

  if (!roots.length) {
    console.log(pluginId ? `Plugin not found: ${pluginId}` : "No plugins found.");
    return;
  }

  let matched = 0;
  for (const root of roots) {
    try {
      const manifest = readPluginManifest(root);
      if (pluginId && manifest.id !== pluginId && basename(root) !== pluginId) {
        continue;
      }
      matched++;
      console.log(`ok ${manifest.id} (${root})`);
    } catch (e) {
      if (pluginId && basename(root) !== pluginId) continue;
      matched++;
      console.log(`fail ${root}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (pluginId && matched === 0) console.log(`Plugin not found: ${pluginId}`);
}

function pluginRoots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((root) => existsSync(join(root, "plugin.json")));
}

function resolveSessionPrefix(
  sessions: SessionListItem[],
  prefix: string,
): SessionListItem | null {
  const matches = sessions.filter((session) => session.id.startsWith(prefix));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    console.error(`Session not found: ${prefix}`);
    return null;
  }
  console.error("Multiple sessions matched. Use a longer id prefix:");
  console.error(formatSessionsList(matches));
  return null;
}

async function requestDaemon(
  socketPath: string,
  method: string,
  params?: unknown,
  onEvent?: (event: AgentEvent) => void,
): Promise<unknown> {
  const client = await connectDaemon(socketPath);
  try {
    return await client.request(method, params, onEvent);
  } finally {
    client.close();
  }
}

program
  .command("daemon")
  .description("Manage daemon")
  .argument("<action>", "start | status | stop")
  .action(async (action: string) => {
    const cfg = loadConfig();
    const pidFile = join(cfg.daemon.dataDir, "daemon.pid");

    if (action === "status") {
      if (existsSync(pidFile)) {
        console.log(`Daemon pid ${readFileSync(pidFile, "utf-8").trim()}`);
        try {
          const client = await connectDaemon(cfg.daemon.socketPath);
          console.log(
            JSON.stringify(await client.request(DAEMON_METHODS.STATUS), null, 2),
          );
          client.close();
        } catch {
          console.log("Socket not responding");
        }
      } else {
        console.log("Daemon not running");
      }
      return;
    }

    if (action === "start") {
      await ensureDaemon(cfg.daemon.socketPath);
      console.log("Daemon running");
      return;
    }

    if (action === "stop") {
      if (existsSync(pidFile)) {
        process.kill(parseInt(readFileSync(pidFile, "utf-8"), 10), "SIGTERM");
        console.log("Stopped");
      }
      return;
    }
    console.error("Use: start | status | stop");
  });

program
  .command("ping")
  .description("Check daemon connectivity")
  .action(async () => {
    const cfg = loadConfig();
    const client = await connectDaemon(cfg.daemon.socketPath);
    console.log(JSON.stringify(await client.request(DAEMON_METHODS.PING), null, 2));
    client.close();
  });

program
  .command("run")
  .description("Run a single task (non-interactive)")
  .argument("<message>", "task description")
  .option("-c, --cwd <path>", "workspace directory", process.cwd())
  .option("-y, --yes", "auto-apply patches")
  .option("--runtime <provider>", "agent runtime: forge | codex | claude-code | cursor", "forge")
  .option("--model <model>", "runtime model override")
  .option("--permission-mode <mode>", "runtime permission/approval mode")
  .option("--sandbox-mode <mode>", "runtime sandbox mode")
  .option("--json", "print events as JSON")
  .option("-f, --file <paths...>", "include files in context")
  .action(async (message: string, opts) => {
    const cfg = loadConfig();
    await ensureDaemon(cfg.daemon.socketPath);

    const client = await connectDaemon(cfg.daemon.socketPath);
    const pending: Array<{ path: string; unifiedDiff: string }> = [];
    const appliedDuringRun: string[] = [];

    try {
      if (!opts.json) process.stderr.write("\x1b[2m  Working…\x1b[0m\n");
      const basePrintEvent = opts.json
        ? (event: AgentEvent) => console.log(JSON.stringify(event))
        : createEventPrinter(pending, {
            appliedPaths: appliedDuringRun,
            thinking: cfg.ui?.thinking ?? "collapse",
            progress: cfg.ui?.progress ?? "compact",
          });
      const printEvent = wrapRunEventHandler(basePrintEvent, {
        socketPath: cfg.daemon.socketPath,
      });
      await executeRun(client, {
        cwd: opts.cwd,
        message,
        runtime:
          opts.runtime && opts.runtime !== "forge"
            ? {
                provider: opts.runtime,
                model: opts.model,
                permissionMode: opts.permissionMode,
                sandboxMode: opts.sandboxMode,
              }
            : undefined,
        autoApply: opts.yes,
        files: opts.file,
        onEvent: printEvent,
      });

      if (!opts.json) {
        const appliedFromConfirm = await applyPendingPatches(
          client,
          opts.cwd,
          pending,
          Boolean(opts.yes),
          askPatchConfirmOnce,
        );
        const allChanged = [...appliedDuringRun, ...appliedFromConfirm];
        if (allChanged.length) printNextSteps(opts.cwd, allChanged);
      }
    } catch (e) {
      printRunError(e);
      client.close();
      process.exit(1);
    }
    client.close();
  });

registerAutomationCommands(program);
registerExtCommands(program);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `forge` with no args → interactive (like `claude`)
  if (argv.length === 0) {
    await startRepl({ cwd: process.cwd(), version: VERSION });
    return;
  }

  program.parse();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
