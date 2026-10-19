import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

export interface McpServerConfig {
  name: string;
  command?: string;
  /** Remote Streamable HTTP MCP endpoint. OAuth tokens stay outside this config. */
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  cwd?: string;
  /** Runtime-only bearer token. Never write this into mcp.json. */
  authorization?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  onServerRequest?: McpServerRequestHandler;
}

export interface McpClientOptions {
  requestTimeoutMs?: number;
  serverRequestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 180_000;

export interface McpServerRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export type McpServerRequestHandler = (
  request: McpServerRequest,
) => Promise<unknown>;

export interface McpToolCallOptions {
  onServerRequest?: McpServerRequestHandler;
  /** Persist the first image returned by the MCP tool to this validated path. */
  imageOutputPath?: string;
}

type McpContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: {
    uri?: string;
    blob?: string;
    mimeType?: string;
  };
};

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private stderrTail = "";
  private httpReady = false;
  private sessionId = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private readonly requestTimeoutMs: number;
  private readonly serverRequestTimeoutMs: number;
  readonly prefix: string;

  constructor(
    readonly config: McpServerConfig,
    options: McpClientOptions = {},
  ) {
    this.prefix = `mcp_${config.name}_`;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.serverRequestTimeoutMs =
      options.serverRequestTimeoutMs ?? DEFAULT_SERVER_REQUEST_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    if (this.startPromise) return this.startPromise;

    const starting = this.startProcess();
    this.startPromise = starting;
    try {
      await starting;
    } finally {
      if (this.startPromise === starting) this.startPromise = null;
    }
  }

  private async startProcess(): Promise<void> {
    if (this.config.url) {
      await this.startHttp();
      return;
    }
    if (!this.config.command) {
      throw new Error(`MCP ${this.config.name} 缺少 command`);
    }
    this.buffer = "";
    this.stderrTail = "";
    const proc = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stdout.on("data", (d) => this.onData(d.toString()));
    proc.stderr.on("data", (d) => {
      this.stderrTail = `${this.stderrTail}${d.toString()}`.slice(-4_000);
    });
    proc.once("error", (error) => this.invalidate(proc, error));
    proc.once("exit", (code, signal) => {
      const detail = this.stderrTail.trim();
      this.invalidate(
        proc,
        new Error(
          `MCP ${this.config.name} exited` +
            (code != null ? ` with code ${code}` : "") +
            (signal ? ` (${signal})` : "") +
            (detail ? `: ${detail}` : ""),
        ),
      );
    });
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
          id?: string | number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { message: string };
        };
        if (msg.id === undefined) continue;
        if (msg.method) {
          void this.handleServerRequest({
            id: msg.id,
            method: msg.method,
            params: msg.params,
          });
          continue;
        }
        if (typeof msg.id !== "number") continue;
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } catch {
        /* ignore */
      }
    }
  }

  private request(
    method: string,
    params: unknown,
    options: McpToolCallOptions = {},
  ): Promise<unknown> {
    if (this.config.url) return this.httpRequest(method, params);
    return new Promise((resolve, reject) => {
      const proc = this.proc;
      if (!proc?.stdin || !this.isRunning()) {
        return reject(new Error(`MCP ${this.config.name} is not running`));
      }
      const id = this.nextId++;
      const timer = this.createRequestTimer(proc, id, method, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        onServerRequest: options.onServerRequest,
      });
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        (error) => {
          if (error) this.invalidate(proc, error);
        },
      );
    });
  }

  private createRequestTimer(
    proc: ChildProcessWithoutNullStreams,
    id: number,
    method: string,
    timeoutMs: number,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.invalidate(proc, new Error(`MCP timeout: ${method}`));
    }, timeoutMs);
  }

  private rearmRequestTimer(id: number, timeoutMs: number): void {
    const pending = this.pending.get(id);
    const proc = this.proc;
    if (!pending || !proc) return;
    clearTimeout(pending.timer);
    pending.timer = this.createRequestTimer(proc, id, pending.method, timeoutMs);
  }

  private async handleServerRequest(request: McpServerRequest): Promise<void> {
    const active = [...this.pending.entries()]
      .reverse()
      .find(([, pending]) => pending.onServerRequest);
    if (!active) {
      this.sendServerResponse(request.id, undefined, {
        code: -32601,
        message: `Unsupported MCP server request: ${request.method}`,
      });
      return;
    }

    const [requestId, pending] = active;
    this.rearmRequestTimer(requestId, this.serverRequestTimeoutMs);
    try {
      const result = await pending.onServerRequest!(request);
      this.sendServerResponse(request.id, result);
      this.rearmRequestTimer(requestId, this.requestTimeoutMs * 2);
    } catch (error) {
      this.sendServerResponse(request.id, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      });
      this.rearmRequestTimer(requestId, this.requestTimeoutMs);
    }
  }

  private sendServerResponse(
    id: string | number,
    result?: unknown,
    error?: { code: number; message: string },
  ): void {
    this.proc?.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        ...(error ? { error } : { result }),
      }) + "\n",
    );
  }

  private invalidate(proc: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.proc !== proc) return;
    this.proc = null;
    if (proc.exitCode == null && !proc.killed) proc.kill();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private notify(method: string, params: unknown): void {
    if (this.config.url) {
      void this.postJsonRpc({ jsonrpc: "2.0", method, params });
      return;
    }
    this.proc?.stdin?.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  private async startHttp(): Promise<void> {
    if (!this.config.authorization) {
      throw new Error(`MCP ${this.config.name} 需要授权`);
    }
    await this.httpRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "forge-agent", version: "0.2.0" },
    });
    await this.postJsonRpc({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    this.httpReady = true;
  }

  private httpRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return this.postJsonRpc({ jsonrpc: "2.0", id, method, params });
  }

  private async postJsonRpc(payload: Record<string, unknown>): Promise<unknown> {
    if (!this.config.url || !this.config.authorization) {
      throw new Error(`MCP ${this.config.name} 需要授权`);
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.config.authorization}`,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await fetch(this.config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const session = response.headers.get("mcp-session-id") ?? "";
    if (session && session.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(session)) {
      this.sessionId = session;
    }
    if (response.status === 401) {
      this.httpReady = false;
      throw new Error(`MCP ${this.config.name} 需要重新授权`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP ${this.config.name} 请求失败 (${response.status})`);
    }
    if (!text.trim()) return undefined;
    const message = parseMcpHttpMessage(response.headers.get("content-type") ?? "", text);
    if (message.error) throw new Error(message.error.message || "MCP 请求失败");
    return message.result;
  }

  async listTools(): Promise<McpTool[]> {
    await this.start();
    const res = (await this.request("tools/list", {})) as {
      tools?: McpTool[];
    };
    return res.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpToolCallOptions = {},
  ): Promise<string> {
    await this.start();
    const res = (await this.request("tools/call", {
      name,
      arguments: args,
    }, options)) as {
      content?: McpContentBlock[];
      isError?: boolean;
    };
    const text =
      res.content?.map((c) => c.text ?? "").join("\n") ?? JSON.stringify(res);
    let imageSavedTo: string | undefined;
    if (options.imageOutputPath) {
      const image = res.content?.find(isImageContentBlock);
      if (!image) {
        return JSON.stringify({
          ok: false,
          error: "MCP tool did not return an image to save",
          result: text.slice(0, 12_000),
        });
      }
      imageSavedTo = await saveImageContentBlock(
        image,
        options.imageOutputPath,
      );
    }
    return JSON.stringify({
      ok: !res.isError,
      ...(imageSavedTo ? { imageSavedTo } : {}),
      result: text.slice(0, 12_000),
    });
  }

  isRunning(): boolean {
    if (this.config.url) return this.httpReady;
    return (
      this.proc != null && this.proc.exitCode == null && !this.proc.killed
    );
  }

  stop(): void {
    if (this.config.url) {
      this.httpReady = false;
      this.sessionId = "";
      return;
    }
    const proc = this.proc;
    if (proc) this.invalidate(proc, new Error(`MCP ${this.config.name} stopped`));
  }
}

