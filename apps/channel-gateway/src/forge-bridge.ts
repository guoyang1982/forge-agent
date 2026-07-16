import { connectDaemon } from "@forge/daemon-client";
import type { AgentEvent, RunRequest, RunResult } from "@forge/protocol";
import { DAEMON_METHODS } from "@forge/protocol";

export class ForgeBridge {
  private client: Awaited<ReturnType<typeof connectDaemon>> | null = null;

  constructor(private readonly socketPath: string) {}

  isConnected(): boolean {
    return this.client != null;
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

  async request(
    method: string,
    params?: unknown,
    onEvent?: (event: unknown) => void,
  ): Promise<unknown> {
    await this.connect();
    if (!this.client) throw new Error("forge daemon not connected");
    return this.client.request(method, params, onEvent);
  }

  close(): void {
    this.client?.close();
    this.client = null;
  }
}
