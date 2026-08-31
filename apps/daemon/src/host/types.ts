import type { AgentEvent } from "@forge/protocol";
import type { TypedRouter } from "./router.js";

export interface RpcContext {
  requestId: string;
  correlationId: string;
  emitLegacyAgentEvent: (event: AgentEvent) => void;
}

export type DaemonContext = object;

export interface DaemonModule<Context extends DaemonContext = DaemonContext> {
  readonly id: string;
  register(router: TypedRouter, context: Context): void;
  start?(context: Context): Promise<void> | void;
  stop?(context: Context): Promise<void> | void;
}
