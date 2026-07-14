import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { deployCopy, pathExists } from "./adapters/fs-ops.js";
import { createDefaultAdapters, type AgentAdapter } from "./adapters/index.js";
import { hashDirectory } from "./hash.js";
import { analyzeCompatibilityFromDir } from "./compatibility.js";
import { parseCapabilitiesFromDir } from "./manifest-codec.js";
import {
  defaultHubDir,
  hubRegistryPath,
  hubStorePath,
} from "./paths.js";
import {
  getExtension,
  loadRegistry,
  removeDeployment,
  removeExtension,
  saveRegistry,
  setDeployment,
  upsertExtension,
} from "./registry.js";
import {
  emptyCapabilities,
  ALL_AGENTS,
  type AgentId,
  type DeployStatus,
  type ExtensionKind,
  type ExtensionRecord,
  type ExtensionSource,
  type HubRegistry,
  type Scope,
} from "./types.js";

export interface HubOptions {
  hubDir?: string;
  dataDir?: string;
  adapters?: Partial<Record<AgentId, AgentAdapter>>;
}

export interface InstallLocalInput {
  id: string;
  kind: ExtensionKind;
  /** Directory to copy into the hub store as the SSOT content. */
  sourceDir: string;
  name?: string;
  version?: string;
  source?: ExtensionSource;
}

export interface DeployOptions {
  agents: AgentId[];
  scope?: Scope;
  cwd?: string;
}

/**
 * Orchestrates the store (SSOT content), the registry (metadata + per-agent
 * deployment records), and the per-agent adapters.
 */
export class ExtensionHub {
  readonly hubDir: string;
  private readonly adapters: Partial<Record<AgentId, AgentAdapter>>;

  constructor(options: HubOptions = {}) {
    this.hubDir = options.hubDir ?? defaultHubDir(options.dataDir);
    this.adapters = options.adapters ?? createDefaultAdapters();
  }

  private registryPath(): string {
    return hubRegistryPath(this.hubDir);
  }

  private adapter(agent: AgentId): AgentAdapter {
    const a = this.adapters[agent];
    if (!a) throw new Error(`no adapter registered for agent: ${agent}`);
    return a;
  }

  storePath(kind: ExtensionKind, id: string): string {
    return hubStorePath(this.hubDir, kind, id);
  }

  async list(): Promise<HubRegistry> {
    const registry = await loadRegistry(this.registryPath());
    await this.reconcileFs(registry);
    let changed = false;
    for (const ext of Object.values(registry.extensions)) {
      const sourcePath = this.storePath(ext.kind, ext.id);
      if (!(await pathExists(sourcePath))) continue;
      const compatibility = await analyzeCompatibilityFromDir(sourcePath);
      if (JSON.stringify(ext.compatibility) !== JSON.stringify(compatibility)) {
        ext.compatibility = compatibility;
        changed = true;
      }
      for (const [agent, deployment] of Object.entries(ext.deployments) as Array<[
        AgentId,
        NonNullable<ExtensionRecord["deployments"][AgentId]>,
      ]>) {
        const target = compatibility[agent];
        if (target.status !== "incompatible" || deployment.status === "error") continue;
        deployment.status = "error";
        deployment.note = `不兼容：${target.reason}`;
        changed = true;
      }
    }
    if (changed) await saveRegistry(this.registryPath(), registry);
    return registry;
  }

  /**
   * Filesystem-aware status pass: a deployment whose target path no longer
   * exists is `missing`; otherwise its hash decides `synced` vs `drift`. Errors
   * recorded at deploy time are preserved.
   */
  private async reconcileFs(registry: HubRegistry): Promise<void> {
    for (const ext of Object.values(registry.extensions)) {
      for (const dep of Object.values(ext.deployments)) {
        if (!dep) continue;
        if (dep.status === "error") continue;
        if (!(await pathExists(dep.path))) {
          dep.status = "missing";
          continue;
        }
        dep.status = dep.deployedHash === ext.contentHash ? "synced" : "drift";
      }
    }
  }

  /** Copy a local directory into the store and register it (no deploy yet). */
  async installLocal(input: InstallLocalInput): Promise<ExtensionRecord> {
    const dest = this.storePath(input.kind, input.id);
    await deployCopy(input.sourceDir, dest);

    const contentHash = await hashDirectory(dest);
    const capabilities = await parseCapabilitiesFromDir(dest).catch(() => emptyCapabilities());
    const compatibility = await analyzeCompatibilityFromDir(dest);
    const now = new Date().toISOString();

    const registry = await loadRegistry(this.registryPath());
    const existing = getExtension(registry, input.id);
    const record: ExtensionRecord = {
      kind: input.kind,
      id: input.id,
      name: input.name ?? (await readPackageName(dest)) ?? input.id,
      version: input.version,
      contentHash,
      source: input.source ?? { type: "local", path: input.sourceDir },
      capabilities,
      compatibility,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      deployments: existing?.deployments ?? {},
    };
    upsertExtension(registry, record);
    await saveRegistry(this.registryPath(), registry);
    return record;
  }

