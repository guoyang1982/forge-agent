export interface DynamicStatusRuntimePolicy {
  enabled?: boolean;
  modelHeartbeatIntervalMs?: number;
  toolHeartbeatIntervalMs?: number;
  dedupeWindowMs?: number;
}

export interface ContextCompressionRuntimePolicy {
  enabled?: boolean;
  triggerTokenEstimate?: number;
  tokenBudget?: number;
  modelFailureThreshold?: number;
  maxModelAttempts?: number;
}

export interface RuntimePolicy {
  model: string;
  provider?: string;
  permissionMode?: string;
  routingPolicyVersion?: string;
  requiredCapabilities?: string[];
  dynamicStatus?: DynamicStatusRuntimePolicy;
  contextCompression?: ContextCompressionRuntimePolicy;
}

export interface AssetVersionRef {
  assetId: string;
  version: string | number;
}

export interface ToolGrant {
  name: string;
  scope?: Record<string, unknown>;
}

export interface ConnectorGrantRef {
  connectorId: string;
  accountId?: string;
}

export interface ProfileVersionSnapshot {
  displayName: string;
  modelPolicy: RuntimePolicy;
  skills: AssetVersionRef[];
  tools: ToolGrant[];
  knowledge: AssetVersionRef[];
  memoryScopes: string[];
  connectors: ConnectorGrantRef[];
}

export interface AgentProfileRecord {
  id: string;
  name: string;
  sourceKind: string;
  sourceRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileVersion {
  id: string;
  profileId: string;
  version: number;
  snapshot: ProfileVersionSnapshot;
  policyVersionId?: string;
  createdAt: string;
}

export interface AgentCapabilitySnapshot {
  id: string;
  profileId: string;
  profileVersionId: string;
  runId?: string;
  modelPolicy: RuntimePolicy;
  runtime: RuntimePolicy;
  skills: AssetVersionRef[];
  tools: ToolGrant[];
  knowledge: AssetVersionRef[];
  memoryScopes: string[];
  connectors: ConnectorGrantRef[];
  policyVersionId: string;
  createdAt: string;
}

export interface PublishVersionInput {
  profileId?: string;
  name?: string;
  sourceKind?: string;
  sourceRef?: string;
  model?: string;
  modelPolicy?: RuntimePolicy;
  skills?: AssetVersionRef[];
  tools?: ToolGrant[];
  knowledge?: AssetVersionRef[];
  memoryScopes?: string[];
  connectors?: ConnectorGrantRef[];
  policyVersionId?: string;
}

export interface TalentProfileSource {
  templateId: string;
  name: string;
  suggestedSkills: string[];
  suggestedTools: string[];
  knowledgeRefs?: string[];
  connectors?: string[];
}

export interface TalentHiredBindings {
  skills?: string[];
  tools?: string[];
  strictSkills?: boolean;
}

export interface CreateFromTalentInput {
  source: TalentProfileSource;
  hired?: TalentHiredBindings;
  model?: string;
  policyVersionId?: string;
}

export interface ResolveSnapshotInput {
  profileId: string;
  profileVersionId: string;
  runId?: string;
}
