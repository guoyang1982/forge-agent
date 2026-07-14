import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  emptyRegistry,
  REGISTRY_VERSION,
  type AgentId,
  type DeploymentRecord,
  type ExtensionRecord,
  type HubRegistry,
} from "./types.js";

/** Load the hub registry; returns an empty registry if the file is missing. */
export async function loadRegistry(path: string): Promise<HubRegistry> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return emptyRegistry();
  }
  try {
    const parsed = JSON.parse(raw) as HubRegistry;
    if (!parsed || typeof parsed !== "object" || !parsed.extensions) {
      return emptyRegistry();
    }
    return { version: parsed.version ?? REGISTRY_VERSION, extensions: parsed.extensions };
  } catch {
    return emptyRegistry();
  }
}

/** Persist the registry atomically (write temp + rename). */
export async function saveRegistry(path: string, registry: HubRegistry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf-8");
  await rename(tmp, path);
}

export function getExtension(
  registry: HubRegistry,
  id: string,
): ExtensionRecord | undefined {
  return registry.extensions[id];
}

/** Insert or replace an extension record. Mutates and returns the registry. */
export function upsertExtension(
  registry: HubRegistry,
  record: ExtensionRecord,
): HubRegistry {
  registry.extensions[record.id] = record;
  return registry;
}

export function removeExtension(registry: HubRegistry, id: string): HubRegistry {
  delete registry.extensions[id];
  return registry;
}

/** Record (or replace) a per-agent deployment for an extension. */
export function setDeployment(
  registry: HubRegistry,
  id: string,
  agent: AgentId,
  deployment: DeploymentRecord,
): HubRegistry {
  const ext = registry.extensions[id];
  if (!ext) throw new Error(`extension not in registry: ${id}`);
  ext.deployments[agent] = deployment;
  ext.updatedAt = new Date().toISOString();
  return registry;
}

/** Remove a per-agent deployment record (after undeploy). */
export function removeDeployment(
  registry: HubRegistry,
  id: string,
  agent: AgentId,
): HubRegistry {
  const ext = registry.extensions[id];
  if (!ext) return registry;
  delete ext.deployments[agent];
  ext.updatedAt = new Date().toISOString();
  return registry;
}

/**
 * Recompute deployment `status` by comparing each `deployedHash` against the
 * extension's current `contentHash`. Does not touch the filesystem.
 */
export function reconcileStatuses(registry: HubRegistry): HubRegistry {
  for (const ext of Object.values(registry.extensions)) {
    for (const dep of Object.values(ext.deployments)) {
      if (!dep) continue;
      if (dep.status === "missing" || dep.status === "error") continue;
      dep.status = dep.deployedHash === ext.contentHash ? "synced" : "drift";
    }
  }
  return registry;
}
