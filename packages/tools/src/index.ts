import type {
  AgentEvent,
  PermissionsConfig,
  ToolCall,
  ToolDefinition,
} from "@forge/protocol";
import {
  WorkspaceGuard,
  listDir,
  readFileLimited,
  grepWorkspace,
  applyUnifiedPatch,
  validateUnifiedPatch,
  buildCreateFileDiff,
  buildReplaceFileDiff,
  applySimplePatch,
  normalizeEol,
  detectRunHints,
  toWorkspaceRelativePath,
  normalizeCommandForWorkspace,
} from "@forge/workspace";
import { validateJsonLikeWrite } from "./json-write-guard.js";
import { readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isGitRepository } from "@forge/workspace";
import { parseCommandLine } from "./shell-safe.js";
import { runSafeShell } from "./run-shell.js";
import { NodeReplSession } from "./node-repl.js";

export { validateShellCommand } from "./shell-safe.js";
export { runSafeShell } from "./run-shell.js";
export {
  ToolDiscovery,
  catalogFromDefinitions,
  type RiskLevel,
  type ToolCatalogEntry,
  type ToolDiscoveryTrace,
  type ToolSchema,
  type ToolSearchInput,
  type ToolSummary,
} from "./discovery.js";

export interface NetworkConfirmRequest {
  action: "search" | "web" | "api" | "download";
  summary: string;
  detail: Record<string, unknown>;
}

export interface SoftwareConfirmRequest {
  action: "install" | "uninstall";
  summary: string;
  detail: Record<string, unknown>;
}

export interface ToolContext {
  guard: WorkspaceGuard;
  emit: (event: AgentEvent) => void;
  autoApply: boolean;
  pendingPatches: Map<string, string>;
  signal?: AbortSignal;
  /** Plugin skill roots for read_file on bundled scripts/references. */
  skillRoots?: string[];
  permissions?: PermissionsConfig;
  /** When true, skip network permission confirm prompts (e.g. forge run -y). */
  skipNetworkConfirm?: boolean;
  confirmNetwork?: (req: NetworkConfirmRequest) => Promise<boolean>;
  /** When true, skip software install/uninstall confirm prompts (e.g. forge run -y). */
  skipSoftwareConfirm?: boolean;
  confirmSoftware?: (req: SoftwareConfirmRequest) => Promise<boolean>;
  /** Gate run_command behind user confirmation; absent = run without asking. */
  confirmCommand?: (command: string) => Promise<boolean>;
  /** Run a focused subtask in an isolated nested agent; absent = subagents unavailable (depth cap). */
  spawnSubagent?: (task: string) => Promise<string>;
  /** Register resources that must be released when this agent run finishes. */
  onCleanup?: (cleanup: () => void) => void;
  toolResultMaxChars?: number;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<string>;

export class ToolRegistry {
  private handlers = new Map<string, ToolHandler>();
  private defs: ToolDefinition[] = [];

  register(def: ToolDefinition, handler: ToolHandler): void {
    this.handlers.set(def.name, handler);
    this.defs = [...this.defs.filter((d) => d.name !== def.name), def];
  }

  remove(name: string): boolean {
    const had = this.handlers.has(name);
    this.handlers.delete(name);
    this.defs = this.defs.filter((d) => d.name !== name);
    return had;
  }