  /** Deploy an already-installed extension to one or more agents. */
  async deploy(extId: string, options: DeployOptions): Promise<ExtensionRecord> {
    const registry = await loadRegistry(this.registryPath());
    const ext = getExtension(registry, extId);
    if (!ext) throw new Error(`extension not installed in hub: ${extId}`);

    const scope = options.scope ?? "user";
    const sourcePath = this.storePath(ext.kind, extId);
    if (!(await pathExists(sourcePath))) {
      throw new Error(`store content missing for ${extId}: ${sourcePath}`);
    }

    for (const agent of options.agents) {
      const adapter = this.adapter(agent);
      const compatibility = ext.compatibility ?? await analyzeCompatibilityFromDir(sourcePath);
      ext.compatibility = compatibility;
      const target = compatibility[agent];
      if (target.status === "incompatible") {
        setDeployment(registry, extId, agent, {
          scope,
          cwd: scope === "project" ? options.cwd : undefined,
          path: adapter.resolveTargetPath(extId, ext.kind, scope, options.cwd),
          mode: "copy",
          deployedHash: "",
          status: "error",
          note: `不兼容：${target.reason}`,
        });
        continue;
      }
      try {
        const result = await adapter.deploy({
          extId,
          kind: ext.kind,
          sourcePath,
          scope,
          cwd: options.cwd,
        });
        setDeployment(registry, extId, agent, {
          scope,
          cwd: scope === "project" ? options.cwd : undefined,
          path: result.path,
          mode: result.mode,
          manifestVariant: result.manifestVariant,
          deployedHash: result.deployedHash,
          status: result.deployedHash === ext.contentHash ? "synced" : "drift",
          deployedAt: new Date().toISOString(),
          note: result.note,
        });
      } catch (e) {
        setDeployment(registry, extId, agent, {
          scope,
          cwd: scope === "project" ? options.cwd : undefined,
          path: adapter.resolveTargetPath(extId, ext.kind, scope, options.cwd),
          mode: "copy",
          deployedHash: "",
          status: "error",
          note: e instanceof Error ? e.message : String(e),
        });
      }
    }

    await saveRegistry(this.registryPath(), registry);
    return getExtension(registry, extId)!;
  }

  /** Remove an extension from a single agent, keeping it in the hub store. */
  async undeploy(extId: string, agent: AgentId, scope: Scope = "user", cwd?: string): Promise<void> {
    const registry = await loadRegistry(this.registryPath());
    const ext = getExtension(registry, extId);
    if (!ext) return;
    await this.adapter(agent).undeploy({
      extId,
      kind: ext.kind,
      scope,
      cwd,
      path: ext.deployments[agent]?.path,
    });
    removeDeployment(registry, extId, agent);
    await saveRegistry(this.registryPath(), registry);
  }

  /** Fully remove an extension: undeploy from all agents, then delete from store. */
  async remove(extId: string): Promise<void> {
    const registry = await loadRegistry(this.registryPath());
    const ext = getExtension(registry, extId);
    if (!ext) return;

    for (const agent of Object.keys(ext.deployments) as AgentId[]) {
      const dep = ext.deployments[agent];
      if (!dep) continue;
      try {
        await this.adapter(agent).undeploy({
          extId,
          kind: ext.kind,
          scope: dep.scope,
          path: dep.path,
        });
      } catch {
        /* best-effort undeploy during removal */
      }
    }

    await rm(this.storePath(ext.kind, extId), { recursive: true, force: true });
    removeExtension(registry, extId);
    await saveRegistry(this.registryPath(), registry);
  }

