import type { Interface } from "node:readline";
import type { AgentEvent } from "@forge/protocol";

export interface CommandContext {
  rl: Interface;
  getCwd: () => string;
  setCwd: (path: string) => Promise<void>;
  getSession: () => string | null;
  clearSession: () => void | Promise<void>;
  listSessions: () => Promise<void>;
  resumeSession: (sessionIdPrefix: string) => Promise<void>;
  compactSession: (sessionIdPrefix?: string) => Promise<void>;
  onExit: () => void;
  lastChanged: () => string[];
  requestDaemon: (
    method: string,
    params?: unknown,
    onEvent?: (event: AgentEvent) => void,
  ) => Promise<unknown>;
  printHelp: () => void;
  printUnknownSlash: (cmd: string) => void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  run: (ctx: CommandContext, args: string) => Promise<void> | void;
}
