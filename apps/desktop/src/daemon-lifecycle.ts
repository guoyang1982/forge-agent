export function shouldReplaceConnectedDaemon(options: {
  isPackaged: boolean;
  developmentDaemonSynchronized: boolean;
  observedBuild: string;
  expectedBuild: string;
}): boolean {
  if (!options.isPackaged && !options.developmentDaemonSynchronized) {
    return true;
  }
  return options.observedBuild !== options.expectedBuild;
}

export function resolveDevelopmentNodeExecutable(
  env: NodeJS.ProcessEnv,
): string {
  return env.FORGE_NODE_EXECUTABLE || env.npm_node_execpath || "node";
}

export async function waitForDaemonDisconnect(
  ping: () => Promise<unknown>,
  pause: (ms: number) => Promise<void>,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 50;
  const intervalMs = options.intervalMs ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await ping();
    } catch {
      return;
    }
    await pause(intervalMs);
  }
  throw new Error("Forge daemon did not release its socket before restart");
}
