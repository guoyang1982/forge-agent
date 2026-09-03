import type { JsonRpcId } from "../index.js";

export const RPC_PROTOCOL_VERSION = 2 as const;

export const V2_RPC_METHODS = [
  "system.capabilities",
  "system.ping",
  "system.status",
  "run.create",
  "run.get",
  "run.cancel",
  "run.resume",
  "events.read",
  "events.cursor.ack",
  "workspace.groups.create",
  "workspace.groups.bind",
  "workspace.groups.listBindings",
  "approvals.list",
  "approvals.decide",
  "budgets.get",
  "artifacts.get",
  "validations.list",
  "agentProfiles.publish",
  "agentProfiles.resolve",
  "session.create",
  "session.get",
  "session.appendMessage",
] as const;

export const V2_EXECUTION_EVENT_TYPES = [
  "agent.event",
  "run.created",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "step.started",
  "step.succeeded",
  "step.failed",
  "step.cancelled",
  "step.skipped",
  "step.waiting",
  "step.resumed",
] as const;

export type RunState =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type StepState =
  | "pending"
  | "runnable"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface StepRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface StepSpec {
  id: string;
  kind: string;
  dependsOn: string[];
  input: unknown;
  workspaceBindingId?: string;
  idempotencyKey?: string;
  retry: StepRetryPolicy;
  timeoutMs: number;
}

export interface RunSpec {
  id: string;
  requestedBy: SubjectRef;
  actingSubject: SubjectRef;
  objective: string;
  steps: StepSpec[];
  budgetAccountId?: string;
  policyContext: Record<string, unknown>;
  correlationId: string;
}

export interface RunStepSummary {
  id: string;
  kind: string;
  state: StepState;
}

export interface SubscriptionFilter {
  runId?: string;
  subjectKind?: string;
  subjectId?: string;
  typePrefix?: string;
}

export interface CapabilityManifest {
  protocolVersion: typeof RPC_PROTOCOL_VERSION;
  serverVersion: string;
  methods: string[];
  eventTypes: string[];
  features: Record<string, { version: number; enabled: boolean }>;
}

export type ModuleHealthStatus = "healthy" | "degraded" | "stopped";

export interface ModuleHealthSummary {
  id: string;
  status: ModuleHealthStatus;
}

export interface SystemStatusResult {
  ok: boolean;
  migrationVersion: string | null;
  modules: ModuleHealthSummary[];
}

export interface AgentProfileRuntimePolicy {
  model: string;
  provider?: string;
  permissionMode?: string;
  routingPolicyVersion?: string;
  requiredCapabilities?: string[];
  dynamicStatus?: {
    enabled?: boolean;
    modelHeartbeatIntervalMs?: number;
    toolHeartbeatIntervalMs?: number;
    dedupeWindowMs?: number;
  };
  contextCompression?: {
    enabled?: boolean;
    triggerTokenEstimate?: number;
    tokenBudget?: number;
    modelFailureThreshold?: number;
    maxModelAttempts?: number;
  };
}

