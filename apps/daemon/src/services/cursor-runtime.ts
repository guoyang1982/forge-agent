import { spawn, spawnSync } from "node:child_process";
import type {
  AgentEvent,
  RunRequest,
  RunResult,
  RuntimeModeSummary,
  RuntimeModelListResult,
  RuntimeModelSummary,
  RuntimeProbeResult,
} from "@forge/protocol";
import { prewarmAcpRuntime, runAcpRuntime } from "./acp-runtime.js";
import { loadForgeAcpMcpServers } from "./acp-mcp-bridge.js";

interface CursorRuntimeOptions {
  cwd: string;
  sessionId: string;
  request: RunRequest;
  priorHistory?: string;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
}

const CURSOR_BIN_CANDIDATES = ["cursor-agent", "agent"] as const;

const CURSOR_MODES: RuntimeModeSummary[] = [
  { id: "default", label: "Default", isDefault: true },
  { id: "agent", label: "Agent" },
  { id: "ask", label: "Ask" },
  { id: "plan", label: "Plan" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const next = value[key];
    if (typeof next === "string" && next.length > 0) return next;
  }
  return null;
}

export function resolveCursorBinary(): string | null {
  for (const candidate of CURSOR_BIN_CANDIDATES) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error) return candidate;
  }
  return null;
}

function toCursorAcpArgs(request: RunRequest): string[] {
  const sandbox = request.runtime?.sandboxMode;
  if (sandbox === "read-only" || sandbox === "enabled") {
    return ["--sandbox", "enabled"];
  }
  if (sandbox === "danger-full-access" || sandbox === "disabled") {
    return ["--sandbox", "disabled"];
  }
  return [];
}

function cursorAcpArgsKey(request: RunRequest): string {
  return JSON.stringify(toCursorAcpArgs(request));
}

function normalizeCursorModelLine(line: string): RuntimeModelSummary | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const id = trimmed.replace(/\s+\(default\)$/i, "").replace(/\s+\(current\)$/i, "").trim();
  if (!id) return null;
  return {
    id,
    model: id,
    displayName: id,
    isDefault: /\(default\)/i.test(trimmed),
  };
}

function normalizeCursorModelJson(value: unknown): RuntimeModelSummary | null {
  if (typeof value === "string") return normalizeCursorModelLine(value);
  if (!isRecord(value)) return null;
  const id = readString(value, ["id", "model", "name"]);
  if (!id) return null;
  return {
    id,
    model: readString(value, ["model"]) ?? id,
    displayName: readString(value, ["displayName", "name", "label"]) ?? id,
    description: readString(value, ["description"]) ?? undefined,
    isDefault: value.isDefault === true || value.default === true,
  };
}

async function runCursorCommand(
  binary: string,
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (cause) => {
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    });
    child.once("exit", (code) => resolve({ stdout, stderr, code }));
  });
}

export function listCursorModes(): RuntimeModeSummary[] {
  return CURSOR_MODES;
}

export async function listCursorModels(cwd: string): Promise<RuntimeModelListResult> {
  const binary = resolveCursorBinary();
  if (!binary) {
    throw new Error("未找到 cursor-agent CLI，请先安装 Cursor CLI（curl https://cursor.com/install | bash）");
  }
  const result = await runCursorCommand(binary, cwd, ["--list-models"]);
  if (result.code !== 0 && !result.stdout.trim()) {
    throw new Error(result.stderr.trim() || `cursor-agent --list-models exited (${result.code ?? "unknown"})`);
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) return { models: [] };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return {
        models: parsed.map(normalizeCursorModelJson).filter((m): m is RuntimeModelSummary => Boolean(m)),
      };
    }
    if (isRecord(parsed) && Array.isArray(parsed.models)) {
      return {
        models: parsed.models
          .map(normalizeCursorModelJson)
          .filter((m): m is RuntimeModelSummary => Boolean(m)),
      };
    }
  } catch {
    /* fall through */
  }
  return {
    models: trimmed
      .split(/\r?\n/)
      .map(normalizeCursorModelLine)
      .filter((m): m is RuntimeModelSummary => Boolean(m)),
  };
}