  get definitions(): ToolDefinition[] {
    return this.defs;
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<string> {
    if (ctx.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const handler = this.handlers.get(call.name);
    if (!handler) {
      return JSON.stringify({ ok: false, error: `Unknown tool: ${call.name}` });
    }
    try {
      return await handler(call.arguments, ctx);
    } catch (e) {
      return JSON.stringify({
        ok: false,
        error: String(e),
        hint: "Fix arguments or try another approach",
      });
    }
  }
}

const PENDING_WRITE_HINT =
  "NOT on disk until the user confirms at end of turn (REPL: press y). Do NOT write_file/write_patch the same path again until applied; read_file still shows old content.";

/**
 * Per-path async mutex. Parallel sub-agents may write concurrently; same-path
 * read-modify-write must be atomic (different paths still run in parallel).
 */
const pathLocks = new Map<string, Promise<void>>();
function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pathLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  pathLocks.set(key, tail);
  void tail.finally(() => {
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  });
  return run;
}

function relPath(ctx: ToolContext, raw: string): string {
  return toWorkspaceRelativePath(ctx.guard, raw, {
    skillRoots: ctx.skillRoots,
    allowedRoots: ctx.guard.allowedRootsList,
  });
}

function resolveWritePath(ctx: ToolContext, raw: string): string {
  const rel = relPath(ctx, raw);
  return ctx.guard.resolveSafe(rel, "write");
}

const MAX_WRITE_GROWTH_RATIO = 1.8;
const MAX_WRITE_GROWTH_LINES = 800;

function lineCount(text: string): number {
  return text.length ? text.split("\n").length : 0;
}

function detectSuspiciousRewrite(
  previous: string,
  next: string,
): { ok: true } | { ok: false; error: string; hint: string } {
  if (!previous) return { ok: true };
  const prevLines = lineCount(previous);
  const nextLines = lineCount(next);
  const prevChars = previous.length;
  const nextChars = next.length;
  const ratio = prevLines > 0 ? nextLines / prevLines : 1;
  const grewTooMuch =
    nextLines > prevLines + MAX_WRITE_GROWTH_LINES &&
    ratio >= MAX_WRITE_GROWTH_RATIO;
  const duplicatedOldBody =
    nextChars > prevChars * 2.1 &&
    previous.length > 200 &&
    next.includes(previous.slice(0, Math.min(previous.length, 200)));
  if (!grewTooMuch && !duplicatedOldBody) {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      `Refusing suspicious full rewrite: ${prevLines} -> ${nextLines} lines.` +
      " File may be accidentally duplicated.",
    hint:
      "Use read_file to inspect current content, then prefer write_patch for targeted edits. " +
      "If full rewrite is intentional, regenerate clean content once and retry overwrite:true.",
  };
}

export function createBuiltinRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  const nodeReplSessions = new WeakMap<ToolContext, NodeReplSession>();

