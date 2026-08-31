import type { JsonRpcId } from "../index.js";

export const RPC_PROTOCOL_VERSION = 2 as const;

export const V2_RPC_METHODS = [
  "system.capabilities",
  "system.ping",
  "system.status",
] as const;

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
    Object.keys(value.params).length === 0
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
