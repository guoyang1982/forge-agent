import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AcpPermissionHandler } from "./acp-permission.js";

const ACP_PROTOCOL_VERSION = 1;
/** Handshake / session setup — fail fast if the child process is stuck. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** Whole agent turn; tool loops can exceed the default RPC timeout. */
const PROMPT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

function requestTimeoutFor(method: string): number {
  return method === "session/prompt" ? PROMPT_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
}

type JsonRecord = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc?: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

export interface AcpProviderConfig {
  /** Binary to spawn, e.g. cursor-agent */
  binary: string;
  /** Args before `acp`, e.g. [] for cursor-agent acp */
  args?: string[];
  /** Extra args after `acp`, e.g. ["--sandbox", "enabled"] */
  acpArgs?: string[];
  clientInfo?: { name: string; version: string };
}

export interface AcpSessionNewParams {
  cwd: string;
  model?: string;
  mode?: string;
  mcpServers?: unknown[];
}

export interface AcpUpdate {
  sessionUpdate?: string;
  content?: { text?: string };
  title?: string;
  kind?: string;
  toolCallId?: string;
  rawInput?: unknown;
  status?: string;
}

export class AcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickAllowOption(options: unknown): string | null {
  if (!Array.isArray(options)) return null;
  for (const item of options) {
    if (!isRecord(item)) continue;
    const id = item.optionId ?? item.id;
    if (typeof id !== "string") continue;
    const label = String(item.label ?? item.name ?? id).toLowerCase();
    if (label.includes("allow") || label.includes("once") || label.includes("approve")) {
      return id;
    }
  }
  const first = options[0];
  if (isRecord(first)) {
    const id = first.optionId ?? first.id;
    if (typeof id === "string") return id;
  }
  return null;
}