export interface RpcContractMap {
  "system.capabilities": {
    params: Record<string, never>;
    result: CapabilityManifest;
  };
  "system.ping": {
    params: Record<string, never>;
    result: { ok: true; version: string; build: string };
  };
  "system.status": {
    params: Record<string, never>;
    result: SystemStatusResult;
  };
  "run.create": {
    params: RunSpec;
    result: { runId: string; state: RunState };
  };
  "run.get": {
    params: { runId: string };
    result: {
      runId: string;
      state: RunState;
      objective: string;
      correlationId: string;
      steps: RunStepSummary[];
      createdAt: string;
      updatedAt: string;
    };
  };
  "run.cancel": {
    params: { runId?: string; sessionId?: string; reason?: string };
    result: { ok: true; runId: string; state: RunState };
  };
  "run.resume": {
    params: { waitId: string; payload: unknown };
    result: { ok: true; waitId: string };
  };
  "events.read": {
    params: {
      cursor: number;
      limit: number;
      filter: SubscriptionFilter;
    };
    result: { events: EventEnvelope[] };
  };
  "events.cursor.ack": {
    params: { consumerId: string; sequence: number };
    result: { ok: true; cursor: number };
  };
  "workspace.groups.create": {
    params: { id?: string; name: string; description?: string };
    result: {
      id: string;
      name: string;
      description?: string;
      createdAt: string;
      updatedAt: string;
    };
  };
  "workspace.groups.bind": {
    params: {
      id?: string;
      groupId: string;
      workspaceId: string;
      rootPath: string;
      mode: "read" | "write";
      pathScopes?: string[];
    };
    result: {
      id: string;
      groupId: string;
      workspaceId: string;
      rootPath: string;
      mode: "read" | "write";
      pathScopes: string[];
      createdAt: string;
    };
  };
  "workspace.groups.listBindings": {
    params: { groupId: string };
    result: {
      bindings: Array<{
        id: string;
        groupId: string;
        workspaceId: string;
        rootPath: string;
        mode: "read" | "write";
        pathScopes: string[];
        createdAt: string;
      }>;
    };
  };
  "approvals.list": {
    params: { subjectKind?: string; subjectId?: string; runId?: string };
    result: {
      approvals: Array<{
        id: string;
        subject: SubjectRef;
        action: string;
        resource: { kind: string; id: string };
        parametersHash: string;
        parametersSummary: string;
        risk: string;
        policyVersionId: string;
        state: string;
        runId?: string;
        stepId?: string;
        attemptId?: string;
        expiresAt: string;
        createdAt: string;
      }>;
    };
  };
  "approvals.decide": {
    params: {
      approvalId: string;
      decision: "approved" | "denied";
      actor: SubjectRef;
      reason?: string;
      parametersHash?: string;
    };
    result: {
      id: string;
      state: string;
      decision?: {
        decision: "approved" | "denied";
        actor: SubjectRef;
        reason?: string;
        decidedAt: string;
      };
    };
  };
  "budgets.get": {
    params: { accountId: string };
    result: {
      accountId: string;
      currency: string;
      hardLimitMinor?: string;
      committedMinor: string;
      reservedMinor: string;
      availableMinor?: string;
    };
  };
  "artifacts.get": {
    params: { artifactId: string };
    result: {
      id: string;
      producerRunId: string;
      producerStepId?: string;
      mediaType: string;
      sha256: string;
      sizeBytes: number;
      accessScope: Record<string, unknown>;
      metadata: Record<string, unknown>;
      createdAt: string;
    };
  };
  "validations.list": {
    params: { runId: string };
    result: {
      validations: Array<{
        id: string;
        runId: string;
        deliveryId: string;
        validatorId: string;
        layer: string;
        status: string;
        severity: string;
        summary: string;
        createdAt: string;
      }>;
    };
  };
  "agentProfiles.publish": {
    params: {
      profileId?: string;
      name?: string;
      model?: string;
      modelPolicy?: AgentProfileRuntimePolicy;
      policyVersionId?: string;
    };
    result: {
      profileId: string;
      versionId: string;
      version: number;
    };
  };
  "agentProfiles.resolve": {
    params: { profileId: string; profileVersionId: string; runId?: string };
    result: {
      snapshotId: string;
      profileId: string;
      profileVersionId: string;
      policyVersionId: string;
    };
  };
  "session.create": {
    params: { cwd: string };
    result: { sessionId: string };
  };
  "session.get": {
    params: { sessionId: string };
    result: SessionDto;
  };
  "session.appendMessage": {
    params: AppendSessionMessageInput;
    result: { ok: true };
  };
}

