import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  cwd?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly prefix: string;

  constructor(readonly config: McpServerConfig) {
    this.prefix = `mcp_${config.name}_`;
  }

  async start(): Promise<void> {
    this.proc = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d) => this.onData(d.toString()));
    this.proc.stderr.on("data", () => {});
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "forge-agent", version: "0.2.0" },
    });
    this.notify("notifications/initialized", {});
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
        };
        if (msg.id === undefined) continue;
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } catch {
        /* ignore */
      }
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) return reject(new Error("MCP not started"));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, 30_000);
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  async listTools(): Promise<McpTool[]> {
    const res = (await this.request("tools/list", {})) as {
      tools?: McpTool[];
    };
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.request("tools/call", {
      name,
      arguments: args,
    })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text =
      res.content?.map((c) => c.text ?? "").join("\n") ?? JSON.stringify(res);
    return JSON.stringify({ ok: !res.isError, result: text.slice(0, 12_000) });
  }

  isRunning(): boolean {
    return (
      this.proc != null && this.proc.exitCode == null && !this.proc.killed
    );
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