export async function probeCursorRuntime(cwd: string): Promise<RuntimeProbeResult> {
  const binary = resolveCursorBinary();
  if (!binary) {
    return {
      provider: "cursor",
      status: "binary_missing",
      message: "未找到 cursor-agent CLI",
      modes: CURSOR_MODES,
      models: [],
    };
  }

  try {
    const status = await runCursorCommand(binary, cwd, ["status"]);
    const output = `${status.stdout}\n${status.stderr}`.trim();
    const authed =
      status.code === 0 &&
      !/not logged in|login required|unauthenticated/i.test(output);
    if (!authed && !process.env.CURSOR_API_KEY) {
      return {
        provider: "cursor",
        status: "needs_setup",
        message: "请运行 cursor-agent login 或设置 CURSOR_API_KEY",
        binaryPath: binary,
        modes: CURSOR_MODES,
        models: [],
      };
    }
  } catch {
    if (!process.env.CURSOR_API_KEY) {
      return {
        provider: "cursor",
        status: "needs_setup",
        message: "请运行 cursor-agent login 或设置 CURSOR_API_KEY",
        binaryPath: binary,
        modes: CURSOR_MODES,
        models: [],
      };
    }
  }

  let models: RuntimeModelSummary[] = [];
  try {
    const listed = await listCursorModels(cwd);
    models = listed.models;
  } catch {
    models = [];
  }

  return {
    provider: "cursor",
    status: "ready",
    message: "Cursor Agent ACP 可用",
    binaryPath: binary,
    modes: CURSOR_MODES,
    models,
  };
}

export async function runCursorRuntime(options: CursorRuntimeOptions): Promise<RunResult> {
  const binary = resolveCursorBinary();
  if (!binary) {
    throw new Error("未找到 cursor-agent CLI，请先安装 Cursor CLI（curl https://cursor.com/install | bash）");
  }

  return runAcpRuntime({
    cwd: options.cwd,
    sessionId: options.sessionId,
    request: options.request,
    priorHistory: options.priorHistory,
    signal: options.signal,
    emit: options.emit,
    providerKey: "cursor",
    providerLabel: "Cursor Agent",
    acpArgsKey: cursorAcpArgsKey(options.request),
    provider: {
      binary,
      acpArgs: toCursorAcpArgs(options.request),
      clientInfo: { name: "forge-agent", version: "0.2.0" },
    },
    authenticateMethodId: "cursor_login",
    shouldAuthenticate: () => !process.env.CURSOR_API_KEY,
    buildSessionParams: (request, cwd) => {
      const mcpServers = loadForgeAcpMcpServers(cwd);
      return {
        model: request.runtime?.model,
        mode: request.runtime?.permissionMode,
        mcpServers,
      };
    },
  });
}

function cursorAcpRuntimeOptions(
  cwd: string,
  request: RunRequest,
): Omit<Parameters<typeof prewarmAcpRuntime>[0], "emit" | "sessionId"> {
  const binary = resolveCursorBinary();
  if (!binary) {
    throw new Error("未找到 cursor-agent CLI，请先安装 Cursor CLI（curl https://cursor.com/install | bash）");
  }
  return {
    cwd,
    request,
    providerKey: "cursor",
    providerLabel: "Cursor Agent",
    acpArgsKey: cursorAcpArgsKey(request),
    provider: {
      binary,
      acpArgs: toCursorAcpArgs(request),
      clientInfo: { name: "forge-agent", version: "0.2.0" },
    },
    authenticateMethodId: "cursor_login",
    shouldAuthenticate: () => !process.env.CURSOR_API_KEY,
    buildSessionParams: (req, workdir) => {
      const mcpServers = loadForgeAcpMcpServers(workdir);
      return {
        model: req.runtime?.model,
        mode: req.runtime?.permissionMode,
        mcpServers,
      };
    },
  };
}

export async function prewarmCursorAcp(options: {
  cwd: string;
  model?: string;
  mode?: string;
  sandboxMode?: string;
}): Promise<{ ok: boolean; skipped?: string }> {
  if (!resolveCursorBinary()) return { ok: false, skipped: "binary_missing" };
  const request: RunRequest = {
    message: "",
    cwd: options.cwd,
    runtime: {
      provider: "cursor",
      model: options.model,
      permissionMode: options.mode,
      sandboxMode: options.sandboxMode,
    },
  };
  try {
    return await prewarmAcpRuntime(cursorAcpRuntimeOptions(options.cwd, request));
  } catch {
    return { ok: false };
  }
}
