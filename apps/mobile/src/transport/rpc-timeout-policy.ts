import type { MobileRpcMethod } from "@forge/mobile-protocol";

const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * Agent runs are event streams whose request resolves only when the run ends.
 * Their lifetime is controlled by cancellation and connection closure, not by
 * the short request/response timeout used for status and list operations.
 */
export function rpcTimeoutMs(method: MobileRpcMethod | "run.resume"): number | null {
  return method === "run.start" ? null : DEFAULT_RPC_TIMEOUT_MS;
}
