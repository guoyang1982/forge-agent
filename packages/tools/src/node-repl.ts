import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTIC_CHARS = 4_000;

interface WorkerReply {
  channel: "forge-node-repl";
  id: number;
  ok: boolean;
  result?: string;
  logs?: string[];
  error?: string;
}

interface PendingEvaluation {
  timer: NodeJS.Timeout;
  resolve: (reply: Omit<WorkerReply, "channel" | "id">) => void;
}

/**
 * The evaluator deliberately lives in a child process. JavaScript submitted to
 * node_repl may terminate or corrupt that process, but it cannot take down the
 * Forge daemon that owns the tool registry.
 */
const WORKER_BOOTSTRAP = `
globalThis.__forgeLogs = [];
globalThis.__forgeFormat = (value) => {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";
  try { return JSON.stringify(value); } catch { return String(value); }
};
const capture = (...args) => __forgeLogs.push(args.map(__forgeFormat).join(" "));
globalThis.console = Object.freeze({
  log: capture,
  info: capture,
  debug: capture,
  warn: capture,
  error: capture,
  dir: capture,
});
`;

const WORKER_SOURCE = String.raw`
const vm = require("node:vm");
const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});
new vm.Script(${JSON.stringify(WORKER_BOOTSTRAP)}).runInContext(context);

async function evaluate(message) {
  const id = message.id;
  new vm.Script("__forgeLogs.length = 0").runInContext(context);
  try {
    const script = new vm.Script(String(message.code || ""), {
      filename: "node_repl",
      displayErrors: true,
    });
    let value = script.runInContext(context, { timeout: message.timeoutMs });
    if (value && typeof value.then === "function") value = await value;
    context.__forgeValue = value;
    const result = new vm.Script("__forgeFormat(__forgeValue)").runInContext(context);
    delete context.__forgeValue;
    const logs = JSON.parse(
      new vm.Script("JSON.stringify(__forgeLogs)").runInContext(context),
    );
    process.send?.({
      channel: "forge-node-repl",
      id,
      ok: true,
      result,
      logs,
    });
  } catch (error) {
    const logs = JSON.parse(
      new vm.Script("JSON.stringify(__forgeLogs)").runInContext(context),
    );
    process.send?.({
      channel: "forge-node-repl",
      id,
      ok: false,
      error: error && error.stack ? String(error.stack) : String(error),
      logs,
    });
  }
}

let queue = Promise.resolve();
process.on("message", (message) => {
  if (!message || message.channel !== "forge-node-repl") return;
  queue = queue.then(() => evaluate(message));
});
`;

function boundedTimeout(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(parsed)));
}

function isWorkerReply(value: unknown): value is WorkerReply {
  if (!value || typeof value !== "object") return false;
  const reply = value as Partial<WorkerReply>;
  return (
    reply.channel === "forge-node-repl" &&
    typeof reply.id === "number" &&
    typeof reply.ok === "boolean"
  );
}

export class NodeReplSession {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEvaluation>();
  private diagnostics = "";
  private aborted = false;
  private readonly abortListener = () => {
    this.aborted = true;
    this.dispose();
  };

  constructor(
    private readonly cwd: string,
    private readonly signal?: AbortSignal,
  ) {
    if (signal?.aborted) {
      this.aborted = true;
    } else {
      signal?.addEventListener("abort", this.abortListener, { once: true });
    }
  }

  private start(): ChildProcess {
    if (this.child && this.child.exitCode == null && !this.child.killed) {
      return this.child;
    }
    const child = spawn(process.execPath, ["--permission", "-e", WORKER_SOURCE], {
      cwd: this.cwd,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    this.diagnostics = "";
    child.stdout?.on("data", (chunk: Buffer) => this.appendDiagnostic(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.appendDiagnostic(chunk));
    child.on("message", (message) => this.handleReply(message));
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.failAll(String(error));
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.failAll(
        `node_repl process exited (${signal ?? code ?? "unknown"})${
          this.diagnostics ? `: ${this.diagnostics}` : ""
        }`,
      );
    });
    return child;
  }

  private appendDiagnostic(chunk: Buffer): void {
    this.diagnostics = (this.diagnostics + chunk.toString("utf8")).slice(
      -MAX_DIAGNOSTIC_CHARS,
    );
  }

  private handleReply(message: unknown): void {
    if (!isWorkerReply(message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve({
      ok: message.ok,
      result: message.result,
      logs: message.logs,
      error: message.error,
    });
  }

  private failAll(error: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
    }
    this.pending.clear();
  }

  evaluate(
    code: string,
    timeoutValue?: unknown,
  ): Promise<Omit<WorkerReply, "channel" | "id">> {
    if (this.aborted) {
      return Promise.resolve({ ok: false, error: "node_repl session closed" });
    }
    const timeoutMs = boundedTimeout(timeoutValue);
    const child = this.start();
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: `node_repl timed out after ${timeoutMs}ms; the session was reset`,
        });
        this.dispose();
      }, timeoutMs + 50);
      this.pending.set(id, { timer, resolve });
      if (!child.connected) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: "node_repl process is not available" });
        return;
      }
      child.send(
        { channel: "forge-node-repl", id, code, timeoutMs },
        (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.resolve({ ok: false, error: String(error) });
        },
      );
    });
  }

  dispose(): void {
    this.signal?.removeEventListener("abort", this.abortListener);
    const child = this.child;
    this.child = null;
    if (child && child.exitCode == null && !child.killed) child.kill();
    this.failAll("node_repl session closed");
  }
}
