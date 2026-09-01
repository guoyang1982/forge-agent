import type {
  CapabilityManifest,
  EventEnvelope,
  ModuleHealthStatus,
  ModuleHealthSummary,
  SystemStatusResult,
} from "@forge/protocol";
import { RPC_PROTOCOL_VERSION } from "@forge/protocol";
import {
  DaemonServer,
  type CoreEventBroadcastFailure,
  type CoreEventBroadcastResult,
  type RpcRequestContext,
} from "@forge/bus";
import { createSystemModule } from "../modules/system-module.js";
import { handleSystemStatus } from "../services/status-service.js";
import { TypedRouter } from "./router.js";
import type { DaemonContext, DaemonModule, RpcContext } from "./types.js";

export class DaemonHost<Context extends DaemonContext = DaemonContext> {
  private readonly router = new TypedRouter();
  private readonly modules: Array<DaemonModule<Context>>;
  private readonly moduleStates = new Map<string, ModuleHealthStatus>();
  private readonly startedModules: Array<DaemonModule<Context>> = [];
  private readonly coreEventBroadcastFailureListeners = new Set<
    (failure: CoreEventBroadcastFailure) => void
  >();
  private server: DaemonServer | null = null;
  private removeServerBroadcastFailureListener: (() => void) | undefined;
  private registered = false;
  private storeClosed = false;

  constructor(
    modules: Array<DaemonModule<Context>>,
    private readonly context: Context,
  ) {
    const systemModule = createSystemModule({
      capabilities: () => this.capabilities(),
      status: () => this.status(),
    }) as DaemonModule<Context>;
    this.modules = [systemModule, ...modules];
    for (const module of this.modules) {
      this.moduleStates.set(module.id, "stopped");
    }
  }

  async start(): Promise<void> {
    if (this.server) return;
    try {
      this.registerModules();
      for (const module of this.modules) {
        await module.start?.(this.context);
        this.moduleStates.set(module.id, "healthy");
        this.startedModules.push(module);
      }
      this.server = new DaemonServer(
        this.context.socketPath,
        (method, params, emit, request) =>
          this.handleRequest(method, params, emit, request),
      );
      this.removeServerBroadcastFailureListener = this.server.onCoreEventBroadcastFailure(
        (failure) => this.reportCoreEventBroadcastFailure(failure),
      );
      await this.server.start();
    } catch (error) {
      this.removeServerBroadcastFailureListener?.();
      this.removeServerBroadcastFailureListener = undefined;
      this.server?.stop();
      this.server = null;
      await this.stopStartedModules();
      this.closeStore();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.removeServerBroadcastFailureListener?.();
    this.removeServerBroadcastFailureListener = undefined;
    this.server?.stop();
    this.server = null;
    const errors = await this.stopStartedModules();
    this.closeStore();
    if (errors.length > 0) {
      throw new AggregateError(errors, "Daemon module shutdown failed");
    }
  }

  broadcastCoreEvent(event: EventEnvelope): CoreEventBroadcastResult {
    return this.server?.broadcastCoreEvent(event) ?? {
      attempted: 0,
      delivered: 0,
      failed: 0,
    };
  }

  onCoreEventBroadcastFailure(
    listener: (failure: CoreEventBroadcastFailure) => void,
  ): () => void {
    this.coreEventBroadcastFailureListeners.add(listener);
    return () => this.coreEventBroadcastFailureListeners.delete(listener);
  }

  capabilities(): CapabilityManifest {
    return {
      protocolVersion: RPC_PROTOCOL_VERSION,
      serverVersion: this.context.serverVersion,
      methods: this.router.methods(),
      eventTypes: [...(this.context.eventTypes ?? [])],
      features: Object.fromEntries(
        this.modules
          .filter((module) => module.feature)
          .map((module) => [module.id, module.feature!]),
      ),
    };
  }

  async status(): Promise<SystemStatusResult> {
    return handleSystemStatus({
      store: this.context.store,
      modules: await this.moduleHealth(),
    });
  }

  private registerModules(): void {
    if (this.registered) return;
    for (const module of this.modules) {
      module.register(this.router, this.context);
    }
    this.registered = true;
  }

  private handleRequest(
    method: string,
    params: unknown,
    emitLegacyAgentEvent: RpcContext["emitLegacyAgentEvent"],
    request: RpcRequestContext,
  ): Promise<unknown> {
    return this.router.handleLegacy(method, params, {
      requestId: request.requestId,
      correlationId: request.correlationId,
      emitLegacyAgentEvent,
    });
  }

  private reportCoreEventBroadcastFailure(failure: CoreEventBroadcastFailure): void {
    for (const listener of this.coreEventBroadcastFailureListeners) {
      listener(failure);
    }
  }

  private async moduleHealth(): Promise<ModuleHealthSummary[]> {
    const summaries: ModuleHealthSummary[] = [];
    for (const module of this.modules) {
      let status = this.moduleStates.get(module.id) ?? "stopped";
      if (status === "healthy" && module.health) {
        try {
          status = await module.health(this.context);
        } catch {
          status = "degraded";
        }
      }
      summaries.push({ id: module.id, status });
    }
    return summaries;
  }

  private async stopStartedModules(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const module of this.startedModules.splice(0).reverse()) {
      try {
        await module.stop?.(this.context);
      } catch (error) {
        errors.push(error);
      } finally {
        this.moduleStates.set(module.id, "stopped");
      }
    }
    return errors;
  }

  private closeStore(): void {
    if (this.storeClosed) return;
    this.storeClosed = true;
    this.context.store.close();
  }
}
