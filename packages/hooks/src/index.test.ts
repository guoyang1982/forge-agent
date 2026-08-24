import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractAdditionalContext, parseHookCommandOutput } from "./output.js";
import { matchesSessionSource, matchesToolName } from "./matcher.js";
import { expandHookCommand } from "./expand.js";
import { discoverHooks } from "./discover.js";
import { parseHooksSection } from "./schema.js";
import {
  runPostToolUseHooks,
  runPreCompactHooks,
  runSessionEndHooks,
  runStopHooks,
} from "./runner.js";
import { createHookSessionState } from "./session-source.js";
import {
  emptyHooksSettings,
  readHooksSettingsFile,
  resolveHooksSettingsPath,
  writeHooksSettingsFile,
} from "./settings-io.js";
import type { HookBinding } from "./types.js";

describe("hook output parsing", () => {
  it("reads Cursor additional_context", () => {
    expect(
      extractAdditionalContext({ additional_context: "hello" }),
    ).toBe("hello");
  });

  it("reads Claude hookSpecificOutput", () => {
    expect(
      extractAdditionalContext({
        hookSpecificOutput: { additionalContext: "nested" },
      }),
    ).toBe("nested");
  });

  it("parses permissionDecision from stdout", () => {
    const out = parseHookCommandOutput(
      '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked"}}',
    );
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toBe("blocked");
  });
});

describe("hook cancellation", () => {
  it("interrupts a running Stop command hook", async () => {
    const abort = new AbortController();
    const binding: HookBinding = {
      source: "user",
      sourceId: "slow-stop",
      event: "Stop",
      type: "command",
      command: "sleep 5",
    };
    const started = Date.now();
    const pending = runStopHooks({
      bindings: [binding],
      ctx: { sessionId: "sess-stop", cwd: process.cwd(), source: "startup", message: "x" },
      skills: [],
      finalText: "",
      stepsUsed: 1,
      toolsCalled: [],
      reason: "completed",
      signal: abort.signal,
    });

    setTimeout(() => abort.abort(), 20);
    await pending;

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("hook matcher", () => {
  it("matches startup|resume pattern", () => {
    expect(matchesSessionSource("startup|resume", "startup")).toBe(true);
    expect(matchesSessionSource("startup|clear|compact", "resume")).toBe(false);
  });

  it("matches tool names", () => {
    expect(matchesToolName("Bash|Write", "write_patch")).toBe(false);
    expect(matchesToolName("write_patch|write_file", "write_patch")).toBe(true);
  });
});

describe("command expansion", () => {
  it("expands project and plugin variables", () => {
    const cmd = expandHookCommand(
      "${FORGE_PROJECT_DIR}/.forge/hooks/x.sh ${FORGE_PLUGIN_ROOT}",
      { projectDir: "/proj", pluginRoot: "/plug" },
    );
    expect(cmd).toBe("/proj/.forge/hooks/x.sh /plug");
  });
});

describe("settings discovery", () => {
  it("loads project settings hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-hooks-"));
    const forgeDir = join(root, ".forge");
    mkdirSync(forgeDir, { recursive: true });
    writeFileSync(
      join(forgeDir, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [{ type: "inject-text", text: "hello from project" }],
            },
          ],
        },
      }),
    );
    const bindings = discoverHooks({
      cwd: root,
      dataDir: join(root, "data"),
      plugins: [],
    });
    const projectBindings = bindings.filter((b) => b.source === "project");
    expect(projectBindings).toHaveLength(1);
    expect(projectBindings[0]?.text).toBe("hello from project");
  });

  it("respects disableAllHooks", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-hooks-"));
    const forgeDir = join(root, ".forge");
    mkdirSync(forgeDir, { recursive: true });
    writeFileSync(
      join(forgeDir, "settings.json"),
      JSON.stringify({ disableAllHooks: true, hooks: { SessionStart: [] } }),
    );
    const bindings = discoverHooks({
      cwd: root,
      dataDir: join(root, "data"),
      plugins: [],
    });
    expect(bindings.filter((b) => b.source === "project")).toHaveLength(0);
  });
});

