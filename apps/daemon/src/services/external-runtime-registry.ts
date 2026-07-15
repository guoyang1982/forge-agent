import type { AgentEvent, RunRequest, RunResult, RuntimeCapabilities } from "@forge/protocol";

export interface ExternalRuntimeContext {
  cwd: string;
  sessionId: string;
  request: RunRequest;
  priorHistory?: string;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
}

export interface ExternalRuntimeRunner {
  id: string;
  label: string;
  capabilities: RuntimeCapabilities;
  run: (context: ExternalRuntimeContext) => Promise<RunResult>;
}

const runners = new Map<string, ExternalRuntimeRunner>();

export function registerExternalRuntime(runner: ExternalRuntimeRunner): void {
  runners.set(runner.id, runner);
}

export function getExternalRuntime(provider?: string | null): ExternalRuntimeRunner | null {
  if (!provider || provider === "forge") return null;
  return runners.get(provider) ?? null;
}

export function listRegisteredExternalRuntimes(): ExternalRuntimeRunner[] {
  return [...runners.values()];
}
