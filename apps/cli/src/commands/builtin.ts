import { join } from "node:path";
import { openPathWithDefaultApp, type SpawnDetached } from "@forge/platform";
import { DAEMON_METHODS } from "@forge/protocol";
import type {
  HireTalentResult,
  ListTalentRosterResult,
  ListTalentTemplatesResult,
} from "@forge/protocol";
import {
  formatProfilesList,
  formatProvidersList,
  loadConfig,
  maskApiKey,
  saveModelSelection,
} from "@forge/config";
import { runPrimaryHint } from "../next-steps.js";
import { createProgressReporter } from "../progress.js";
import type { SlashCommandRegistry } from "./registry.js";
import type { SlashCommand } from "./types.js";

export function openFileWithDefaultApp(
  cwd: string,
  pathArg: string,
  spawnImpl?: SpawnDetached,
): string {
  const target = join(cwd, pathArg);
  openPathWithDefaultApp(target, spawnImpl);
  return target;
}

export function builtinCommands(): SlashCommand[] {
  return [
    {
      name: "help",
      aliases: ["h", "?", "commands", "hints"],
      description: "显示帮助",
      run: (ctx) => ctx.printHelp(),
    },
    {
      name: "exit",
      aliases: ["quit", "q"],
      description: "退出 Forge",
      run: (ctx) => ctx.onExit(),
    },
    {
      name: "clear",
      aliases: ["new"],
      description: "开始新对话",
      run: async (ctx) => {
        await ctx.clearSession();
        console.log("Started a new conversation.");
      },
    },
    {
      name: "cwd",
      description: "查看或切换工作区",
      usage: "/cwd [path]",
      run: async (ctx, args) => {
        if (args) {
          await ctx.setCwd(args);
          console.log(`Workspace: ${ctx.getCwd()}`);
        } else {
          console.log(ctx.getCwd());
        }
      },
    },
    {
      name: "session",
      description: "显示当前 session id",
      run: (ctx) => {
        console.log(ctx.getSession() ?? "(none)");
      },
    },
    {
      name: "sessions",
      aliases: ["ls"],
      description: "列出最近会话",
      run: async (ctx) => {
        await ctx.listSessions();
      },
    },
    {
      name: "resume",
      aliases: ["r"],
      description: "恢复一个历史会话",
      usage: "/resume <session-id-prefix>",
      run: async (ctx, args) => {
        if (!args) {
          console.log("\x1b[33m用法:\x1b[0m /resume <session-id-prefix>\n");
          return;
        }
        await ctx.resumeSession(args.trim());
      },
    },
    {
      name: "compact",
      description: "压缩当前或指定会话历史",
      usage: "/compact [session-id-prefix]",
      run: async (ctx, args) => {
        await ctx.compactSession(args.trim() || undefined);
      },
    },
    {
      name: "plan",
      description: "生成只读计划（不修改文件）",
      usage: "/plan <goal>",
      run: async (ctx, args) => {
        if (!args) {
          console.log("\x1b[33m用法:\x1b[0m /plan <目标>\n");
          return;
        }
        const progress = createProgressReporter({ quietSession: true });
        const result = (await ctx.requestDaemon(
          DAEMON_METHODS.PLAN,
          {
            cwd: ctx.getCwd(),
            message: args,
          },
          (event) => progress.handle(event),
        )) as { text?: string };
        progress.finish();
        if (result.text) {
          console.log(`\n${result.text}\n`);
        }
      },
    },
    {
      name: "review",
      description: "审查当前未提交 diff",
      usage: "/review [file...]",
      run: async (ctx, args) => {
        const files = args ? args.split(/\s+/).filter(Boolean) : undefined;
        const progress = createProgressReporter({ quietSession: true });
        const result = (await ctx.requestDaemon(
          DAEMON_METHODS.REVIEW,
          {
            cwd: ctx.getCwd(),
            files,
          },
          (event) => progress.handle(event),
        )) as { text?: string };
        progress.finish();
        if (result.text) {
          console.log(`\n${result.text}\n`);
        }
      },
    },
    {
      name: "run",
      aliases: ["exec"],
      description: "运行建议命令",
      run: async (ctx) => {
        try {
          const changed = ctx.lastChanged();
          if (!changed.length) {
            console.log(
              "\x1b[33m提示:\x1b[0m 先让 Agent 改代码或指定文件后，/run 会执行建议命令（如 python3 xxx.py）\n",
            );
          }
          await runPrimaryHint(ctx.getCwd(), changed);
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      name: "model",
      aliases: ["m"],
      description: "查看或切换厂商/模型",
      usage: "/model [provider] [model-id]",
      run: (ctx, args) => {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (!parts.length) {
          const cfg = loadConfig({ cwd: ctx.getCwd() });
          console.log(formatProfilesList(cfg));
          console.log("");
          console.log(formatProvidersList());
          console.log("");
          console.log(
            `当前: [${cfg.activeProfile ?? "?"}] ${cfg.model.provider ?? "?"} / ${cfg.model.name} @ ${cfg.model.baseUrl}`,
          );
          console.log(`API Key: ${maskApiKey(cfg.model.apiKey)}`);
          console.log(
            "\x1b[2m切换: /model openai gpt-4o-mini  或  /model deepseek deepseek-v4-pro\x1b[0m\n",
          );
          return;
        }
        try {
          const next = saveModelSelection(parts[0], parts[1]);
          console.log(`已切换 → ${next.model.provider} / ${next.model.name}`);
          if (!next.model.apiKey) {
            console.log(
              "\x1b[33m请设置 API Key:\x1b[0m forge config set model.apiKey <KEY>\n",
            );
          }
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
        }
      },
    },
    {
      name: "talents",
      aliases: ["talent"],
      description: "列出人才市场模板",
      usage: "/talents [category]",
      run: async (ctx, args) => {
        const category = args.trim() || undefined;
        const result = (await ctx.requestDaemon(
          DAEMON_METHODS.TALENTS_LIST_TEMPLATES,
          { category, cwd: ctx.getCwd() },
        )) as ListTalentTemplatesResult;
        if (!result.templates.length) {
          console.log("No talent templates. Run `forge talents sync` first.");
          return;
        }
        for (const item of result.templates.slice(0, 40)) {
          const hired = item.hired ? " hired" : "";
          console.log(`${item.id}  [${item.category}]${hired} — ${item.role}`);
        }
        if (result.templates.length > 40) {
          console.log(`… and ${result.templates.length - 40} more (narrow with /talents <category>)`);
        }
      },
    },
    {
      name: "roster",
      description: "列出已租用人才",
      run: async (ctx) => {
        const result = (await ctx.requestDaemon(
          DAEMON_METHODS.TALENTS_LIST_ROSTER,
          { cwd: ctx.getCwd() },
        )) as ListTalentRosterResult;
        if (!result.talents.length) {
          console.log("No hired talents. Use /hire <template-id> or `forge talents hire`.");
          return;
        }
        for (const talent of result.talents) {
          const state = talent.enabled ? "on" : "off";
          console.log(`${talent.displayName}  @${talent.mention}  ${talent.role}  [${state}]`);
        }
      },
    },
    {
      name: "hire",
      description: "从模板库租用人才",
      usage: "/hire <template-id> [--name Nova] [--mention nova]",
      run: async (ctx, args) => {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        if (!parts.length) {
          console.log("\x1b[33m用法:\x1b[0m /hire <template-id> [--name 显示名] [--mention handle]\n");
          return;
        }
        let templateId = parts[0];
        let displayName: string | undefined;
        let mention: string | undefined;
        for (let i = 1; i < parts.length; i++) {
          if (parts[i] === "--name" && parts[i + 1]) displayName = parts[++i];
          else if (parts[i] === "--mention" && parts[i + 1]) mention = parts[++i];
        }
        const result = (await ctx.requestDaemon(
          DAEMON_METHODS.TALENTS_HIRE,
          { templateId, displayName, mention, cwd: ctx.getCwd() },
        )) as HireTalentResult;
        console.log(`Hired ${result.talent.displayName} (@${result.talent.mention}) — ${result.talent.role}`);
        await ctx.requestDaemon(DAEMON_METHODS.RELOAD_RUNTIME, {});
      },
    },
    {
      name: "open",
      aliases: ["o"],
      description: "打开文件",
      usage: "/open <file>",
      run: (ctx, args) => {
        if (!args) {
          console.log(
            "\x1b[33m用法:\x1b[0m /open <文件路径>  例: /open TankBattle.py\n",
          );
          return;
        }
        try {
          openFileWithDefaultApp(ctx.getCwd(), args);
        } catch {
          console.log(join(ctx.getCwd(), args));
        }
      },
    },
  ];
}

export function registerBuiltinCommands(registry: SlashCommandRegistry): void {
  registry.registerMany(builtinCommands());
}
