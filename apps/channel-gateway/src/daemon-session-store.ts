import type {
  AppendSessionMessageInput,
  RpcMethod,
  RpcParams,
  RpcResult,
  SessionDto,
} from "@forge/protocol";

export interface DaemonSessionClient {
  request<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
  ): Promise<RpcResult<M>>;
}

export class DaemonSessionStore {
  constructor(private readonly client: DaemonSessionClient) {}

  async create(cwd: string): Promise<{ sessionId: string }> {
    return this.client.request("session.create", { cwd });
  }

  async get(sessionId: string): Promise<SessionDto> {
    return this.client.request("session.get", { sessionId });
  }

  async appendMessage(input: AppendSessionMessageInput): Promise<void> {
    await this.client.request("session.appendMessage", input);
  }
}
