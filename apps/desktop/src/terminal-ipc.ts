import { ipcMain, type WebContents } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  clampTerminalSize,
  resolveDefaultShell,
  resolvePipeShell,
  resolveSpawnCwd,
} from "./terminal-shell.js";

const nodeRequire = createRequire(import.meta.url);

/**
 * Embedded terminal backend. Prefers a real PTY via node-pty (full color /
 * TUI / resize support, like VS Code's terminal). If the native module is not
 * available (e.g. not rebuilt for this Electron ABI), it falls back to a piped
 * child shell so the panel still runs commands — the app never breaks either
 * way. The native module is loaded lazily and defensively.
 */

interface TerminalSession {
  id: string;
  backend: "pty" | "pipe";
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NodePtyModule = any;

let ptyModuleResolved = false;
let ptyModule: NodePtyModule | null = null;

function loadPty(): NodePtyModule | null {
  if (ptyModuleResolved) return ptyModule;
  ptyModuleResolved = true;
  try {
    // Lazy require so a missing/unbuilt native module cannot crash app startup.
    ptyModule = nodeRequire("node-pty");
  } catch (err) {
    ptyModule = null;
    console.warn(
      "[forge-desktop] node-pty unavailable, falling back to piped shell:",
      err instanceof Error ? err.message : err,
    );
  }
  return ptyModule;
}

let seq = 0;
const sessions = new Map<string, TerminalSession>();

function nextId(): string {
  seq += 1;
  return `term-${seq}-${Date.now().toString(36)}`;
}

function send(target: WebContents, channel: string, payload: unknown): void {
  if (!target.isDestroyed()) target.send(channel, payload);
}

function createPtySession(options: {
  id: string;
  pty: NodePtyModule;
  cwd: string;
  cols: number;
  rows: number;
  target: WebContents;
}): TerminalSession {
  const { id, pty, cwd, cols, rows, target } = options;
  const shell = resolveDefaultShell(process.platform, process.env);
  const proc = pty.spawn(shell.file, shell.args, {
    name: "xterm-color",
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  proc.onData((data: string) => send(target, "forge:terminal-data", { id, data }));
  proc.onExit(({ exitCode }: { exitCode: number }) => {
    send(target, "forge:terminal-exit", { id, exitCode });
    sessions.delete(id);
  });
  return {
    id,
    backend: "pty",
    write: (data) => proc.write(data),
    resize: (c, r) => {
      try {
        proc.resize(c, r);
      } catch {
        /* ignore resize on a dead pty */
      }
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

function createPipeSession(options: {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  target: WebContents;
}): TerminalSession {
  const { id, cwd, cols, rows, target } = options;
  const shell = resolvePipeShell(process.platform, process.env);
  const child: ChildProcessWithoutNullStreams = spawn(shell.file, shell.args, {
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      // No real tty; hint dimensions so wrapping is roughly correct.
      COLUMNS: String(cols),
      LINES: String(rows),
    },
  });
  child.stdout.on("data", (buf: Buffer) =>
    send(target, "forge:terminal-data", { id, data: buf.toString("utf8") }),
  );
  child.stderr.on("data", (buf: Buffer) =>
    send(target, "forge:terminal-data", { id, data: buf.toString("utf8") }),
  );
  child.on("exit", (code) => {
    send(target, "forge:terminal-exit", { id, exitCode: code ?? 0 });
    sessions.delete(id);
  });
  child.on("error", (err) => {
    send(target, "forge:terminal-data", {
      id,
      data: `\r\n[forge] 终端启动失败: ${err.message}\r\n`,
    });
  });
  return {
    id,
    backend: "pipe",
    write: (data) => {
      try {
        child.stdin.write(data);
      } catch {
        /* stdin closed */
      }
    },
    resize: () => {
      /* piped child has no tty to resize */
    },
    kill: () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/** Register terminal IPC. Idempotent. Call once during app init. */
export function registerTerminalIpc(): void {
  ipcMain.handle(
    "forge:terminal-create",
    (
      event,
      payload: { cwd?: string; cols?: number; rows?: number },
    ): { id: string; backend: "pty" | "pipe" } => {
      const cwd = resolveSpawnCwd(payload?.cwd, process.env, existsSync);
      const { cols, rows } = clampTerminalSize(payload?.cols, payload?.rows);
      const id = nextId();
      const pty = loadPty();
      const session = pty
        ? createPtySession({ id, pty, cwd, cols, rows, target: event.sender })
        : createPipeSession({ id, cwd, cols, rows, target: event.sender });
      sessions.set(id, session);
      return { id, backend: session.backend };
    },
  );

  ipcMain.on(
    "forge:terminal-input",
    (_event, payload: { id: string; data: string }) => {
      sessions.get(payload?.id)?.write(payload.data ?? "");
    },
  );

  ipcMain.on(
    "forge:terminal-resize",
    (_event, payload: { id: string; cols: number; rows: number }) => {
      const { cols, rows } = clampTerminalSize(payload?.cols, payload?.rows);
      sessions.get(payload?.id)?.resize(cols, rows);
    },
  );

  ipcMain.on("forge:terminal-kill", (_event, payload: { id: string }) => {
    const session = sessions.get(payload?.id);
    if (!session) return;
    session.kill();
    sessions.delete(payload.id);
  });
}

/** Kill every live terminal (call on window close / before quit). */
export function disposeAllTerminals(): void {
  for (const session of sessions.values()) session.kill();
  sessions.clear();
}