export class AcpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      method: string;
      timer: NodeJS.Timeout;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private updateQueue: AcpUpdate[] = [];
  private updateWaiters: Array<(update: AcpUpdate) => void> = [];
  private permissionHandler?: AcpPermissionHandler;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly providerLabel: string,
  ) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.once("error", (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
    child.once("exit", (code, signal) => {
      const error = new AcpError(
        `${providerLabel} ACP exited (${signal ?? code ?? "unknown"})`,
      );
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
  }

  static spawn(config: AcpProviderConfig, options: { cwd: string; env?: NodeJS.ProcessEnv }): AcpClient {
    const args = [...(config.args ?? []), "acp", ...(config.acpArgs ?? [])];
    const child = spawn(config.binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new AcpClient(child, config.binary);
  }

  onStderr(handler: (text: string) => void): void {
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) handler(text);
    });
  }

  setPermissionHandler(handler: AcpPermissionHandler | undefined): void {
    this.permissionHandler = handler;
  }

  async initialize(clientInfo?: { name: string; version: string }): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: clientInfo ?? { name: "forge-agent", version: "0.2.0" },
    });
  }

  async authenticate(methodId: string): Promise<unknown> {
    return this.request("authenticate", { methodId });
  }

  async sessionNew(params: AcpSessionNewParams): Promise<string> {
    const payload: JsonRecord = {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    };
    if (params.model) payload.model = params.model;
    if (params.mode) payload.mode = params.mode;
    const result = await this.request("session/new", payload);
    if (!isRecord(result)) throw new AcpError("session/new returned no result");
    const sessionId = result.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new AcpError(`session/new returned no sessionId: ${JSON.stringify(result)}`);
    }
    return sessionId;
  }

  async sessionSetMode(sessionId: string, mode: string): Promise<void> {
    await this.request("session/set_mode", { sessionId, mode });
  }

  notifyCancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  async *promptStream(
    sessionId: string,
    prompt: Array<Record<string, unknown>>,
  ): AsyncGenerator<{ kind: "update"; update: AcpUpdate } | { kind: "result"; stopReason?: string }> {
    this.drainUpdates();
    const completion = this.request("session/prompt", { sessionId, prompt });
    let pendingWait: ReturnType<AcpClient["waitForUpdate"]> | null = null;

    try {
      while (true) {
        pendingWait = this.waitForUpdate();
        const next = await Promise.race([
          completion.then((result) => ({ type: "done" as const, result })),
          pendingWait.promise.then((update) => ({ type: "update" as const, update })),
        ]);
        pendingWait.cancel();
        pendingWait = null;

        if (next.type === "update") {
          yield { kind: "update", update: next.update };
          continue;
        }

        while (this.updateQueue.length) {
          yield { kind: "update", update: this.updateQueue.shift()! };
        }
        const result = isRecord(next.result) ? next.result : {};
        const stopReason =
          typeof result.stopReason === "string" ? result.stopReason : undefined;
        yield { kind: "result", stopReason };
        return;
      }
    } finally {
      pendingWait?.cancel();
      this.drainUpdates();
    }
  }

  close(): void {
    this.child.kill("SIGTERM");
  }

  isRunning(): boolean {
    return this.child.exitCode === null && !this.child.killed;
  }

  private drainUpdates(): void {
    this.updateQueue = [];
    this.updateWaiters = [];
  }

  private waitForUpdate(): { promise: Promise<AcpUpdate>; cancel: () => void } {
    const queued = this.updateQueue.shift();
    if (queued) {
      return { promise: Promise.resolve(queued), cancel: () => {} };
    }

    let cancelled = false;
    let resolve!: (value: AcpUpdate) => void;
    const promise = new Promise<AcpUpdate>((r) => {
      resolve = r;
    });
    const waiter = (update: AcpUpdate) => {
      if (cancelled) {
        this.updateQueue.push(update);
        return;
      }
      resolve(update);
    };
    this.updateWaiters.push(waiter);
    return {
      promise,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        const index = this.updateWaiters.indexOf(waiter);
        if (index >= 0) this.updateWaiters.splice(index, 1);
      },
    };
  }

  private pushUpdate(update: AcpUpdate): void {
    const waiter = this.updateWaiters.shift();
    if (waiter) waiter(update);
    else this.updateQueue.push(update);
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = requestTimeoutFor(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpError(`ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, timer, resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private reply(requestId: number, result: unknown): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: requestId, result })}\n`,
    );
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const message = parsed as unknown as JsonRpcMessage;

    if ("method" in message && typeof message.method === "string" && "id" in message) {
      this.handleServerRequest(message as JsonRpcNotification & { id: number });
      return;
    }

    if ("method" in message && message.method === "session/update") {
      const params = isRecord(message.params) ? message.params : {};
      const update = isRecord(params.update) ? (params.update as AcpUpdate) : null;
      if (update) this.pushUpdate(update);
      return;
    }

    const id = "id" in message && typeof message.id === "number" ? message.id : null;
    if (id == null) return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    if ("error" in message && message.error) {
      waiter.reject(new AcpError(message.error.message));
      return;
    }
    waiter.resolve("result" in message ? message.result : undefined);
  }

  private handleServerRequest(message: JsonRpcNotification & { id: number }): void {
    const method = message.method ?? "";
    if (method.includes("permission")) {
      void this.handlePermissionRequest(message);
      return;
    }
    this.reply(message.id, {});
  }

  private async handlePermissionRequest(
    message: JsonRpcNotification & { id: number },
  ): Promise<void> {
    const params = isRecord(message.params) ? message.params : {};
    if (this.permissionHandler) {
      try {
        const outcome = await this.permissionHandler(params);
        this.reply(message.id, { outcome });
        return;
      } catch {
        this.reply(message.id, { outcome: { outcome: "cancelled" } });
        return;
      }
    }
    const optionId = pickAllowOption(params.options) ?? "allow-once";
    this.reply(message.id, {
      outcome: { outcome: "selected", optionId },
    });
  }
}
