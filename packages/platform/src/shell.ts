export interface ResolvedShell {
  file: string;
  args: string[];
}

/**
 * Pick the login interactive shell for the platform. Honors $SHELL on
 * POSIX so the user gets their configured shell (zsh/bash/fish), falling back
 * to sensible defaults. On Windows prefers ComSpec/cmd or PowerShell.
 */
export function resolveDefaultShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ResolvedShell {
  if (platform === "win32") {
    const file = env.ComSpec || "powershell.exe";
    return { file, args: [] };
  }
  const file = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { file, args: ["-l", "-i"] };
}

/**
 * Pick a shell for a piped fallback backend. Unlike a real PTY, plain pipes
 * cannot support an interactive login shell; zsh exits with I/O errors without a TTY.
 */
export function resolvePipeShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ResolvedShell {
  if (platform === "win32") return resolveDefaultShell(platform, env);
  const file = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { file, args: ["-l"] };
}

function resolveHomeDir(env: NodeJS.ProcessEnv): string {
  return (env.HOME || env.USERPROFILE || "").trim();
}

function platformRootFallback(): string {
  return process.platform === "win32" ? process.cwd() : "/";
}

/**
 * Resolve the spawn working directory. Falls back to the user home (then a
 * platform root) when the requested cwd is missing/blank.
 */
export function resolveSpawnCwd(
  cwd: string | undefined | null,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string {
  const candidate = (cwd ?? "").trim();
  if (candidate && exists(candidate)) return candidate;
  const home = resolveHomeDir(env);
  if (home && exists(home)) return home;
  const fallback = platformRootFallback();
  if (exists(fallback)) return fallback;
  return fallback;
}

/** Clamp terminal dimensions to a sane range for the PTY ioctl. */
export function clampTerminalSize(
  cols: unknown,
  rows: unknown,
): { cols: number; rows: number } {
  const toInt = (v: unknown, fallback: number): number => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    cols: Math.min(Math.max(toInt(cols, 80), 1), 1000),
    rows: Math.min(Math.max(toInt(rows, 24), 1), 1000),
  };
}
