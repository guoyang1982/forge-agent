import { join } from "node:path";
import { hashDirectory } from "../hash.js";
import { toCursorManifest } from "../manifest-codec.js";
import { AGENT_PATHS, expandHome, resolveAgentTargetPath } from "../paths.js";
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

/**
 * Cursor adapter. Plugins are sideloaded into `~/.cursor/plugins/local/` (which
 * Cursor auto-rescans — verified 2026-07-08, see design doc §14) and skills into
 * `~/.cursor/skills/`. Never touches Cursor's SQLite marketplace state.
 */
export class CursorAdapter implements AgentAdapter {
  readonly id = "cursor" as const;
  readonly label = "Cursor";

  async probe(): Promise<ProbeResult> {
    return { available: await pathExists(expandHome("~/.cursor")) };
  }

  resolveTargetPath(
    extId: string,
    kind: ExtensionKind,
    scope: Scope,
    cwd?: string,
  ): string {
    return resolveAgentTargetPath(this.id, kind, scope, extId, cwd);
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const target = this.resolveTargetPath(input.extId, input.kind, input.scope, input.cwd);
    await deployCopy(input.sourcePath, target);

    let manifestVariant: string | undefined;
    if (input.kind === "plugin") {
      manifestVariant = await ensureAgentManifest(
        input.sourcePath,
        target,
        input.extId,
        toCursorManifest,
      );
    }

    return {
      path: target,
      mode: input.kind === "plugin" ? "sideload" : "copy",
      manifestVariant,
      // Hash the store source (not the target) so a synced deploy matches the
      // extension's contentHash; generated manifests are a deterministic transform.
      deployedHash: await hashDirectory(input.sourcePath),
      needsAgentReload: false,
      note:
        input.kind === "plugin"
          ? "Cursor auto-rescans plugins/local; reload window if not picked up"
          : undefined,
    };
  }

  async undeploy(input: UndeployInput): Promise<void> {
    const target =
      input.path ??
      this.resolveTargetPath(input.extId, input.kind, input.scope, input.cwd);
    await removePath(target);
  }

  async discoverInstalled(scope: Scope, cwd?: string): Promise<DiscoveredExt[]> {
    const skillsRoot = rootFor("skill", scope, cwd);
    const localPluginsRoot = rootFor("plugin", scope, cwd);
    const out: DiscoveredExt[] = [
      ...(await scanPackageDir(skillsRoot, "skill")),
      ...(await scanPackageDir(localPluginsRoot, "plugin")),
    ];
    if (scope === "user") {
      // Marketplace installs live under cache/<marketplace>/<name>/<sha>/.
      out.push(...(await scanVersionedMarketplaceCache(expandHome("~/.cursor/plugins/cache"))));
    }
    return dedupeById(out);
  }
}

function rootFor(kind: ExtensionKind, scope: Scope, cwd?: string): string {
  const spec = AGENT_PATHS.cursor[kind === "skill" ? "skills" : "plugins"];
  const root = scope === "user" ? spec.user : spec.project;
  return root.startsWith("~") || root.startsWith("/")
    ? expandHome(root)
    : join(cwd ?? process.cwd(), root);
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