  reg.register(
    {
      name: "echo",
      description: "Echo a message (debug / test ReAct loop)",
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    async (args) =>
      JSON.stringify({ ok: true, echo: String(args.message ?? "") }),
  );

  reg.register(
    {
      name: "update_plan",
      description:
        "Maintain the user-visible task plan for multi-step work. Call FIRST with the full step list, then again after EACH step completes (update statuses; exactly one in_progress at a time). 3-7 short imperative items. Statuses: pending | in_progress | done.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "done"],
                },
              },
              required: ["text", "status"],
            },
          },
        },
        required: ["items"],
      },
    },
    async (args, ctx) => {
      const raw = Array.isArray(args.items) ? args.items : [];
      const items = raw
        .map((it) => ({
          text: String((it as { text?: unknown })?.text ?? "").trim(),
          status: (["in_progress", "done"].includes(
            String((it as { status?: unknown })?.status),
          )
            ? String((it as { status?: unknown }).status)
            : "pending") as "pending" | "in_progress" | "done",
        }))
        .filter((it) => it.text)
        .slice(0, 20);
      ctx.emit({ type: "plan_update", items });
      return JSON.stringify({ ok: true, count: items.length });
    },
  );

  reg.register(
    {
      name: "spawn_agent",
      description:
        "Delegate a self-contained research/generation subtask to an isolated, READ-ONLY sub-agent, then get back its produced content. The sub-agent can read_file/list_dir/grep but CANNOT write files or run commands — it returns its result (code, text, JSON) as text. Run several in parallel for INDEPENDENT units — prefer one whole file per sub-agent (it returns the complete file content, you write it verbatim) rather than fragments of one file, which won't share imports/types/signatures and won't compile. Then YOU write the file(s) and verify (run tests / build) — sub-agents cannot. Give each a complete, standalone instruction — it does not see this conversation, and cannot spawn further sub-agents.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Complete standalone instruction for the sub-agent.",
          },
        },
        required: ["task"],
      },
    },
    async (args, ctx) => {
      const task = String(args.task ?? "").trim();
      if (!task) {
        return JSON.stringify({ ok: false, error: "task is required" });
      }
      if (!ctx.spawnSubagent) {
        return JSON.stringify({
          ok: false,
          error:
            "子代理中不能再派发子代理（递归已被禁止）。请在本代理内直接完成该子任务。",
        });
      }
      const summary = await ctx.spawnSubagent(task);
      return JSON.stringify({ ok: true, summary });
    },
  );

  reg.register(
    {
      name: "list_dir",
      description: "List files and directories under a path",
      parameters: {
        type: "object",
        properties: { path: { type: "string", default: "." } },
      },
    },
    async (args, ctx) => {
      const items = await listDir(ctx.guard, String(args.path ?? "."));
      return JSON.stringify({ ok: true, items });
    },
  );

  reg.register(
    {
      name: "read_file",
      description: "Read file contents with line numbers",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
      },
    },
    async (args, ctx) => {
      const path = relPath(ctx, String(args.path));
      const offset = Number(args.offset ?? 1);
      const limit = Number(args.limit ?? 200);
      const content = await readFileLimited(ctx.guard, path, offset, limit);
      const abs = ctx.guard.resolveSafe(path, "read");
      const full = await readFile(abs, "utf-8");
      const totalLines = full.split("\n").length;
      return JSON.stringify({
        ok: true,
        content,
        path,
        totalLines,
        previewFromLine: offset,
        previewLineCount: content.split("\n").length,
        pendingNote:
          ctx.pendingPatches.has(path)
            ? "This file has unapplied pending patches; disk content may differ."
            : undefined,
      });
    },
  );

  reg.register(
    {
      name: "grep",
      description: "Search codebase with ripgrep",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          glob: { type: "string" },
        },
        required: ["pattern"],
      },
    },
    async (args, ctx) => {
      const result = await grepWorkspace(
        ctx.guard,
        String(args.pattern),
        args.glob ? String(args.glob) : undefined,
      );
      if (typeof result === "string") {
        return result;
      }
      return JSON.stringify({
        ok: true,
        matchCount: result.matchCount,
        matches: result.preview,
        raw: result.raw,
      });
    },
  );

  reg.register(
    {
      name: "write_file",
      description:
        "Write file content. New files: omit overwrite. Large refactors / after failed write_patch: read_file then write_file with overwrite:true. If rewrite guard blocks an intentional full rewrite, set overwrite_force:true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          overwrite: {
            type: "boolean",
            description: "If true, replace existing file entirely",
          },
          overwrite_force: {
            type: "boolean",
            description:
              "Dangerous override. Only with overwrite:true. Skips anti-duplication rewrite guard for intentional full rewrites.",
          },
        },
        required: ["path", "content"],
      },
    },
    async (args, ctx) => {
      const path = relPath(ctx, String(args.path));
      const content = String(args.content);
      const overwrite = Boolean(args.overwrite);
      const overwriteForce = Boolean(args.overwrite_force);
      if (ctx.pendingPatches.has(path) && !ctx.autoApply) {
        return JSON.stringify({
          ok: false,
          error: `Pending unapplied changes for ${path}. Wait for user confirm (y) before writing again.`,
          hint: PENDING_WRITE_HINT,
        });
      }
      // Whole read-modify-write is atomic per path: parallel sub-agents writing
      // the SAME file serialize here (different paths still run concurrently).
      return withPathLock(path, async () => {
        const abs = resolveWritePath(ctx, String(args.path));
        let exists = false;
        let previousContent = "";
        try {
          previousContent = await readFile(abs, "utf-8");
          exists = true;
        } catch {
          /* new file */
        }
        if (exists && !overwrite) {
          return JSON.stringify({
            ok: false,
            error: "File exists; use write_patch for small edits or overwrite:true for full rewrite",
          });
        }
        if (exists && overwrite) {
          const guardResult = detectSuspiciousRewrite(previousContent, content);
          if (!guardResult.ok && !overwriteForce) {
            return JSON.stringify({
              ok: false,
              error: guardResult.error,
              hint:
                `${guardResult.hint} To force intentional replacement, retry once with overwrite:true and overwrite_force:true.`,
            });
          }
        }
        const jsonCheck = validateJsonLikeWrite(path, content);
        if (!jsonCheck.ok) {
          return JSON.stringify({
            ok: false,
            error: jsonCheck.error,
            hint: jsonCheck.hint,
          });
        }
        const unifiedDiff =
          exists && overwrite
            ? buildReplaceFileDiff(path, previousContent, content)
            : buildCreateFileDiff(path, content);
        const dry = validateUnifiedPatch(ctx.guard, path, unifiedDiff);
        if (!dry.ok) {
          return JSON.stringify({ ok: false, error: dry.message });
        }
        ctx.pendingPatches.set(path, unifiedDiff);
        if (ctx.autoApply) {
          const r = await applyUnifiedPatch(ctx.guard, path, unifiedDiff);
          ctx.emit({ type: "patch_proposed", path, unifiedDiff, applied: r.ok });
          const hints = detectRunHints(ctx.guard.cwdPath, [path]);
          return JSON.stringify({
            ...r,
            run_hints: hints.hints,
            warning:
              overwriteForce && overwrite
                ? "overwrite_force enabled: skipped rewrite duplication guard."
                : undefined,
          });
        }
        ctx.emit({ type: "patch_proposed", path, unifiedDiff, applied: false });
        return JSON.stringify({
          ok: true,
          status: "pending_confirmation",
          path,
          hint: PENDING_WRITE_HINT,
          suggested_run: detectRunHints(ctx.guard.cwdPath, [path]).hints[0]?.command,
          warning:
            overwriteForce && overwrite
              ? "overwrite_force enabled: skipped rewrite duplication guard."
              : undefined,
        });
      });
    },
  );

  reg.register(
    {
      name: "write_patch",
      description:
        "Small edits only: unified diff with exact context lines from read_file. NEW files → write_file. Large changes / optimization → write_file overwrite:true. Must read_file immediately before patching.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          unified_diff: { type: "string" },
        },
        required: ["path", "unified_diff"],
      },
    },
    async (args, ctx) => {
      const path = relPath(ctx, String(args.path));
      const unifiedDiff = String(args.unified_diff);
      if (ctx.pendingPatches.has(path) && !ctx.autoApply) {
        return JSON.stringify({
          ok: false,
          error: `Pending unapplied changes for ${path}. Wait for user confirm before patching again.`,
          hint: PENDING_WRITE_HINT,
        });
      }
      resolveWritePath(ctx, String(args.path));
      // Atomic per-path validate → read → apply (see write_file).
      return withPathLock(path, async () => {
        const dry = validateUnifiedPatch(ctx.guard, path, unifiedDiff);
        if (!dry.ok) {
          const d = dry.diagnostic;
          return JSON.stringify({
            ok: false,
            error: dry.message,
            hint: d?.hint,
            line: d?.line,
            expected: d?.expected,
            actual: d?.actual,
          });
        }
        if (!dry.alreadyApplied) {
          try {
            const original = normalizeEol(
              await readFile(ctx.guard.resolveSafe(path), "utf-8"),
            );
            const patched = applySimplePatch(original, unifiedDiff);
            if (patched) {
              const jsonCheck = validateJsonLikeWrite(path, patched);
              if (!jsonCheck.ok) {
                return JSON.stringify({
                  ok: false,
                  error: jsonCheck.error,
                  hint: jsonCheck.hint,
                });
              }
            }
          } catch {
            /* new file via patch */
          }
        }
        ctx.pendingPatches.set(path, unifiedDiff);
        if (ctx.autoApply) {
          const r = await applyUnifiedPatch(ctx.guard, path, unifiedDiff);
          ctx.emit({ type: "patch_proposed", path, unifiedDiff, applied: r.ok });
          return JSON.stringify(r);
        }
        ctx.emit({ type: "patch_proposed", path, unifiedDiff, applied: false });
        return JSON.stringify({
          ok: true,
          status: "pending_confirmation",
          path,
          hint: PENDING_WRITE_HINT,
        });
      });
    },
  );

  reg.register(
    {
      name: "run_command",
      description:
        "Run a whitelisted command (no shell): python3 script.py, python3 -c 'code' (quote code if it contains ;), pytest, git status/diff/branch/log/fetch, npm test, etc.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    async (args, ctx) => {
      const command = normalizeCommandForWorkspace(
        ctx.guard,
        String(args.command).trim(),
      );
      if (ctx.confirmCommand) {
        const approved = await ctx.confirmCommand(command);
        if (!approved) {
          return JSON.stringify({
            ok: false,
            error: "用户拒绝执行该命令。",
            hint: "Do not retry; explain or propose an alternative instead.",
          });
        }
      }
      const parts = parseCommandLine(command);
      if (
        parts[0] === "git" &&
        (parts[1] === "diff" || parts[1] === "status") &&
        !(await isGitRepository(ctx.guard))
      ) {
        return JSON.stringify({
          ok: false,
          error:
            "Not a git repository. Use read_file to inspect files instead of git diff/status.",
        });
      }
      return runSafeShell(ctx.guard.cwdPath, command, 60_000, ctx.signal);
    },
  );

  reg.register(
    {
      name: "node_repl",
      description:
        "Execute computation-only JavaScript in an isolated persistent Node.js session. Variables survive across calls in the current agent run. Supports promises, console output, and an optional reset. It cannot access files, network, processes, modules, or commands; use the dedicated permissioned tools for those actions. Every evaluation requires explicit user approval.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript source to evaluate. The final expression is returned.",
          },
          timeout_ms: {
            type: "number",
            description: "Evaluation timeout in milliseconds (100-30000; default 10000).",
          },
          reset: {
            type: "boolean",
            description: "Reset the persistent session before evaluating code.",
          },
        },
        required: ["code"],
      },
    },
    async (args, ctx) => {
      const code = String(args.code ?? "");
      if (args.reset) {
        nodeReplSessions.get(ctx)?.dispose();
        nodeReplSessions.delete(ctx);
        if (!code.trim()) {
          return JSON.stringify({ ok: true, reset: true });
        }
      }
      if (!code.trim()) {
        return JSON.stringify({ ok: false, error: "code is required" });
      }
      if (!ctx.confirmCommand) {
        return JSON.stringify({
          ok: false,
          error: "node_repl 需要交互式用户确认，当前运行环境不可用。",
          hint: "Use a dedicated permissioned tool instead.",
        });
      }
      const preview = code.replace(/\s+/g, " ").trim().slice(0, 500);
      const approved = await ctx.confirmCommand(`node_repl ${preview}`);
      if (!approved) {
        return JSON.stringify({
          ok: false,
          error: "用户拒绝执行该 JavaScript。",
          hint: "Do not retry; explain or propose an alternative instead.",
        });
      }
      let session = nodeReplSessions.get(ctx);
      if (!session) {
        session = new NodeReplSession(ctx.guard.cwdPath, ctx.signal);
        nodeReplSessions.set(ctx, session);
        const ownedSession = session;
        ctx.onCleanup?.(() => {
          ownedSession.dispose();
          if (nodeReplSessions.get(ctx) === ownedSession) {
            nodeReplSessions.delete(ctx);
          }
        });
      }
      const result = await session.evaluate(code, args.timeout_ms);
      return JSON.stringify({ ...result, persistent: true });
    },
  );

  reg.register(
    {
      name: "move_file",
      description:
        "Move or rename a file within the workspace or allowed personal directories. For batch moves, present a plan and get user confirmation first.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["from", "to"],
      },
    },
    async (args, ctx) => {
      const from = resolveWritePath(ctx, String(args.from));
      const to = resolveWritePath(ctx, String(args.to));
      if (!existsSync(from)) {
        return JSON.stringify({ ok: false, error: `Source not found: ${from}` });
      }
      if (existsSync(to)) {
        return JSON.stringify({
          ok: false,
          error: `Destination already exists: ${to}`,
          hint: "Pick a different destination path or rename the existing file first.",
        });
      }
      await withPathLock(to, () => rename(from, to));
      return JSON.stringify({ ok: true, from, to, message: `Moved ${from} → ${to}` });
    },
  );

  reg.register(
    {
      name: "rename_file",
      description:
        "Rename a file in place (same directory). Equivalent to move_file with a new basename.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          new_name: { type: "string" },
        },
        required: ["path", "new_name"],
      },
    },
    async (args, ctx) => {
      const from = resolveWritePath(ctx, String(args.path));
      const newName = String(args.new_name).replace(/^[/\\]+/, "");
      if (!newName || newName.includes("/") || newName.includes("\\")) {
        return JSON.stringify({
          ok: false,
          error: "new_name must be a file name without path separators",
        });
      }
      const to = resolveWritePath(ctx, join(dirname(from), newName));
      if (!existsSync(from)) {
        return JSON.stringify({ ok: false, error: `Source not found: ${from}` });
      }
      if (existsSync(to)) {
        return JSON.stringify({
          ok: false,
          error: `Destination already exists: ${to}`,
        });
      }
      await withPathLock(to, () => rename(from, to));
      return JSON.stringify({ ok: true, from, to, message: `Renamed to ${newName}` });
    },
  );

  return reg;
}

export async function applyPendingPatch(
  guard: WorkspaceGuard,
  path: string,
  unifiedDiff: string,
): Promise<string> {
  const r = await withPathLock(path, () =>
    applyUnifiedPatch(guard, path, unifiedDiff),
  );
  return JSON.stringify(r);
}
