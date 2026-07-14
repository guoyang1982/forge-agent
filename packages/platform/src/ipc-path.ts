import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Resolve the daemon IPC listen path for the current platform.
 *
 * - macOS/Linux: Unix domain socket under the Forge data dir.
 * - Windows: named pipe (stable per data dir) — Node's `net` module accepts
 *   `\\.\pipe\…` paths via `server.listen()`.
 */
export function resolveDaemonIpcPath(dataDir: string): string {
  if (process.platform === "win32") {
    const id = createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\forge-agent-${id}`;
  }
  return join(dataDir, "daemon.sock");
}
