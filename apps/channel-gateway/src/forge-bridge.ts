import { connectDaemon } from "@forge/bus";
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
    await this.connect();
    if (!this.client) throw new Error("forge daemon not connected");
    return (await this.client.request(
      DAEMON_METHODS.RUN,
      req,
      onEvent,
    )) as RunResult;
  }

  close(): void {
    this.client?.close();
    this.client = null;
  }
}
