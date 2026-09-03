import { connectDaemon, type DaemonClient } from "@forge/daemon-client";
import type { AdapterDaemonBridge, AdapterDaemonMethod } from "@forge/channel-core";
import type {
  AgentEvent,
  RpcMethod,
  RpcParams,
  RpcResult,
  RunRequest,
  RunResult,
} from "@forge/protocol";
import { DAEMON_METHODS } from "@forge/protocol";

export class ForgeBridge implements AdapterDaemonBridge {
  private client: DaemonClient | null = null;

  constructor(private readonly socketPath: string) {}

  isConnected(): boolean {
    return this.client != null;
  }

  get daemon(): DaemonClient {
    if (!this.client) throw new Error("forge daemon not connected");
    return this.client;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.client = await connectDaemon(this.socketPath);
  }

  async run(
    req: RunRequest,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<RunResult> {
    return (await this.request(
      DAEMON_METHODS.RUN,
      req,
      onEvent as ((event: unknown) => void) | undefined,
    )) as RunResult;
  }

  async request<M extends RpcMethod>(
    method: M,
    params?: RpcParams<M>,
    onEvent?: (event: unknown) => void,
  ): Promise<RpcResult<M>>;
  async request(
    method: AdapterDaemonMethod,
    params?: unknown,
    onEvent?: (event: unknown) => void,
  ): Promise<unknown>;
  async request(
    method: AdapterDaemonMethod,
    params?: unknown,
    onEvent?: (event: unknown) => void,
  ): Promise<unknown> {
    await this.connect();
    const client = this.client!;
    const eventHandler = onEvent as ((event: AgentEvent) => void) | undefined;
    if (eventHandler) {
      return client.request(method as RpcMethod, params as RpcParams<RpcMethod>, eventHandler);
    }
    return client.request(method as RpcMethod, params as RpcParams<RpcMethod>);
  }

  close(): void {
    this.client?.close();
    this.client = null;
  }
}
