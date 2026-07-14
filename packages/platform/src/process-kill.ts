import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function parsePidFile(pidFile: string): number | null {
  try {
    if (!existsSync(pidFile)) return null;
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    return Number.isFinite(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already exited */
  }
}

/** Best-effort terminate processes listening on a Unix socket (macOS/Linux). */
function killUnixSocketListeners(socketPath: string): void {
  try {
    const output = execSync(`lsof -t ${JSON.stringify(socketPath)} 2>/dev/null`, {
      encoding: "utf8",
    });
    const pids = new Set<number>();
    for (const line of output.split(/\n/)) {
      const pid = Number(line.trim());
      if (Number.isFinite(pid) && pid > 1) pids.add(pid);
    }
    for (const pid of pids) killPid(pid);
  } catch {
    /* no listeners */
  }
}

/**
 * Stop a daemon bound to `ipcPath`, using the pid file when available.
 * Falls back to `lsof` on Unix domain sockets (non-Windows).
 */
export function killProcessesOnIpcPath(
  ipcPath: string,
  options?: { pidFile?: string },
): void {
  if (options?.pidFile) {
    const pid = parsePidFile(options.pidFile);
    if (pid !== null) killPid(pid);
  }

  if (process.platform !== "win32" && !ipcPath.startsWith("\\\\.\\pipe\\")) {
    killUnixSocketListeners(ipcPath);
  }
}

/** Convenience wrapper when only the Forge data dir is known. */
export function killDaemonInDataDir(dataDir: string, ipcPath: string): void {
  killProcessesOnIpcPath(ipcPath, { pidFile: join(dataDir, "daemon.pid") });
}