export interface SessionDto {
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface AppendSessionMessageInput {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: unknown;
}

export type RpcMethod = keyof RpcContractMap;
export type RpcParams<M extends RpcMethod> = RpcContractMap[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcContractMap[M]["result"];

export type RpcRequestEnvelope<M extends RpcMethod = RpcMethod> =
  M extends RpcMethod
    ? {
        jsonrpc: "2.0";
        id: JsonRpcId;
        protocolVersion: typeof RPC_PROTOCOL_VERSION;
        requestId: string;
        method: M;
        params: RpcParams<M>;
      }
    : never;

export type RpcSuccessEnvelope<M extends RpcMethod = RpcMethod> =
  M extends RpcMethod
    ? {
        jsonrpc: "2.0";
        id: JsonRpcId;
        protocolVersion: typeof RPC_PROTOCOL_VERSION;
        requestId: string;
        result: RpcResult<M>;
      }
    : never;

export type RpcFaultCode =
  | "INVALID_REQUEST"
  | "METHOD_NOT_FOUND"
  | "CORE_TIMEOUT"
  | "CORE_CANCELLED"
  | "POLICY_DENIED"
  | "APPROVAL_REQUIRED"
  | "BUDGET_EXCEEDED"
  | "WORKSPACE_CONFLICT"
  | "VERSION_CONFLICT"
  | "VALIDATION_FAILED"
  | "INTERNAL_ERROR";

export interface RpcFault {
  code: RpcFaultCode;
  message: string;
  retryable: boolean;
  correlationId?: string;
  detailsRef?: string;
}

export interface RpcErrorEnvelope {
  jsonrpc: "2.0";
  id: JsonRpcId;
  protocolVersion: typeof RPC_PROTOCOL_VERSION;
  requestId: string;
  error: RpcFault;
}

export type RpcResponseEnvelope<M extends RpcMethod = RpcMethod> =
  | RpcSuccessEnvelope<M>
  | RpcErrorEnvelope;

export interface SubjectRef {
  kind: string;
  id: string;
}

export interface EventEnvelope<T = unknown> {
  eventId: string;
  sequence: number;
  type: string;
  subject: SubjectRef;
  correlationId: string;
  runId?: string;
  stepId?: string;
  attemptId?: string;
  occurredAt: string;
  schemaVersion: number;
  data: T;
}

export const FORGE_LEGACY_AGENT_STEP_KIND = "forge.agent" as const;

/** Live event notification method for v2 event subscriptions. */
export const CORE_EVENT_METHOD = "core.event" as const;

/** Bridged AgentEvent payload marker on `agent.event` envelopes. Not a governance flag. */
export interface LegacyRunCompatibilityLinks {
  compatibility: true;
  legacyEventType: string;
  runId: string;
  stepId: string;
  attemptId: string;
  correlationId: string;
  sessionId?: string;
}

export interface RpcFaultOptions {
  retryable?: boolean;
  correlationId?: string;
  detailsRef?: string;
}

const RPC_FAULT_CODES = new Set<RpcFaultCode>([
  "INVALID_REQUEST",
  "METHOD_NOT_FOUND",
  "CORE_TIMEOUT",
  "CORE_CANCELLED",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "BUDGET_EXCEEDED",
  "WORKSPACE_CONFLICT",
  "VERSION_CONFLICT",
  "VALIDATION_FAILED",
  "INTERNAL_ERROR",
]);

const V2_RPC_METHOD_SET = new Set<string>(V2_RPC_METHODS);
const V2_SYSTEM_RPC_METHODS = new Set<string>([
  "system.capabilities",
  "system.ping",
  "system.status",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length > 0)
  );
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

export function isRpcRequestEnvelope(value: unknown): value is RpcRequestEnvelope {
  if (!isRecord(value) || !isRecord(value.params)) return false;
  return (
    value.jsonrpc === "2.0" &&
    isJsonRpcId(value.id) &&
    value.protocolVersion === RPC_PROTOCOL_VERSION &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.method === "string" &&
    V2_RPC_METHOD_SET.has(value.method) &&
    (V2_SYSTEM_RPC_METHODS.has(value.method)
      ? Object.keys(value.params).length === 0
      : true)
  );
}

export function isCapabilityManifest(value: unknown): value is CapabilityManifest {
  if (
    !isRecord(value) ||
    value.protocolVersion !== RPC_PROTOCOL_VERSION ||
    typeof value.serverVersion !== "string" ||
    value.serverVersion.length === 0 ||
    !Array.isArray(value.methods) ||
    !value.methods.every((method) => typeof method === "string" && method.length > 0) ||
    !Array.isArray(value.eventTypes) ||
    !value.eventTypes.every((eventType) => typeof eventType === "string" && eventType.length > 0) ||
    !isRecord(value.features)
  ) {
    return false;
  }

  return Object.values(value.features).every(
    (feature) =>
      isRecord(feature) &&
      Number.isInteger(feature.version) &&
      typeof feature.version === "number" &&
      feature.version >= 1 &&
      typeof feature.enabled === "boolean",
  );
}

export function rpcFault(
  code: RpcFaultCode,
  message: string,
  options: RpcFaultOptions = {},
): RpcFault {
  return {
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    ...(options.detailsRef ? { detailsRef: options.detailsRef } : {}),
  };
}

export function isRpcFault(value: unknown): value is RpcFault {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    RPC_FAULT_CODES.has(value.code as RpcFaultCode) &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    typeof value.retryable === "boolean" &&
    isOptionalNonEmptyString(value.correlationId) &&
    isOptionalNonEmptyString(value.detailsRef)
  );
}
