import { spawnSync } from "node:child_process";
import type {
  RuntimeListResult,
  RuntimeProbeResult,
  RuntimeProviderSummary,
  RuntimeStatus,
} from "@forge/protocol";
import { acpSessionPool } from "./acp-session-pool.js";
import { listCursorModes, prewarmCursorAcp, probeCursorRuntime } from "./cursor-runtime.js";

function commandExists(name: string): boolean {
  const probe = spawnSync(name, ["--version"], { stdio: "ignore" });
  return !probe.error;
}

function summarizeBinaryProvider(options: {
  id: string;
  label: string;
  kind: RuntimeProviderSummary["kind"];
  binaryCandidates: string[];
  readyMessage: string;
}): RuntimeProviderSummary {
  const found = options.binaryCandidates.find((name) => commandExists(name));
  if (!found) {
    return {
      id: options.id,
      label: options.label,
      kind: options.kind,
      status: "binary_missing",
      message: `未找到 ${options.binaryCandidates[0]} CLI`,
    };
  }
  return {
    id: options.id,
    label: options.label,
    kind: options.kind,
    status: "ready",
    message: options.readyMessage,
    binaryPath: found,
  };
}

export async function listRuntimes(cwd: string): Promise<RuntimeListResult> {
  const cursorProbe = await probeCursorRuntime(cwd);
  const providers: RuntimeProviderSummary[] = [
    {
      id: "forge",
      label: "Forge Agent",
      kind: "default",
      status: "ready",
      message: "内置 ReAct runtime",
    },
    summarizeBinaryProvider({
      id: "claude-code",
      label: "Claude Code",
      kind: "cli",
      binaryCandidates: ["claude"],
      readyMessage: "Claude Code CLI 可用",
    }),
    summarizeBinaryProvider({
      id: "codex",
      label: "Codex",
      kind: "app-server",
      binaryCandidates: ["codex"],
      readyMessage: "Codex app-server 可用",
    }),
    {
      id: cursorProbe.provider,
      label: "Cursor",
      kind: "acp",
      status: cursorProbe.status,
      message: cursorProbe.message,
      binaryPath: cursorProbe.binaryPath,
      modes: cursorProbe.modes ?? listCursorModes(),
      models: cursorProbe.models,
    },
    {
      id: "opencode",
      label: "OpenCode",
      kind: "acp",
      status: "needs_setup",
      message: "ACP provider，即将支持",
    },
  ];
  return { providers };
}

export async function closeAcpSession(params: {
  provider?: string;
  sessionId: string;
}): Promise<{ ok: true; released: number }> {
  if (!params.provider || params.provider === "*") {
    const released = await acpSessionPool.releaseForgeSession(params.sessionId);
    return { ok: true, released };
  }
  await acpSessionPool.release(params.provider, params.sessionId);
  return { ok: true, released: 1 };
}

export async function releaseAcpForgeSession(sessionId: string): Promise<{ released: number }> {
  const released = await acpSessionPool.releaseForgeSession(sessionId);
  return { released };
}

export async function releaseAllAcpSessions(): Promise<{ released: number }> {
  const released = await acpSessionPool.releaseAll();
  return { released };
}

export function listWarmAcpSessions(): Array<{
  providerKey: string;
  forgeSessionId: string;
  cwd: string;
  model?: string;
  mode?: string;
  lastUsedAt: number;
  prewarm?: boolean;
}> {
  return acpSessionPool.listWarmSessions();
}

export async function prewarmAcpSession(params: {
  provider: string;
  cwd: string;
  model?: string;
  mode?: string;
  sandboxMode?: string;
}): Promise<{ ok: boolean; skipped?: string }> {
  const cwd = String(params.cwd || "").trim();
  if (!cwd) throw new Error("cwd required");
  if (params.provider === "cursor") {
    return prewarmCursorAcp({
      cwd,
      model: params.model,
      mode: params.mode,
      sandboxMode: params.sandboxMode as never,
    });
  }
  return { ok: false, skipped: "unsupported_provider" };
}

export async function probeRuntimeProvider(
  provider: string,
  cwd: string,
): Promise<RuntimeProbeResult> {
  if (provider === "cursor") return probeCursorRuntime(cwd);
  const listed = await listRuntimes(cwd);
  const match = listed.providers.find((item) => item.id === provider);
  if (!match) {
    return { provider, status: "needs_setup" as RuntimeStatus, message: "未知 runtime" };
  }
  return {
    provider: match.id,
    status: match.status,
    message: match.message,
    binaryPath: match.binaryPath,
    modes: match.modes,
    models: match.models,
  };
}
