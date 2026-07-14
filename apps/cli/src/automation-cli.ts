import { Command } from "commander";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { connectDaemon } from "@forge/bus";
import {
  DAEMON_METHODS,
  type AutomationDraft,
  type AutomationRecord,
  type AutomationRunRecord,
  type AutomationTemplate,
  type CreateAutomationResult,
  type DeleteAutomationResult,
  type ListAutomationRunsResult,
  type ListAutomationsResult,
  type ListAutomationTemplatesResult,
  type RunAutomationResult,
  type UpdateAutomationResult,
} from "@forge/protocol";
import { loadConfig } from "@forge/config";
import { ensureDaemon } from "./daemon-util.js";

const TEMPLATE_IDS = ["daily-brief", "weekly-review", "project-monitor"] as const;

async function requestDaemon(
  socketPath: string,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const client = await connectDaemon(socketPath);
  try {
    return await client.request(method, params);
  } finally {
    client.close();
  }
}

async function withDaemon<T>(
  cwd: string | undefined,
  fn: (socketPath: string) => Promise<T>,
): Promise<T> {
  const cfg = loadConfig(cwd ? { cwd } : undefined);
  await ensureDaemon(cfg.daemon.socketPath);
  return fn(cfg.daemon.socketPath);
}

async function confirmAction(message: string, yes?: boolean): Promise<boolean> {
  if (yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveConfirm) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolveConfirm(a === "y" || a === "yes");
    });
  });
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "-";
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function formatTrigger(automation: AutomationRecord): string {
  if (automation.trigger.type === "cron") {
    return automation.trigger.cron;
  }
  return "manual";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function formatTable(headers: string[], rows: string[][]): string {
  if (!rows.length) return "(none)";
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const pad = (value: string, index: number) => value.padEnd(widths[index]!);
  const headerLine = headers.map((header, index) => pad(header, index)).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows
    .map((row) => row.map((cell, index) => pad(cell ?? "", index)).join("  "))
    .join("\n");
  return `${headerLine}\n${separator}\n${body}`;
}

function formatAutomationsTable(automations: AutomationRecord[]): string {
  const rows = automations.map((automation) => [
    shortId(automation.id),
    automation.name,
    automation.enabled ? "yes" : "no",
    formatTrigger(automation),
    formatTimestamp(automation.nextRunAt ?? automation.lastRunAt),
    truncate(automation.cwd, 40),
  ]);
  return formatTable(
    ["ID", "Name", "Enabled", "Trigger", "Next/Last", "CWD"],
    rows,
  );
}

function formatRunsTable(runs: AutomationRunRecord[]): string {
  const rows = runs.map((run) => [
    shortId(run.id),
    run.status,
    run.trigger,
    formatTimestamp(run.startedAt),
    formatTimestamp(run.finishedAt),
    shortId(run.sessionId),
    truncate(run.error ?? run.preview ?? "-", 32),
  ]);
  return formatTable(
    ["ID", "Status", "Trigger", "Started", "Finished", "Session", "Summary"],
    rows,
  );
}

async function listAutomations(cwd?: string): Promise<AutomationRecord[]> {
  const result = (await withDaemon(cwd, (socketPath) =>
    requestDaemon(socketPath, DAEMON_METHODS.LIST_AUTOMATIONS, cwd ? { cwd } : undefined),
  )) as ListAutomationsResult;
  return result.automations;
}

function resolveAutomationPrefix(
  automations: AutomationRecord[],
  prefix: string,
): AutomationRecord | null {
  const matches = automations.filter(
    (automation) => automation.id === prefix || automation.id.startsWith(prefix),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    console.error(`Automation not found: ${prefix}`);
    return null;
  }
  console.error("Multiple automations matched. Use a longer id prefix:");
  console.error(formatAutomationsTable(matches));
  return null;
}

async function resolveAutomationId(prefix: string, cwd?: string): Promise<string | null> {
  const automations = await listAutomations(cwd);
  const match = resolveAutomationPrefix(automations, prefix);
  return match?.id ?? null;
}

async function fetchTemplate(templateId: string): Promise<AutomationTemplate | null> {
  const result = (await withDaemon(undefined, (socketPath) =>
    requestDaemon(socketPath, DAEMON_METHODS.LIST_AUTOMATION_TEMPLATES),
  )) as ListAutomationTemplatesResult;
  const template = result.templates.find((item) => item.id === templateId);
  if (template) return template;

  if ((TEMPLATE_IDS as readonly string[]).includes(templateId)) {
    console.error(`Template not found from daemon: ${templateId}`);
    console.error(`Known template ids: ${TEMPLATE_IDS.join(", ")}`);
    return null;
  }

  console.error(`Unknown template: ${templateId}`);
  console.error(`Available: ${result.templates.map((item) => item.id).join(", ")}`);
  return null;
}

function handleError(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

export function registerAutomationCommands(program: Command): void {
  const auto = program
    .command("automation")
    .description("Manage scheduled automations");

  auto
    .command("list")
    .description("List automations")
    .option("--cwd <path>", "filter by workspace directory")
    .action(async (opts: { cwd?: string }) => {
      try {
        const automations = await listAutomations(opts.cwd);
        console.log(formatAutomationsTable(automations));
      } catch (error) {
        handleError(error);
      }
    });

  auto
    .command("create")
    .description("Create an automation")
    .requiredOption("--name <name>", "automation name")
    .requiredOption("--prompt <prompt>", "task prompt")
    .requiredOption("--cwd <path>", "workspace directory")
    .option("--cron <expr>", "cron expression (omit for manual-only)")
    .option("--timezone <tz>", "IANA timezone for cron", "UTC")
    .option("--notify-ilink", "send successful run results to the latest bound WeChat iLink chat")
    .option(
      "--notify-channel <kind>",
      "send successful run results to a channel kind: ilink, feishu, dingtalk, http",
    )
    .option("--notify-channel-id <id>", "send notifications to a specific channel id")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (opts: {
      name: string;
      prompt: string;
      cwd: string;
      cron?: string;
      timezone: string;
      notifyIlink?: boolean;
      notifyChannel?: string;
      notifyChannelId?: string;
      yes?: boolean;
    }) => {
      try {
        const draft: AutomationDraft = {
          name: opts.name,
          prompt: opts.prompt,
          cwd: resolve(opts.cwd),
          timezone: opts.timezone,
        };
        if (opts.cron) draft.cron = opts.cron;
        const notifyKind = opts.notifyIlink
          ? "ilink"
          : opts.notifyChannel;
        if (notifyKind) {
          if (!["ilink", "feishu", "dingtalk", "http"].includes(notifyKind)) {
            throw new Error(`unsupported notify channel: ${notifyKind}`);
          }
          draft.notify = {
            enabled: true,
            channelKind: notifyKind as "ilink" | "feishu" | "dingtalk" | "http",
            channelId: opts.notifyChannelId,
          };
        }

        const confirmed = await confirmAction(
          `Create automation "${opts.name}" in ${draft.cwd}?`,
          opts.yes,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }

        const result = (await withDaemon(opts.cwd, (socketPath) =>
          requestDaemon(socketPath, DAEMON_METHODS.CREATE_AUTOMATION, {
            draft,
            skipConfirm: true,
          }),
        )) as CreateAutomationResult;
        console.log(`Created ${result.automation.name} (${shortId(result.automation.id)})`);
      } catch (error) {
        handleError(error);
      }
    });

  auto
    .command("run")
    .description("Run an automation now")
    .argument("<id>", "automation id or prefix")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      try {
        const automationId = await resolveAutomationId(id);
        if (!automationId) process.exit(1);

        const confirmed = await confirmAction(
          `Run automation ${shortId(automationId)} now?`,
          opts.yes,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }

        const result = (await withDaemon(undefined, (socketPath) =>
          requestDaemon(socketPath, DAEMON_METHODS.RUN_AUTOMATION, {
            id: automationId,
            trigger: "cli",
            skipConfirm: true,
          }),
        )) as RunAutomationResult;
        console.log(
          `Run ${shortId(result.run.id)} started (${result.run.status}) · session ${shortId(result.run.sessionId)}`,
        );
      } catch (error) {
        handleError(error);
      }
    });

  auto
    .command("enable")
    .description("Enable an automation")
    .argument("<id>", "automation id or prefix")
    .action(async (id: string) => {
      try {
        const automationId = await resolveAutomationId(id);
        if (!automationId) process.exit(1);

        const result = (await withDaemon(undefined, (socketPath) =>
          requestDaemon(socketPath, DAEMON_METHODS.UPDATE_AUTOMATION, {
            id: automationId,
            patch: { enabled: true },
          }),
        )) as UpdateAutomationResult;
        console.log(`Enabled ${result.automation.name} (${shortId(result.automation.id)})`);
      } catch (error) {
        handleError(error);
      }
    });

  auto
    .command("disable")
    .description("Disable an automation")
    .argument("<id>", "automation id or prefix")
    .action(async (id: string) => {
      try {
        const automationId = await resolveAutomationId(id);
        if (!automationId) process.exit(1);

        const result = (await withDaemon(undefined, (socketPath) =>
          requestDaemon(socketPath, DAEMON_METHODS.UPDATE_AUTOMATION, {
            id: automationId,
            patch: { enabled: false },
          }),
        )) as UpdateAutomationResult;
        console.log(`Disabled ${result.automation.name} (${shortId(result.automation.id)})`);
      } catch (error) {
        handleError(error);
      }
    });

  auto
    .command("delete")
    .description("Delete an automation")
    .argument("<id>", "automation id or prefix")
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      try {
        const automationId = await resolveAutomationId(id);
        if (!automationId) process.exit(1);

        const confirmed = await confirmAction(
          `Delete automation ${shortId(automationId)}?`,
          opts.yes,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }

        await withDaemon(undefined, (socketPath) =>
          requestDaemon(socketPath, DAEMON_METHODS.DELETE_AUTOMATION, {
            id: automationId,
            skipConfirm: true,
          }),
        );
        console.log(`Deleted ${shortId(automationId)}`);
      } catch (error) {
        handleError(error);
      }
    });

  auto
    .command("runs")
    .description("List runs for an automation")
    .argument("<id>", "automation id or prefix")
    .option("--limit <n>", "max runs to show", "20")
    .action(async (id: string, opts: { limit: string }) => {
      try {
        const automationId = await resolveAutomationId(id);
        if (!automationId) process.exit(1);

        const result = (await withDaemon(undefined, (socketPath) =>
          requestDaemon(socketPath, DAEMON_METHODS.LIST_AUTOMATION_RUNS, {
            automationId,
            limit: parseInt(opts.limit, 10) || 20,
          }),
        )) as ListAutomationRunsResult;
        console.log(formatRunsTable(result.runs));
      } catch (error) {
        handleError(error);
      }
    });

  auto
    .command("init")
    .description("Create an automation from a built-in template")
    .argument("<templateId>", "template id (e.g. daily-brief)")
    .option("--cwd <path>", "workspace directory", process.cwd())
    .option("-y, --yes", "skip confirmation prompt")
    .action(async (templateId: string, opts: { cwd: string; yes?: boolean }) => {
      try {
        const template = await fetchTemplate(templateId);
        if (!template) process.exit(1);

        const draft: AutomationDraft = {
          ...template.draft,
          cwd: resolve(opts.cwd),
        };

        const confirmed = await confirmAction(
          `Create "${template.name}" automation in ${draft.cwd}?`,
          opts.yes,
        );
        if (!confirmed) {
          console.log("Cancelled.");
          return;
        }

        const result = (await withDaemon(opts.cwd, (socketPath) =>
          requestDaemon(socketPath, DAEMON_METHODS.CREATE_AUTOMATION, {
            draft,
            skipConfirm: true,
          }),
        )) as CreateAutomationResult;
        console.log(
          `Created ${result.automation.name} from template ${templateId} (${shortId(result.automation.id)})`,
        );
      } catch (error) {
        handleError(error);
      }
    });
}
