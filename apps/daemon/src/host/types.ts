import type { AgentEvent, ModuleHealthStatus } from "@forge/protocol";
import type { ForgeStore } from "@forge/store";
import type { TypedRouter } from "./router.js";

export interface RpcContext {
  requestId: string;
  correlationId: string;
  emitLegacyAgentEvent: (event: AgentEvent) => void;
}

export interface DaemonContext {
  socketPath: string;
  store: ForgeStore;
  serverVersion: string;
  build: string;
  eventTypes?: readonly string[];
}

export interface DaemonModuleFeature {
  version: number;
  enabled: boolean;
}

export interface DaemonModule<Context extends DaemonContext = DaemonContext> {
  readonly id: string;
  readonly feature?: DaemonModuleFeature;
  register(router: TypedRouter, context: Context): void;
  start?(context: Context): Promise<void> | void;
  stop?(context: Context): Promise<void> | void;
  health?(context: Context): Promise<ModuleHealthStatus> | ModuleHealthStatus;
}
