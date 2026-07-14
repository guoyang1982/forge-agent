import type {
  ImportContributionResult,
  ImportPluginRequest,
  ImportSkillRequest,
  SearchCatalogRequest,
  SearchCatalogResult,
  SearchPluginsMarketplaceRequest,
  SearchPluginsMarketplaceResult,
  SearchSkillsMarketplaceRequest,
  SearchSkillsMarketplaceResult,
  SetPluginEnabledRequest,
  SetSkillEnabledRequest,
} from "@forge/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHub, type ExtensionRecord } from "@forge/extension-hub";
import {
  importFromCatalog,
  importPluginFromGitHub,
  importSkillFromGitHub,
  listCatalog,
  searchPluginsMarketplace,
  searchSkillsMarketplace,
  setPluginEnabled,
  setSkillEnabled,
} from "@forge/marketplace";

export async function handleSearchSkillsMarketplace(
  params: unknown,
): Promise<SearchSkillsMarketplaceResult> {
  const req = params as SearchSkillsMarketplaceRequest | undefined;
  return searchSkillsMarketplace({
    query: req?.query,
    mode: req?.mode ?? "all",
    limit: req?.limit ?? 40,
  });
}

export async function handleSearchPluginsMarketplace(
  params: unknown,
): Promise<SearchPluginsMarketplaceResult> {
  const req = params as SearchPluginsMarketplaceRequest | undefined;
  return searchPluginsMarketplace({
    query: req?.query,
    mode: req?.mode ?? "all",
    limit: req?.limit ?? 40,
  });
}

export function handleSearchCatalog(params: unknown): SearchCatalogResult {
  const req = params as SearchCatalogRequest | undefined;
  let items = listCatalog(req?.query);
  if (req?.kind) items = items.filter((i) => i.kind === req.kind);
  return {
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      kind: i.kind,
      repo: i.repo,
      tags: i.tags,
    })),
  };
}

/**
 * Import a skill/plugin through the Extension Hub so the content lands in the
 * hub store (SSOT) + a registry entry, then deploy to the Forge runtime dirs
 * (agent `forge`, symlink). This keeps the legacy `import_skill`/`import_plugin`
 * entrypoints working while making everything they import show up in the hub's
 * cross-agent deployment matrix (design doc §6 兼容策略).
 */
async function importViaHub(
  kind: "skill" | "plugin",
  req: (ImportSkillRequest & ImportPluginRequest) | undefined,
  dataDir: string,
): Promise<ImportContributionResult> {
  const hub = new ExtensionHub({ dataDir });
  const staging = await mkdtemp(join(tmpdir(), `forge-import-${kind}-`));
  try {
    let imported: ImportContributionResult;
    let source: ExtensionRecord["source"];
    if (req?.catalogId) {
      imported = await importFromCatalog({
        catalogId: req.catalogId,
        kind,
        destDir: staging,
        force: true,
      });
      source = { type: "catalog", ref: req.catalogId };
    } else if (req?.source) {
      imported =
        kind === "plugin"
          ? await importPluginFromGitHub({ source: req.source, destDir: staging, subdir: req.subdir, force: true })
          : await importSkillFromGitHub({ source: req.source, destDir: staging, subdir: req.subdir, force: true });
      source = { type: "github", repo: req.source, subdir: req.subdir };
    } else {
      throw new Error(`import_${kind} requires source or catalogId`);
    }

    const record = await hub.installLocal({
      id: imported.id,
      kind,
      sourceDir: imported.path,
      name: imported.name,
      source,
    });
    const deployed = await hub.deploy(record.id, { agents: ["forge"], scope: "user" });
    return {
      id: deployed.id,
      name: deployed.name,
      path: deployed.deployments.forge?.path ?? imported.path,
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export async function handleImportSkill(
  params: unknown,
  deps: { dataDir: string },
): Promise<ImportContributionResult> {
  return importViaHub("skill", params as ImportSkillRequest | undefined, deps.dataDir);
}

export async function handleImportPlugin(
  params: unknown,
  deps: { dataDir: string },
): Promise<ImportContributionResult> {
  return importViaHub("plugin", params as ImportPluginRequest | undefined, deps.dataDir);
}

export function handleSetSkillEnabled(params: unknown): { ok: true } {
  const req = params as SetSkillEnabledRequest;
  if (!req?.skillId) throw new Error("skillId is required");
  setSkillEnabled(req.skillId, req.enabled, {
    cwd: req.cwd,
    project: Boolean(req.project),
  });
  return { ok: true };
}

export function handleSetPluginEnabled(params: unknown): { ok: true } {
  const req = params as SetPluginEnabledRequest;
  if (!req?.pluginId) throw new Error("pluginId is required");
  setPluginEnabled(req.pluginId, req.enabled, {
    cwd: req.cwd,
    project: Boolean(req.project),
  });
  return { ok: true };
}
