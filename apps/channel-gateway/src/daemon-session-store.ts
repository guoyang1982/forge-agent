import type {
  AppendSessionMessageInput,
  SessionDto,
} from "@forge/protocol";

export interface DaemonSessionClient {
  request(method: string, params?: unknown): Promise<unknown>;
}

export class DaemonSessionStore {
  constructor(private readonly client: DaemonSessionClient) {}

  async create(cwd: string): Promise<{ sessionId: string }> {
    return (await this.client.request("session.create", { cwd })) as {
      sessionId: string;
    };
  }

  async get(sessionId: string): Promise<SessionDto> {
    return (await this.client.request("session.get", { sessionId })) as SessionDto;
  }

  async appendMessage(input: AppendSessionMessageInput): Promise<void> {
    await this.client.request("session.appendMessage", input);
  }
}
