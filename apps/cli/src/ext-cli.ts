import { Command } from "commander";
import { resolve } from "node:path";
import { connectDaemon } from "@forge/bus";
import {
  DAEMON_METHODS,
  type HubAgentId,
  type HubDeploymentInfo,
  type HubDiscoverResult,
  type HubListItem,
  type HubListResult,
  type HubMutationResult,
  type HubSyncResult,
} from "@forge/protocol";
import { loadConfig } from "@forge/config";
import { ensureDaemon } from "./daemon-util.js";

const ALL_AGENTS: HubAgentId[] = ["forge", "cursor", "claude-code", "codex"];
const AGENT_LABEL: Record<HubAgentId, string> = {
  forge: "Forge",
  cursor: "Cursor",
  "claude-code": "Claude",
  codex: "Codex",
};
const STATUS_MARK: Record<string, string> = {
  synced: "✓",
  drift: "~",
  missing: "!",
  error: "x",
};

async function requestDaemon<T>(
  socketPath: string,
  method: string,
  params?: unknown,
): Promise<T> {
  const client = await connectDaemon(socketPath);
  try {
    return (await client.request(method, params)) as T;
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

function parseAgents(value: string | undefined): HubAgentId[] {
  if (!value || value === "all") return ALL_AGENTS;
  const ids = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as HubAgentId[];
  const invalid = ids.filter((id) => !ALL_AGENTS.includes(id));
  if (invalid.length) {
    console.error(`Unknown agent(s): ${invalid.join(", ")}. Valid: ${ALL_AGENTS.join(", ")}`);
    process.exit(1);
  }
  return ids;
}

function deploymentCell(dep: HubDeploymentInfo | undefined): string {
  if (!dep) return "-";
  return `${STATUS_MARK[dep.status] ?? "?"}${dep.status}`;
}

function printMatrix(items: HubListItem[]): void {
  if (!items.length) {
    console.log("No extensions in the hub. Install one with `forge ext install`.");
    return;
  }
  const header = ["id", "kind", ...ALL_AGENTS.map((a) => AGENT_LABEL[a])];
  const rows = items.map((item) => [
    item.id,
    item.kind,
    ...ALL_AGENTS.map((a) => deploymentCell(item.deployments[a])),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(fmt(row));
  console.log("\nlegend: ✓synced ~drift !missing xerror  ·  - not deployed");
}

export function registerExtCommands(program: Command): void {
  const ext = program
    .command("ext")
    .description("Manage & distribute extensions (skills/plugins) across agents");

  ext
    .command("list")
    .description("Show the extension deployment matrix")
    .option("--json", "output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      const res = await withDaemon(undefined, (sock) =>
        requestDaemon<HubListResult>(sock, DAEMON_METHODS.HUB_LIST),
      );
      if (opts.json) {
        console.log(JSON.stringify(res.items, null, 2));
        return;
      }
      printMatrix(res.items);
    });

  ext
    .command("install")
    .description("Install an extension into the hub (from a local dir or GitHub)")
    .argument("<source>", "local directory path, or owner/repo[/subdir][#ref]")
    .option("-k, --kind <kind>", "skill | plugin", "plugin")
    .option("--id <id>", "override the extension id")
    .option("--subdir <path>", "subdirectory within a GitHub source")
    .option("-a, --agents <list>", "deploy right after install (comma list or 'all')")
    .option("--scope <scope>", "user | project", "user")
    .option("-c, --cwd <path>", "workspace dir (for project scope)", process.cwd())
    .action(
      async (
        source: string,
        opts: {
          kind: string;
          id?: string;
          subdir?: string;
          agents?: string;
          scope: string;
          cwd: string;
        },
      ) => {
        const kind = opts.kind === "skill" ? "skill" : "plugin";
        const isLocal = source.startsWith(".") || source.startsWith("/") || source.startsWith("~");
        const params: Record<string, unknown> = {
          kind,
          id: opts.id,
          scope: opts.scope,
          cwd: resolve(opts.cwd),
        };
        if (isLocal) {
          params.sourceDir = resolve(opts.cwd, source);
        } else {
          params.source = source;
          if (opts.subdir) params.subdir = opts.subdir;
        }
        if (opts.agents) params.agents = parseAgents(opts.agents);

        const res = await withDaemon(opts.cwd, (sock) =>
          requestDaemon<HubMutationResult>(sock, DAEMON_METHODS.HUB_INSTALL, params),
        );
        const item = res.item;
        console.log(`Installed ${item?.kind ?? kind} '${item?.id}' into hub.`);
        if (opts.agents && item) printMatrix([item]);
      },
    );

  ext
    .command("deploy")
    .description("Deploy an installed extension to one or more agents")
    .argument("<extId>", "extension id")
    .argument("[agents]", "comma list or 'all'", "all")
    .option("--scope <scope>", "user | project", "user")
    .option("-c, --cwd <path>", "workspace dir (for project scope)", process.cwd())
    .action(async (extId: string, agents: string, opts: { scope: string; cwd: string }) => {
      const res = await withDaemon(opts.cwd, (sock) =>
        requestDaemon<HubMutationResult>(sock, DAEMON_METHODS.HUB_DEPLOY, {
          extId,
          agents: parseAgents(agents),
          scope: opts.scope,
          cwd: resolve(opts.cwd),
        }),
      );
      if (res.item) printMatrix([res.item]);
    });

  ext
    .command("undeploy")
    .description("Remove an extension from a single agent (keeps it in the hub)")
    .argument("<extId>", "extension id")
    .argument("<agent>", ALL_AGENTS.join(" | "))
    .option("--scope <scope>", "user | project", "user")
    .option("-c, --cwd <path>", "workspace dir (for project scope)", process.cwd())
    .action(async (extId: string, agent: string, opts: { scope: string; cwd: string }) => {
      const [a] = parseAgents(agent);
      await withDaemon(opts.cwd, (sock) =>
        requestDaemon<HubMutationResult>(sock, DAEMON_METHODS.HUB_UNDEPLOY, {
          extId,
          agent: a,
          scope: opts.scope,
          cwd: resolve(opts.cwd),
        }),
      );
      console.log(`Undeployed '${extId}' from ${AGENT_LABEL[a]}.`);
    });

  ext
    .command("remove")
    .description("Remove an extension from the hub and all agents")
    .argument("<extId>", "extension id")
    .action(async (extId: string) => {
      await withDaemon(undefined, (sock) =>
        requestDaemon<HubMutationResult>(sock, DAEMON_METHODS.HUB_REMOVE, { extId }),
      );
      console.log(`Removed '${extId}' from the hub and all agents.`);
    });

  ext
    .command("sync")
    .description("Re-deploy drifted/missing deployments back to the hub's source of truth")
    .argument("[extId]", "sync a single extension (default: all)")
    .option("-a, --agents <list>", "limit to these agents (comma list or 'all')")
    .action(async (extId: string | undefined, opts: { agents?: string }) => {
      const params: Record<string, unknown> = {};
      if (extId) params.extId = extId;
      if (opts.agents) params.agents = parseAgents(opts.agents);

      const res = await withDaemon(undefined, (sock) =>
        requestDaemon<HubSyncResult>(sock, DAEMON_METHODS.HUB_SYNC, params),
      );
      const changed = res.entries.filter((e) => e.action !== "skipped");
      if (!changed.length) {
        console.log("Everything already in sync.");
        return;
      }
      for (const e of res.entries) {
        if (e.action === "skipped") continue;
        const mark = e.action === "error" ? "x" : "→";
        console.log(
          `${mark} ${e.extId} @ ${AGENT_LABEL[e.agent]}: ${e.before} -> ${e.after}` +
            (e.note ? `  (${e.note})` : ""),
        );
      }
    });

  ext
    .command("discover")
    .description("Probe agents and list extensions installed there")
    .option("-a, --agents <list>", "limit to these agents (comma list or 'all')")
    .option("--scope <scope>", "user | project", "user")
    .option("-c, --cwd <path>", "workspace dir (for project scope)", process.cwd())
    .option("--json", "output raw JSON")
    .action(async (opts: { agents?: string; scope: string; cwd: string; json?: boolean }) => {
      const res = await withDaemon(opts.cwd, (sock) =>
        requestDaemon<HubDiscoverResult>(sock, DAEMON_METHODS.HUB_DISCOVER, {
          agents: opts.agents ? parseAgents(opts.agents) : undefined,
          scope: opts.scope,
          cwd: resolve(opts.cwd),
        }),
      );
      if (opts.json) {
        console.log(JSON.stringify(res.agents, null, 2));
        return;
      }
      for (const a of res.agents) {
        const head = a.available ? "" : "  (not installed)";
        console.log(`\n${AGENT_LABEL[a.agent]}${head}`);
        if (!a.found.length) {
          console.log("  (no extensions found)");
          continue;
        }
        for (const f of a.found) {
          const tag = !f.inHub ? "new" : f.hubMatches ? "in-hub" : "in-hub (differs)";
          console.log(`  ${f.id}  [${f.kind}]  ${tag}`);
        }
      }
      console.log("\nImport a 'new' one with: forge ext import <agent> <id>");
    });

  ext
    .command("import")
    .description("Pull an extension installed in an agent into the hub")
    .argument("<agent>", ALL_AGENTS.join(" | "))
    .argument("<extId>", "extension id as listed by `forge ext discover`")
    .option("-k, --kind <kind>", "skill | plugin (disambiguate if needed)")
    .option("--scope <scope>", "user | project", "user")
    .option("-c, --cwd <path>", "workspace dir (for project scope)", process.cwd())
    .action(
      async (
        agent: string,
        extId: string,
        opts: { kind?: string; scope: string; cwd: string },
      ) => {
        const [a] = parseAgents(agent);
        const res = await withDaemon(opts.cwd, (sock) =>
          requestDaemon<HubMutationResult>(sock, DAEMON_METHODS.HUB_IMPORT, {
            agent: a,
            extId,
            kind: opts.kind === "skill" ? "skill" : opts.kind === "plugin" ? "plugin" : undefined,
            scope: opts.scope,
            cwd: resolve(opts.cwd),
          }),
        );
        console.log(`Imported '${extId}' from ${AGENT_LABEL[a]} into the hub.`);
        if (res.item) printMatrix([res.item]);
      },
    );
}
