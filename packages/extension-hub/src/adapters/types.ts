import type {
  AgentId,
  DeployMode,
  ExtensionKind,
  Scope,
} from "../types.js";

export interface DeployInput {
  extId: string;
  kind: ExtensionKind;
  /** Absolute path of the package in the hub store (SSOT). */
  sourcePath: string;
  scope: Scope;
  /** Required for project scope. */
  cwd?: string;
}

export interface DeployResult {
  path: string;
  mode: DeployMode;
  manifestVariant?: string;
  deployedHash: string;
  /** e.g. Cursor picks up local plugins automatically; kept for agents that need a reload. */
  needsAgentReload?: boolean;
  note?: string;
}

export interface UndeployInput {
  extId: string;
  kind: ExtensionKind;
  scope: Scope;
  cwd?: string;
  /** Absolute path recorded at deploy time; preferred over re-resolving. */
  path?: string;
}

export interface DiscoveredExt {
  id: string;
  kind: ExtensionKind;
  path: string;
  version?: string;
  contentHash: string;
}

export interface ProbeResult {
  available: boolean;
  version?: string;
}

/**
 * An adapter knows how to materialize / remove / discover extensions for one
 * agent. Implementations must be pure filesystem operations where possible so
 * they are testable against a temp home.
 */
export interface AgentAdapter {
  id: AgentId;
  label: string;
  probe(): Promise<ProbeResult>;
  resolveTargetPath(
    extId: string,
    kind: ExtensionKind,
    scope: Scope,
    cwd?: string,
  ): string;
  discoverInstalled(scope: Scope, cwd?: string): Promise<DiscoveredExt[]>;
  deploy(input: DeployInput): Promise<DeployResult>;
  undeploy(input: UndeployInput): Promise<void>;
}