  /**
   * Reconcile recorded deployments back to the store (push): any deployment that
   * has drifted or gone missing is re-deployed from the SSOT. Already-synced
   * deployments are skipped. Pass `extId` to sync a single extension.
   */
  async sync(
    extId?: string,
    options: { agents?: AgentId[] } = {},
  ): Promise<SyncResult[]> {
    const registry = await loadRegistry(this.registryPath());
    await this.reconcileFs(registry);

    const targets = extId
      ? ([getExtension(registry, extId)].filter(Boolean) as ExtensionRecord[])
      : Object.values(registry.extensions);
    const results: SyncResult[] = [];

    for (const ext of targets) {
      const sourcePath = this.storePath(ext.kind, ext.id);
      const storeOk = await pathExists(sourcePath);
      for (const agent of Object.keys(ext.deployments) as AgentId[]) {
        if (options.agents && !options.agents.includes(agent)) continue;
        const dep = ext.deployments[agent];
        if (!dep) continue;
        const before = dep.status;
        if (before === "synced") {
          results.push({ extId: ext.id, agent, before, after: before, action: "skipped" });
          continue;
        }
        if (!storeOk) {
          results.push({
            extId: ext.id,
            agent,
            before,
            after: "error",
            action: "error",
            note: `store content missing: ${sourcePath}`,
          });
          continue;
        }
        try {
          const result = await this.adapter(agent).deploy({
            extId: ext.id,
            kind: ext.kind,
            sourcePath,
            scope: dep.scope,
            cwd: dep.cwd,
          });
          setDeployment(registry, ext.id, agent, {
            scope: dep.scope,
            cwd: dep.cwd,
            path: result.path,
            mode: result.mode,
            manifestVariant: result.manifestVariant,
            deployedHash: result.deployedHash,
            status: result.deployedHash === ext.contentHash ? "synced" : "drift",
            deployedAt: new Date().toISOString(),
            note: result.note,
          });
          results.push({
            extId: ext.id,
            agent,
            before,
            after: ext.deployments[agent]!.status,
            action: "redeployed",
          });
        } catch (e) {
          results.push({
            extId: ext.id,
            agent,
            before,
            after: "error",
            action: "error",
            note: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    await saveRegistry(this.registryPath(), registry);
    return results;
  }

  /**
   * Probe each agent and list the extensions installed there, flagging which are
   * already tracked by the hub. Basis for the "pull into hub" (import) flow.
   */
  async discover(
    options: { agents?: AgentId[]; scope?: Scope; cwd?: string } = {},
  ): Promise<AgentDiscovery[]> {
    const registry = await loadRegistry(this.registryPath());
    const scope = options.scope ?? "user";
    const agents = options.agents ?? ALL_AGENTS;
    const out: AgentDiscovery[] = [];

    for (const agent of agents) {
      const adapter = this.adapters[agent];
      if (!adapter) {
        out.push({ agent, available: false, managed: [], found: [] });
        continue;
      }
      const probe = await adapter.probe().catch(() => ({ available: false }));
      const managed = Object.values(registry.extensions)
        .filter((e) => e.deployments[agent])
        .map((e) => e.id);
      let found: DiscoveredAgentExt[] = [];
      if (probe.available) {
        const installed = await adapter.discoverInstalled(scope, options.cwd).catch(() => []);
        found = installed.map((d) => {
          const hubExt = getExtension(registry, d.id);
          return {
            id: d.id,
            kind: d.kind,
            path: d.path,
            contentHash: d.contentHash,
            inHub: Boolean(hubExt),
            hubMatches: hubExt?.contentHash === d.contentHash,
          };
        });
      }
      out.push({ agent, available: probe.available, managed, found });
    }
    return out;
  }

  /** Pull an extension installed in an agent into the hub store (import). */
  async importFromAgent(
    agent: AgentId,
    extId: string,
    options: { kind?: ExtensionKind; scope?: Scope; cwd?: string } = {},
  ): Promise<ExtensionRecord> {
    const adapter = this.adapter(agent);
    const scope = options.scope ?? "user";
    const installed = await adapter.discoverInstalled(scope, options.cwd);
    const match = installed.find(
      (d) => d.id === extId && (!options.kind || d.kind === options.kind),
    );
    if (!match) throw new Error(`extension not found in ${agent}: ${extId}`);
    return this.installLocal({
      id: match.id,
      kind: match.kind,
      sourceDir: match.path,
      source: { type: "agent-import", fromAgent: agent, path: match.path },
    });
  }
}

export interface SyncResult {
  extId: string;
  agent: AgentId;
  before: DeployStatus;
  after: DeployStatus;
  action: "redeployed" | "skipped" | "error";
  note?: string;
}

export interface DiscoveredAgentExt {
  id: string;
  kind: ExtensionKind;
  path: string;
  contentHash: string;
  /** An extension with this id is tracked by the hub. */
  inHub: boolean;
  /** In the hub AND content hash matches (i.e. same package). */
  hubMatches: boolean;
}

export interface AgentDiscovery {
  agent: AgentId;
  available: boolean;
  /** Extension ids the hub has deployed to this agent. */
  managed: string[];
  /** Extensions found installed in the agent. */
  found: DiscoveredAgentExt[];
}

async function readPackageName(dir: string): Promise<string | undefined> {
  try {
    const forge = JSON.parse(await readFile(join(dir, "plugin.json"), "utf-8")) as {
      name?: string;
    };
    if (forge.name) return forge.name;
  } catch {
    /* not a forge plugin package */
  }
  return undefined;
}
