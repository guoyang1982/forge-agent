import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HubAgentId,
  HubDeployRequest,
  HubDiscoverRequest,
  HubDiscoverResult,
  HubImportRequest,
  HubInstallRequest,
  HubListItem,
  HubListResult,
  HubMutationResult,
  HubRemoveRequest,
  HubSyncRequest,
  HubSyncResult,
  HubUndeployRequest,
} from "@forge/protocol";
import {
  ExtensionHub,
  type ExtensionRecord,
} from "@forge/extension-hub";
import { importPluginFromGitHub, importSkillFromGitHub } from "@forge/marketplace";

function getHub(dataDir: string): ExtensionHub {
  return new ExtensionHub({ dataDir });
}

function toHubListItem(record: ExtensionRecord): HubListItem {
  const deployments: HubListItem["deployments"] = {};
  for (const [agent, dep] of Object.entries(record.deployments)) {
    if (!dep) continue;
    deployments[agent as HubAgentId] = {
      scope: dep.scope,
      path: dep.path,
      mode: dep.mode,
      status: dep.status,
      manifestVariant: dep.manifestVariant,
      note: dep.note,
    };
  }
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    version: record.version,
    contentHash: record.contentHash,
    capabilities: record.capabilities,
    compatibility: record.compatibility ?? {
      forge: { status: "unknown", requirements: [], reason: "兼容性尚未分析" },
      cursor: { status: "unknown", requirements: [], reason: "兼容性尚未分析" },
      "claude-code": { status: "unknown", requirements: [], reason: "兼容性尚未分析" },
      codex: { status: "unknown", requirements: [], reason: "兼容性尚未分析" },
    },
    deployments,
  };
}

export async function handleHubList(
  _params: unknown,
  deps: { dataDir: string },
): Promise<HubListResult> {
  const registry = await getHub(deps.dataDir).list();
  return { items: Object.values(registry.extensions).map(toHubListItem) };
}

export async function handleHubInstall(
  params: unknown,
  deps: { dataDir: string },
): Promise<HubMutationResult> {
  const req = params as HubInstallRequest | undefined;
  if (!req?.kind) throw new Error("hub.install requires kind");
  const hub = getHub(deps.dataDir);

  let record: ExtensionRecord;
  if (req.sourceDir) {
    if (!req.id) throw new Error("hub.install from sourceDir requires id");
    record = await hub.installLocal({
      id: req.id,
      kind: req.kind,
      sourceDir: req.sourceDir,
      source: { type: "local", path: req.sourceDir },
    });
  } else if (req.source) {
    const staging = await mkdtemp(join(tmpdir(), "forge-hub-install-"));
    try {
      const imported =
        req.kind === "plugin"
          ? await importPluginFromGitHub({ source: req.source, destDir: staging, subdir: req.subdir, force: true })
          : await importSkillFromGitHub({ source: req.source, destDir: staging, subdir: req.subdir, force: true });
      record = await hub.installLocal({
        id: req.id ?? imported.id,
        kind: req.kind,
        sourceDir: imported.path,
        name: imported.name,
        source: { type: "github", repo: req.source, subdir: req.subdir },
      });
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    throw new Error("hub.install requires sourceDir or source");
  }

  if (req.agents?.length) {
    record = await hub.deploy(record.id, {
      agents: req.agents,
      scope: req.scope ?? "user",
      cwd: req.cwd,
    });
  }
  return { ok: true, item: toHubListItem(record) };
}

export async function handleHubDeploy(
  params: unknown,
  deps: { dataDir: string },
): Promise<HubMutationResult> {
  const req = params as HubDeployRequest | undefined;
  if (!req?.extId) throw new Error("hub.deploy requires extId");
  if (!req.agents?.length) throw new Error("hub.deploy requires agents");
  const record = await getHub(deps.dataDir).deploy(req.extId, {
    agents: req.agents,
    scope: req.scope ?? "user",
    cwd: req.cwd,
  });
  return { ok: true, item: toHubListItem(record) };
}

export async function handleHubUndeploy(
  params: unknown,
  deps: { dataDir: string },
): Promise<HubMutationResult> {
  const req = params as HubUndeployRequest | undefined;
  if (!req?.extId) throw new Error("hub.undeploy requires extId");
  if (!req.agent) throw new Error("hub.undeploy requires agent");
  await getHub(deps.dataDir).undeploy(req.extId, req.agent, req.scope ?? "user", req.cwd);
  return { ok: true };
}

export async function handleHubRemove(
  params: unknown,
  deps: { dataDir: string },
): Promise<HubMutationResult> {
  const req = params as HubRemoveRequest | undefined;
  if (!req?.extId) throw new Error("hub.remove requires extId");
  await getHub(deps.dataDir).remove(req.extId);
  return { ok: true };
}

export async function handleHubSync(
  params: unknown,
  deps: { dataDir: string },
): Promise<HubSyncResult> {
  const req = (params ?? {}) as HubSyncRequest;
  const entries = await getHub(deps.dataDir).sync(req.extId, { agents: req.agents });
  return { entries };
}

export async function handleHubDiscover(
  params: unknown,
  deps: { dataDir: string },
): Promise<HubDiscoverResult> {
  const req = (params ?? {}) as HubDiscoverRequest;
  const agents = await getHub(deps.dataDir).discover({
    agents: req.agents,
    scope: req.scope ?? "user",
    cwd: req.cwd,
  });
  return { agents };
}

export async function handleHubImport(
  params: unknown,
  deps: { dataDir: string },
): Promise<HubMutationResult> {
  const req = params as HubImportRequest | undefined;
  if (!req?.agent) throw new Error("hub.import requires agent");
  if (!req.extId) throw new Error("hub.import requires extId");
  const record = await getHub(deps.dataDir).importFromAgent(req.agent, req.extId, {
    kind: req.kind,
    scope: req.scope ?? "user",
    cwd: req.cwd,
  });
  return { ok: true, item: toHubListItem(record) };
}