export function parseMcpHttpMessage(
  contentType: string,
  body: string,
): { result?: unknown; error?: { message?: string } } {
  const payload = contentType.includes("text/event-stream")
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1)
    : body;
  if (!payload) return {};
  return JSON.parse(payload) as { result?: unknown; error?: { message?: string } };
}

function isImageContentBlock(block: McpContentBlock): boolean {
  if (block.type === "image" && typeof block.data === "string") return true;
  const uri = block.resource?.uri ?? block.uri;
  const blob = block.resource?.blob;
  const mimeType = block.resource?.mimeType ?? block.mimeType;
  return (
    typeof blob === "string" ||
    (typeof uri === "string" && uri.startsWith("file://"))
  ) && (mimeType?.startsWith("image/") ?? true);
}

async function saveImageContentBlock(
  block: McpContentBlock,
  outputPath: string,
): Promise<string> {
  const actualPath = pathForImageMimeType(
    outputPath,
    block.resource?.mimeType ?? block.mimeType,
  );
  await mkdir(dirname(actualPath), { recursive: true });
  if (block.type === "image" && typeof block.data === "string") {
    await writeFile(actualPath, Buffer.from(block.data, "base64"));
    return actualPath;
  }
  if (typeof block.resource?.blob === "string") {
    await writeFile(actualPath, Buffer.from(block.resource.blob, "base64"));
    return actualPath;
  }
  const uri = block.resource?.uri ?? block.uri;
  if (typeof uri === "string" && uri.startsWith("file://")) {
    await copyFile(fileURLToPath(uri), actualPath);
    return actualPath;
  }
  throw new Error("Unsupported MCP image content");
}

function pathForImageMimeType(outputPath: string, mimeType?: string): string {
  const expectedExtension =
    mimeType === "image/jpeg"
      ? ".jpg"
      : mimeType === "image/png"
        ? ".png"
        : mimeType === "image/webp"
          ? ".webp"
          : undefined;
  if (!expectedExtension) return outputPath;
  const currentExtension = extname(outputPath);
  if (currentExtension.toLowerCase() === expectedExtension) return outputPath;
  const stem = currentExtension
    ? outputPath.slice(0, -currentExtension.length)
    : outputPath;
  return `${stem}${expectedExtension}`;
}
