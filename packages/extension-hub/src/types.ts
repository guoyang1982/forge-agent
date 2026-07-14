/**
 * Extension Hub core types.
 *
 * An "extension" is the unified unit managed by the hub. A pure skill is the
 * minimal package (only a `skills/` payload); a plugin is the full-capability
 * package. Both share one registry and one deploy/undeploy/sync pipeline.
 *
 * See docs/superpowers/specs/2026-07-08-extension-hub-design.md.
 */

export type AgentId = "forge" | "cursor" | "claude-code" | "codex";

export const ALL_AGENTS: AgentId[] = ["forge", "cursor", "claude-code", "codex"];

export type ExtensionKind = "skill" | "plugin";

export type Scope = "user" | "project";

/**
 * How a deployment materializes into an agent's directory.
 * - `symlink`: target -> hub store (Forge default; zero-copy sync)
 * - `copy`: full copy (agents that do not follow symlinks / need isolation)
 * - `sideload`: Cursor `plugins/local/` drop-in (implemented as copy today)
 * - `native`: registered via the agent's own config/marketplace (e.g. Codex config.toml)
 */
export type DeployMode = "symlink" | "copy" | "sideload" | "native";

export type DeployStatus = "synced" | "drift" | "missing" | "error";

export interface ExtensionCapabilities {
  skills: string[];
  mcpServers: string[];
  commands: string[];
  hooks: string[];
  agents: string[];
}

export function emptyCapabilities(): ExtensionCapabilities {
  return { skills: [], mcpServers: [], commands: [], hooks: [], agents: [] };
}

/** Whether an extension can run in a particular agent without a host adapter. */
export type CompatibilityStatus = "compatible" | "adaptable" | "incompatible" | "unknown";

export interface AgentCompatibility {
  status: CompatibilityStatus;
  /** Concrete tools, APIs, or configuration that led to this result. */
  requirements: string[];
  reason: string;
}

export type ExtensionCompatibility = Record<AgentId, AgentCompatibility>;

export type ExtensionSourceType = "github" | "catalog" | "local" | "agent-import";

export interface ExtensionSource {
  type: ExtensionSourceType;
  repo?: string;
  ref?: string;
  subdir?: string;
  /** For `local` / `agent-import`: the origin path the content came from. */
  path?: string;
  /** For `agent-import`: which agent it was imported from. */
  fromAgent?: AgentId;
}

export interface DeploymentRecord {
  scope: Scope;
  /** Workspace dir for project-scope deploys (needed to re-resolve on sync). */
  cwd?: string;
  /** Absolute path where the extension was materialized in the agent. */
  path: string;
  mode: DeployMode;
  /** Relative manifest path used for this agent, e.g. `.cursor-plugin/plugin.json`. */
  manifestVariant?: string;
  /** Content hash at the moment of deploy; compared to `contentHash` for drift. */
  deployedHash: string;
  status: DeployStatus;
  deployedAt?: string;
  /** e.g. Cursor "requires reload window" hint. */
  note?: string;
}

export interface ExtensionRecord {
  kind: ExtensionKind;
  id: string;
  name: string;
  version?: string;
  /** SSOT content fingerprint of the store package. */
  contentHash: string;
  source?: ExtensionSource;
  capabilities: ExtensionCapabilities;
  /** Derived from package contents; absent on registries written before compatibility checks. */
  compatibility?: ExtensionCompatibility;
  installedAt: string;
  updatedAt: string;
  /** Per-agent deployment records. Absent key = not deployed to that agent. */
  deployments: Partial<Record<AgentId, DeploymentRecord>>;
}

export interface HubRegistry {
  version: number;
  extensions: Record<string, ExtensionRecord>;
}

export const REGISTRY_VERSION = 1;

export function emptyRegistry(): HubRegistry {
  return { version: REGISTRY_VERSION, extensions: {} };
}
