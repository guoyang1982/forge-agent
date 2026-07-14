import type { AgentId } from "../types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { ForgeAdapter } from "./forge.js";
import type { AgentAdapter } from "./types.js";

export * from "./types.js";
export { ForgeAdapter } from "./forge.js";
export { CursorAdapter } from "./cursor.js";
export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";

/** Build the default adapter registry covering all four agents. */
export function createDefaultAdapters(): Partial<Record<AgentId, AgentAdapter>> {
  return {
    forge: new ForgeAdapter(),
    cursor: new CursorAdapter(),
    "claude-code": new ClaudeAdapter(),
    codex: new CodexAdapter(),
  };
}
