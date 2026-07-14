import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashDirectory } from "../hash.js";
import { toClaudeManifest } from "../manifest-codec.js";
import { AGENT_PATHS, expandHome, resolveAgentTargetPath } from "../paths.js";
import type { ExtensionKind, Scope } from "../types.js";
import { scanPackageDir } from "./discover-common.js";
import { deployCopy, pathExists, removePath } from "./fs-ops.js";
import { ensureAgentManifest } from "./manifest-write.js";
import type {
  AgentAdapter,
  DeployInput,
  DeployResult,
  DiscoveredExt,
  ProbeResult,
  UndeployInput,
} from "./types.js";

/** Local marketplace name Forge registers with Claude Code. */
const MARKETPLACE = "forge-hub";

export interface ClaudeAdapterOptions {
  /** Override the `~/.claude` home (used by tests). */
  home?: string;
}

/**
 * Claude Code adapter.
 *
 * Skills copy into `~/.claude/skills/<id>` (Claude auto-discovers those).
 *
 * Plugins can NOT just be dropped into a folder — Claude only loads plugins from
 * a *registered marketplace* whose plugin is *enabled* (empirically verified
 * 2026-07-08, design doc §9.2). Local marketplaces are referenced in place
 * (`source: directory`), so deploy:
 *   1. copies the plugin into a Forge-owned marketplace dir `~/.claude/plugins/forge-hub/<id>/`
 *   2. regenerates `~/.claude/plugins/forge-hub/.claude-plugin/marketplace.json`
 *   3. registers the marketplace in `~/.claude/plugins/known_marketplaces.json`
 *      and `~/.claude/settings.json` (`extraKnownMarketplaces`)
 *   4. enables the plugin via `settings.json` `enabledPlugins["<id>@forge-hub"]=true`
 * (this mirrors exactly what `claude plugin marketplace add` + `plugin enable` persist).
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude-code" as const;
  readonly label = "Claude Code";
  private readonly home: string;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.home = opts.home ?? expandHome("~/.claude");
  }

  private get marketplaceRoot(): string {
    return join(this.home, "plugins", MARKETPLACE);
  }

  private get marketplaceManifestPath(): string {
    return join(this.marketplaceRoot, ".claude-plugin", "marketplace.json");
  }

  private get knownMarketplacesPath(): string {
    return join(this.home, "plugins", "known_marketplaces.json");
  }

  private get settingsPath(): string {
    return join(this.home, "settings.json");
  }

  async probe(): Promise<ProbeResult> {
    return { available: await pathExists(this.home) };
  }

  resolveTargetPath(
    extId: string,
    kind: ExtensionKind,
    scope: Scope,
    cwd?: string,
  ): string {
    if (kind === "plugin") {
      // Plugins live in the Forge-owned local marketplace (user-global).
      return join(this.marketplaceRoot, extId);
    }
    if (scope === "user") {
      return join(this.home, "skills", extId);
    }
    return resolveAgentTargetPath(this.id, kind, scope, extId, cwd);
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const target = this.resolveTargetPath(input.extId, input.kind, input.scope, input.cwd);
    await deployCopy(input.sourcePath, target);
    const deployedHash = await hashDirectory(input.sourcePath);

    if (input.kind === "skill") {
      return { path: target, mode: "copy", deployedHash };
    }

    const manifestVariant = await ensureAgentManifest(
      input.sourcePath,
      target,
      input.extId,
      toClaudeManifest,
    );
    await this.writeMarketplaceManifest();
    await this.registerMarketplace();
    await this.setPluginEnabled(input.extId, true);

    return {
      path: target,
      mode: "copy",
      manifestVariant,
      deployedHash,
      needsAgentReload: true,
      note: `Enabled ${input.extId}@${MARKETPLACE}; new Claude sessions pick it up`,
    };
  }

  async undeploy(input: UndeployInput): Promise<void> {
    const target =
      input.path ??
      this.resolveTargetPath(input.extId, input.kind, input.scope, input.cwd);
    await removePath(target);
    if (input.kind === "plugin") {
      await this.setPluginEnabled(input.extId, false);
      await this.writeMarketplaceManifest();
      await this.pruneMarketplaceIfEmpty();
    }
  }

  async discoverInstalled(scope: Scope, cwd?: string): Promise<DiscoveredExt[]> {
    const skillsRoot = this.dirFor("skill", scope, cwd);
    const pluginsRoot = scope === "user" ? this.marketplaceRoot : this.dirFor("plugin", scope, cwd);
    return [
      ...(await scanPackageDir(skillsRoot, "skill")),
      ...(await scanPackageDir(pluginsRoot, "plugin")),
    ];
  }

  private dirFor(kind: ExtensionKind, scope: Scope, cwd?: string): string {
    const key = kind === "skill" ? "skills" : "plugins";
    if (scope === "user") return join(this.home, key);
    const spec = AGENT_PATHS["claude-code"][key];
    return join(cwd ?? process.cwd(), spec.project);
  }

  /** List plugin ids currently present in the marketplace source dir. */
  private async marketplacePluginIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.marketplaceRoot, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && e.name !== ".claude-plugin")
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async writeMarketplaceManifest(): Promise<void> {
    const ids = await this.marketplacePluginIds();
    const manifest = {
      name: MARKETPLACE,
      owner: { name: "forge-agent" },
      plugins: ids.map((name) => ({ name, source: `./${name}` })),
    };
    await mkdir(dirname(this.marketplaceManifestPath), { recursive: true });
    await writeFile(this.marketplaceManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  }

  /** Register the local marketplace in both known_marketplaces + settings. */
  private async registerMarketplace(): Promise<void> {
    const path = this.marketplaceRoot;
    const known = await readJson<Record<string, unknown>>(this.knownMarketplacesPath, {});
    known[MARKETPLACE] = {
      source: { source: "directory", path },
      installLocation: path,
      lastUpdated: new Date().toISOString(),
    };
    await writeJson(this.knownMarketplacesPath, known);

    const settings = await readJson<Record<string, unknown>>(this.settingsPath, {});
    const extra = (settings.extraKnownMarketplaces as Record<string, unknown>) ?? {};
    extra[MARKETPLACE] = { source: { source: "directory", path } };
    settings.extraKnownMarketplaces = extra;
    await writeJson(this.settingsPath, settings);
  }

  private async setPluginEnabled(extId: string, enabled: boolean): Promise<void> {
    const settings = await readJson<Record<string, unknown>>(this.settingsPath, {});
    const enabledPlugins = (settings.enabledPlugins as Record<string, boolean>) ?? {};
    const key = `${extId}@${MARKETPLACE}`;
    if (enabled) {
      enabledPlugins[key] = true;
    } else {
      delete enabledPlugins[key];
    }
    settings.enabledPlugins = enabledPlugins;
    await writeJson(this.settingsPath, settings);
  }

  /** Drop the marketplace registration once no forge-hub plugins remain. */
  private async pruneMarketplaceIfEmpty(): Promise<void> {
    if ((await this.marketplacePluginIds()).length > 0) return;

    const known = await readJson<Record<string, unknown>>(this.knownMarketplacesPath, {});
    if (MARKETPLACE in known) {
      delete known[MARKETPLACE];
      await writeJson(this.knownMarketplacesPath, known);
    }

    const settings = await readJson<Record<string, unknown>>(this.settingsPath, {});
    const extra = settings.extraKnownMarketplaces as Record<string, unknown> | undefined;
    if (extra && MARKETPLACE in extra) {
      delete extra[MARKETPLACE];
      settings.extraKnownMarketplaces = extra;
      await writeJson(this.settingsPath, settings);
    }
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
