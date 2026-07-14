import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashDirectory } from "../hash.js";
import { toCodexManifest } from "../manifest-codec.js";
import { expandHome, resolveAgentTargetPath } from "../paths.js";
import { removeSection, upsertSection } from "../toml-sections.js";
import type { ExtensionKind, Scope } from "../types.js";
import { scanPackageDir, scanVersionedMarketplaceCache } from "./discover-common.js";
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

/** Local marketplace name Forge registers in Codex's config.toml. */
const MARKETPLACE = "forge-hub";

export interface CodexAdapterOptions {
  /** Override the `~/.codex` home (used by tests). */
  home?: string;
}

/**
 * Codex adapter. Skills copy into `~/.codex/skills/<id>`. Plugins are deployed as
 * a local marketplace + an "installed" cache copy, because Codex only loads a
 * plugin's MCP/skills once it is *installed* (empirically verified 2026-07-08,
 * design doc §9.2). Concretely deploy writes all of:
 *   1. marketplace source    `~/.codex/plugins/forge-hub/plugins/<id>/`
 *   2. marketplace manifest  `~/.codex/plugins/forge-hub/.agents/plugins/marketplace.json`
 *      (lists every forge-hub plugin; each needs `authentication: ON_INSTALL`)
 *   3. install cache copy     `~/.codex/plugins/cache/forge-hub/<id>/<version>/`
 *      (presence of this dir is what flips `codex plugin list` to "installed")
 *   4. config.toml sections   `[marketplaces.forge-hub]` + `[plugins."<id>@forge-hub"] enabled=true`
 * Codex plugins are user-global (no project-level plugin section).
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly label = "Codex";
  private readonly home: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.home = opts.home ?? expandHome("~/.codex");
  }

  private get marketplaceRoot(): string {
    return join(this.home, "plugins", MARKETPLACE);
  }

  private get marketplacePluginsDir(): string {
    return join(this.marketplaceRoot, "plugins");
  }

  private get marketplaceManifestPath(): string {
    return join(this.marketplaceRoot, ".agents", "plugins", "marketplace.json");
  }

  private get cacheRoot(): string {
    return join(this.home, "plugins", "cache", MARKETPLACE);
  }

  private get configPath(): string {
    return join(this.home, "config.toml");
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
      // Plugins live in the local marketplace regardless of scope (user-global).
      return join(this.marketplaceRoot, "plugins", extId);
    }
    if (scope === "user") return join(this.home, "skills", extId);
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
      toCodexManifest,
    );
    const version = await this.readVersion(target, input.extId);
    await this.installToCache(input.extId, version, target);
    await this.writeMarketplaceManifest();
    await this.registerPlugin(input.extId);

    return {
      path: target,
      mode: "native",
      manifestVariant,
      deployedHash,
      needsAgentReload: true,
      note: `Installed [plugins."${input.extId}@${MARKETPLACE}"] (v${version}); restart Codex to load`,
    };
  }

  async undeploy(input: UndeployInput): Promise<void> {
    const target =
      input.path ??
      this.resolveTargetPath(input.extId, input.kind, input.scope, input.cwd);
    await removePath(target);
    if (input.kind === "plugin") {
      await removePath(join(this.cacheRoot, input.extId));
      await this.writeMarketplaceManifest();
      await this.unregisterPlugin(input.extId);
    }
  }

  async discoverInstalled(scope: Scope, cwd?: string): Promise<DiscoveredExt[]> {
    const skillsRoot =
      scope === "user"
        ? join(this.home, "skills")
        : join(cwd ?? process.cwd(), ".codex/skills");
    const out: DiscoveredExt[] = [...(await scanPackageDir(skillsRoot, "skill"))];
    if (scope === "user") {
      // Forge-managed marketplace source (sideload / deploy target).
      out.push(...(await scanPackageDir(join(this.marketplaceRoot, "plugins"), "plugin")));
      // All Codex marketplace installs: cache/<marketplace>/<name>/<version>/.
      // Previously only forge-hub was scanned, so openai-bundled / openai-curated
      // / openai-curated-remote plugins never showed up in Forge's manage UI.
      out.push(...(await scanVersionedMarketplaceCache(join(this.home, "plugins", "cache"))));
    }
    return dedupeById(out);
  }

  /** Read a plugin version from `.codex-plugin/plugin.json` or `plugin.json`. */
  private async readVersion(pkgDir: string, extId: string): Promise<string> {
    for (const rel of [".codex-plugin/plugin.json", "plugin.json"]) {
      try {
        const j = JSON.parse(await readFile(join(pkgDir, rel), "utf-8")) as {
          version?: string;
        };
        if (j.version) return String(j.version);
      } catch {
        // try next
      }
    }
    return "0.0.0";
  }

  /**
   * Copy a plugin into Codex's install cache. Presence of
   * `cache/<mkt>/<id>/<version>/` is what marks a plugin "installed" (verified
   * 2026-07-08); `codex plugin add` does exactly this copy and nothing else.
   */
  private async installToCache(extId: string, version: string, source: string): Promise<void> {
    const dest = join(this.cacheRoot, extId, version);
    await deployCopy(source, dest);
  }

  /**
   * Regenerate the marketplace manifest from whatever plugin dirs currently
   * exist under the marketplace source, so add/remove stays in sync.
   */
  private async writeMarketplaceManifest(): Promise<void> {
    let ids: string[] = [];
    try {
      const entries = await readdir(this.marketplacePluginsDir, { withFileTypes: true });
      ids = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      ids = [];
    }
    const manifest = {
      name: MARKETPLACE,
      interface: { displayName: "Forge Hub" },
      plugins: ids.map((name) => ({
        name,
        source: { source: "local", path: `./plugins/${name}` },
        // Codex only accepts ON_INSTALL | ON_USE (no NONE); ON_INSTALL is the
        // no-op-friendly choice for locally-sourced plugins.
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      })),
    };
    await mkdir(dirname(this.marketplaceManifestPath), { recursive: true });
    await writeFile(this.marketplaceManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  }

  private async registerPlugin(extId: string): Promise<void> {
    let text = await this.readConfig();
    text = upsertSection(text, `[marketplaces.${MARKETPLACE}]`, [
      `source_type = "local"`,
      `source = ${JSON.stringify(this.marketplaceRoot)}`,
    ]);
    text = upsertSection(text, `[plugins."${extId}@${MARKETPLACE}"]`, ["enabled = true"]);
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, text, "utf-8");
  }

  private async unregisterPlugin(extId: string): Promise<void> {
    let text = await this.readConfig();
    if (!text) return;
    text = removeSection(text, `[plugins."${extId}@${MARKETPLACE}"]`);
    // Drop the marketplace section once no forge-hub plugins remain.
    const stillHasPlugins = text
      .split("\n")
      .some((l) => /^\[plugins\.".+@forge-hub"\]$/.test(l.trim()));
    if (!stillHasPlugins) {
      text = removeSection(text, `[marketplaces.${MARKETPLACE}]`);
    }
    await writeFile(this.configPath, text, "utf-8");
  }

  private async readConfig(): Promise<string> {
    try {
      return await readFile(this.configPath, "utf-8");
    } catch {
      return "";
    }
  }
}

function dedupeById(items: DiscoveredExt[]): DiscoveredExt[] {
  const seen = new Set<string>();
  const out: DiscoveredExt[] = [];
  for (const it of items) {
    const key = `${it.kind}:${it.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}
