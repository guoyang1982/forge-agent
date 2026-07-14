import type { HookBinding, HookConfigSource, HookEventName, HookHandlerType } from "./types.js";
import { expandHookCommand } from "./expand.js";

const EVENT_ALIASES: Record<string, HookEventName> = {
  sessionstart: "SessionStart",
  sessionStart: "SessionStart",
  SessionStart: "SessionStart",
  userpromptsubmit: "UserPromptSubmit",
  userPromptSubmit: "UserPromptSubmit",
  UserPromptSubmit: "UserPromptSubmit",
  pretooluse: "PreToolUse",
  preToolUse: "PreToolUse",
  PreToolUse: "PreToolUse",
  posttooluse: "PostToolUse",
  postToolUse: "PostToolUse",
  PostToolUse: "PostToolUse",
  stop: "Stop",
  Stop: "Stop",
  sessionend: "SessionEnd",
  sessionEnd: "SessionEnd",
  SessionEnd: "SessionEnd",
  precompact: "PreCompact",
  preCompact: "PreCompact",
  PreCompact: "PreCompact",
};

export interface RawHookEntry {
  type?: string;
  command?: string;
  skillId?: string;
  text?: string;
  async?: boolean;
  matcher?: string;
  if?: string;
}

export interface RawHookGroup {
  matcher?: string;
  hooks?: RawHookEntry[];
}

function normalizeEventName(name: string): HookEventName | null {
  return EVENT_ALIASES[name] ?? null;
}

function pushBinding(
  out: HookBinding[],
  source: HookConfigSource,
  sourceId: string,
  event: HookEventName,
  entry: RawHookEntry,
  options: { projectDir: string; pluginRoot?: string; groupMatcher?: string },
): void {
  const type = (entry.type ?? "command") as HookHandlerType;
  if (type !== "command" && type !== "inject-skill" && type !== "inject-text") {
    return;
  }
  out.push({
    source,
    sourceId,
    pluginRoot: options.pluginRoot,
    event,
    matcher: entry.matcher ?? options.groupMatcher,
    if: entry.if,
    type,
    command: entry.command
      ? expandHookCommand(entry.command, {
          projectDir: options.projectDir,
          pluginRoot: options.pluginRoot,
        })
      : undefined,
    skillId: entry.skillId,
    text: entry.text,
    async: entry.async,
  });
}

export function parseHooksSection(
  hooks: Record<string, RawHookGroup[] | undefined> | undefined,
  source: HookConfigSource,
  sourceId: string,
  projectDir: string,
  pluginRoot?: string,
): HookBinding[] {
  const out: HookBinding[] = [];
  for (const [eventName, groups] of Object.entries(hooks ?? {})) {
    const event = normalizeEventName(eventName);
    if (!event || !Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const entry of group.hooks ?? []) {
        pushBinding(out, source, sourceId, event, entry, {
          projectDir,
          pluginRoot,
          groupMatcher: group.matcher,
        });
      }
    }
  }
  return out;
}

export function readDisableAllHooks(
  settings: { disableAllHooks?: boolean; hooks?: unknown } | undefined,
): boolean {
  return settings?.disableAllHooks === true;
}
