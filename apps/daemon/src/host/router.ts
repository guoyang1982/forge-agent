import type {
  RpcFault,
  RpcMethod,
  RpcParams,
  RpcResult,
} from "@forge/protocol";
import { isRpcFault, rpcFault } from "@forge/protocol";
import type { RpcContext } from "./types.js";

type RegisteredHandler = (
  params: unknown,
  context: RpcContext,
) => Promise<unknown>;

export class RpcFaultError extends Error {
  readonly name = "RpcFaultError";

  constructor(readonly fault: RpcFault) {
    super(fault.message);
  }
}

export class TypedRouter {
  private readonly handlers = new Map<RpcMethod, RegisteredHandler>();

  register<M extends RpcMethod>(
    method: M,
    handler: (
      params: RpcParams<M>,
      context: RpcContext,
    ) => Promise<RpcResult<M>>,
  ): void {
    if (this.handlers.has(method)) {
      throw new Error(`RPC method already registered: ${method}`);
    }
    this.handlers.set(method, handler as RegisteredHandler);
  }

  async handle<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    context: RpcContext,
  ): Promise<RpcResult<M>> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new RpcFaultError(
        rpcFault("METHOD_NOT_FOUND", "RPC method not found", {
          correlationId: context.correlationId,
        }),
      );
    }

    try {
      return (await handler(params, context)) as RpcResult<M>;
    } catch (error) {
      throw normalizeRpcError(error, context.correlationId);
    }
  }

  methods(): RpcMethod[] {
    return [...this.handlers.keys()];
  }
}

function normalizeRpcError(error: unknown, correlationId: string): RpcFaultError {
  const explicitFault = extractRpcFault(error);
  if (explicitFault) {
    return new RpcFaultError(withCorrelationId(explicitFault, correlationId));
  }
  return new RpcFaultError(
    rpcFault("INTERNAL_ERROR", "Internal RPC error", { correlationId }),
  );
}

function extractRpcFault(error: unknown): RpcFault | undefined {
  if (isRpcFault(error)) return error;
  if (error instanceof RpcFaultError) return error.fault;
  if (!isRecord(error)) return undefined;
  return isRpcFault(error.fault) ? error.fault : undefined;
}

function withCorrelationId(fault: RpcFault, correlationId: string): RpcFault {
  return fault.correlationId ? fault : { ...fault, correlationId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