describe("schema parsing", () => {
  it("normalizes legacy event casing", () => {
    const bindings = parseHooksSection(
      {
        sessionStart: [
          { hooks: [{ type: "inject-text", text: "legacy" }] },
        ],
      },
      "user",
      "user",
      "/proj",
    );
    expect(bindings[0]?.event).toBe("SessionStart");
    expect(bindings[0]?.text).toBe("legacy");
  });
});

describe("settings io", () => {
  it("writes and reads project hooks settings", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-hooks-io-"));
    const path = resolveHooksSettingsPath("project", {
      cwd: root,
      dataDir: join(root, "data"),
    });
    const settings = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "inject-text" as const, text: "hi" }] },
        ],
      },
    };
    writeHooksSettingsFile(path, settings);
    const read = readHooksSettingsFile(path);
    expect(read.hooks?.SessionStart?.[0]?.hooks?.[0]?.text).toBe("hi");
    expect(emptyHooksSettings().hooks).toEqual({});
  });
});

describe("hook session source", () => {
  it("resolves explicit, pending, and default sources", () => {
    const state = createHookSessionState();
    state.setPendingHookSource("s1", "compact");
    expect(
      state.resolveSessionHookSource({
        explicit: "clear",
        sessionId: "s1",
        hasHistory: true,
      }),
    ).toBe("clear");
    expect(state.consumePendingHookSource("s1")).toBe("compact");
    expect(
      state.resolveSessionHookSource({ sessionId: "s2", hasHistory: false }),
    ).toBe("startup");
  });
});

describe("post/stop hooks", () => {
  const baseCtx = {
    cwd: "/proj",
    sessionId: "sess-1",
    message: "fix the bug",
    source: "startup" as const,
  };

  const postBinding: HookBinding = {
    source: "project",
    sourceId: "/proj",
    event: "PostToolUse",
    matcher: "read_file",
    type: "inject-text",
    text: "audit logged",
  };

  it("runs PostToolUse for matching tools", async () => {
    const out = await runPostToolUseHooks({
      bindings: [postBinding],
      ctx: {
        ...baseCtx,
        toolName: "read_file",
        toolInput: { path: "a.ts" },
        toolResult: '{"ok":true}',
        durationMs: 42,
      },
      skills: [],
    });
    expect(out.context).toBe("audit logged");
    expect(out.warned).toBe(false);
  });

  it("skips PostToolUse when matcher does not match", async () => {
    const out = await runPostToolUseHooks({
      bindings: [postBinding],
      ctx: {
        ...baseCtx,
        toolName: "write_patch",
        toolInput: {},
        toolResult: "ok",
        durationMs: 1,
      },
      skills: [],
    });
    expect(out.context).toBe("");
  });

  it("runs PreCompact hooks", async () => {
    const binding: HookBinding = {
      source: "project",
      sourceId: "/proj",
      event: "PreCompact",
      type: "inject-text",
      text: "backup before compact",
    };
    const out = await runPreCompactHooks({
      bindings: [binding],
      ctx: baseCtx,
      skills: [],
      messagesToSummarize: 10,
      keepLast: 4,
    });
    expect(out.blocked).toBe(false);
    expect(out.results[0]?.context).toBe("backup before compact");
  });

  it("runs SessionEnd hooks", async () => {
    const binding: HookBinding = {
      source: "user",
      sourceId: "user",
      event: "SessionEnd",
      type: "inject-text",
      text: "cleanup",
    };
    const out = await runSessionEndHooks({
      bindings: [binding],
      ctx: { sessionId: "sess-1", cwd: "/proj" },
      skills: [],
      reason: "shutdown",
    });
    expect(out.results[0]?.context).toBe("cleanup");
  });

  it("runs Stop hooks and can block completion", async () => {
    const stopBinding: HookBinding = {
      source: "user",
      sourceId: "user",
      event: "Stop",
      type: "inject-text",
      text: "stop note",
    };
    const out = await runStopHooks({
      bindings: [stopBinding],
      ctx: baseCtx,
      skills: [],
      finalText: "done",
      stepsUsed: 2,
      toolsCalled: ["read_file"],
      reason: "completed",
    });
    expect(out.blocked).toBe(false);
    expect(out.results[0]?.context).toBe("stop note");
  });
});
