import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDataDir, loadConfig } from "@forge/config";
import {
  discoverHooks,
  readHooksSettingsFile,
  resolveHooksSettingsPath,
  writeHooksSettingsFile,
  type HooksSettingsFile,
  type HooksSettingsScope,
} from "@forge/hooks";
import { discoverPlugins } from "@forge/plugin-registry";

const EDITABLE_SCOPES: HooksSettingsScope[] = [
  "user",
  "project",
  "project-local",
];

export interface HooksSettingsResponse {
  scope: HooksSettingsScope;
  path: string;
  exists: boolean;
  editable: boolean;
  settings: HooksSettingsFile;
}

export interface DiscoveredHookRow {
  source: string;
  sourceId: string;
  event: string;
  type: string;
  matcher?: string;
}

function monorepoRootFromDesktop(distDir: string): string {
  return join(distDir, "..", "..", "..");
}

export function getHooksSettingsPayload(options: {
  scope: HooksSettingsScope;
  cwd?: string;
  distDir: string;
}): HooksSettingsResponse {
  const cfg = loadConfig({ cwd: options.cwd });
  const dataDir = cfg.daemon?.dataDir ?? getDataDir();
  const path = resolveHooksSettingsPath(options.scope, {
    cwd: options.cwd,
    dataDir,
  });
  const editable = EDITABLE_SCOPES.includes(options.scope);
  let settings: HooksSettingsFile = { hooks: {} };
  if (existsSync(path)) {
    settings = readHooksSettingsFile(path);
  }
  return {
    scope: options.scope,
    path,
    exists: existsSync(path),
    editable,
    settings,
  };
}

export function saveHooksSettingsPayload(options: {
  scope: HooksSettingsScope;
  cwd?: string;
  settings: HooksSettingsFile;
  distDir: string;
}): HooksSettingsResponse {
  if (!EDITABLE_SCOPES.includes(options.scope)) {
    throw new Error(`Scope is not editable: ${options.scope}`);
  }
  const cfg = loadConfig({ cwd: options.cwd });
  const dataDir = cfg.daemon?.dataDir ?? getDataDir();
  const path = resolveHooksSettingsPath(options.scope, {
    cwd: options.cwd,
    dataDir,
  });
  writeHooksSettingsFile(path, options.settings);
  return getHooksSettingsPayload({
    scope: options.scope,
    cwd: options.cwd,
    distDir: options.distDir,
  });
}

export function listDiscoveredHooksPayload(options: {
  cwd: string;
  distDir: string;
}): DiscoveredHookRow[] {
  const absCwd = resolve(options.cwd);
  const cfg = loadConfig({ cwd: absCwd });
  const dataDir = cfg.daemon?.dataDir ?? getDataDir();
  const root = monorepoRootFromDesktop(options.distDir);
  const plugins = discoverPlugins({
    builtinDir: join(root, "plugins"),
    userDir: join(dataDir, "plugins"),
    projectDir: join(absCwd, ".forge", "plugins"),
    config: cfg,
  });
  const bindings = discoverHooks({
    cwd: absCwd,
    dataDir,
    plugins,
  });
  return bindings.map((b) => ({
    source: b.source,
    sourceId: b.sourceId,
    event: b.event,
    type: b.type,
    matcher: b.matcher,
  }));
}
