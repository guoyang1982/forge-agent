import { join } from "node:path";
import { hashDirectory } from "../hash.js";
import { AGENT_PATHS, expandHome, resolveAgentTargetPath } from "../paths.js";
import type { ExtensionKind, Scope } from "../types.js";
import { scanPackageDir } from "./discover-common.js";
import { deploySymlink, pathExists, removePath } from "./fs-ops.js";
import type {
  AgentAdapter,
  DeployInput,
  DeployResult,
  DiscoveredExt,
  ProbeResult,
  UndeployInput,
} from "./types.js";

/**
 * Forge native adapter: symlinks store packages into the Forge data dir so the
 * existing `plugin-registry` / `skill-registry` discovery picks them up.
 */
export class ForgeAdapter implements AgentAdapter {
  readonly id = "forge" as const;
  readonly label = "Forge";

  async probe(): Promise<ProbeResult> {
    return { available: await pathExists(expandHome("~/.forge-agent")) };
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
    await deploySymlink(input.sourcePath, target);
    return {
      path: target,
      mode: "symlink",
      deployedHash: await hashDirectory(input.sourcePath),
    };
  }

  async undeploy(input: UndeployInput): Promise<void> {
    const target =
      input.path ??
      this.resolveTargetPath(input.extId, input.kind, input.scope, input.cwd);
    await removePath(target);
  }

  async discoverInstalled(scope: Scope, cwd?: string): Promise<DiscoveredExt[]> {
    const skillsRoot = rootFor("forge", "skill", scope, cwd);
    const pluginsRoot = rootFor("forge", "plugin", scope, cwd);
    return [
      ...(await scanPackageDir(skillsRoot, "skill")),
      ...(await scanPackageDir(pluginsRoot, "plugin")),
    ];
  }
}

function rootFor(
  agent: "forge",
  kind: ExtensionKind,
  scope: Scope,
  cwd?: string,
): string {
  const spec = AGENT_PATHS[agent][kind === "skill" ? "skills" : "plugins"];
  const root = scope === "user" ? spec.user : spec.project;
  return root.startsWith("~") || root.startsWith("/")
    ? expandHome(root)
    : join(cwd ?? process.cwd(), root);
}
