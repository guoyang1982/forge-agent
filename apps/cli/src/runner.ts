import type { Interface } from "node:readline";
import type {
  AgentEvent,
  ProgressDisplayMode,
  RunRequest,
  SessionHookSource,
  ThinkingDisplayMode,
} from "@forge/protocol";
import { DAEMON_METHODS } from "@forge/protocol";
import { connectDaemon } from "@forge/bus";
import { createProgressReporter } from "./progress.js";
import { printPatchSummary } from "./diff-view.js";
import {
  expandPatchPreview,
  askApplyAllPending,
  type ApplyAllChoice,
  type PatchConfirmAnswer,
} from "./patch-confirm.js";
import { printPatchConfirmHints } from "./commands-hint.js";

export type ForgeClient = Awaited<ReturnType<typeof connectDaemon>>;

export interface RunTaskOptions {
  cwd: string;
  message: string;
  sessionId?: string | null;
  hookSource?: SessionHookSource;
  autoApply?: boolean;
  files?: string[];
  runtime?: RunRequest["runtime"];
  json?: boolean;
  onEvent?: (event: AgentEvent) => void;
  onRunStarted?: (runId: string) => void;
}

export interface RunTaskResult {
  sessionId: string;
  finalText: string;
  runId: string;
}

export async function executeRun(
  client: ForgeClient,
  opts: RunTaskOptions,
): Promise<RunTaskResult> {
  const result = (await client.request(
    DAEMON_METHODS.RUN,
    {
      cwd: opts.cwd,
      message: opts.message,
      sessionId: opts.sessionId ?? null,
      hookSource: opts.hookSource,
      runtime: opts.runtime,
      autoApply: opts.autoApply,
      files: opts.files,
    },
    opts.onEvent,
  )) as { sessionId: string; finalText: string };
  opts.onRunStarted?.(result.sessionId);
  return {
    sessionId: result.sessionId,
    finalText: result.finalText,
    runId: result.sessionId,
  };
}

async function applyOnePatch(
  client: ForgeClient,
  cwd: string,
  p: { path: string; unifiedDiff: string },
): Promise<boolean> {
  const result = (await client.request(DAEMON_METHODS.APPLY_PATCH, {
    cwd,
    path: p.path,
    unifiedDiff: p.unifiedDiff,
  })) as ApplyPatchResult;

  if (result?.ok) {
    if (result.alreadyApplied) {
      console.log(`\x1b[33m无需应用\x1b[0m ${p.path} — ${result.message}`);
    } else {
      console.log(`\x1b[32m已应用\x1b[0m ${p.path}`);
    }
    return true;
  }
  printApplyPatchFailure(p.path, result);
  return false;
}

export async function applyPendingPatches(
  client: ForgeClient,
  cwd: string,
  pending: Array<{ path: string; unifiedDiff: string }>,
  autoApply: boolean,
  confirm: (item: {
    path: string;
    unifiedDiff: string;
  }) => Promise<PatchConfirmAnswer>,
  rl?: Interface,
): Promise<string[]> {
  const applied: string[] = [];
  if (!pending.length || autoApply) return applied;
  printPatchConfirmHints();

  let mode: ApplyAllChoice = pending.length === 1 ? "each" : "each";
  if (pending.length > 1 && rl) {
    mode = await askApplyAllPending(
      rl,
      pending.map((p) => p.path),
    );
  }

  if (mode === "none") {
    console.log("\x1b[2m已跳过全部待应用修改\x1b[0m\n");
    return applied;
  }

  if (mode === "all") {
    for (const p of pending) {
      if (await applyOnePatch(client, cwd, p)) applied.push(p.path);
    }
    return applied;
  }

  for (const p of pending) {
    let answer: PatchConfirmAnswer;
    do {
      answer = await confirm(p);
      if (answer === "view") expandPatchPreview(p);
    } while (answer === "view");

    if (answer === "yes" && (await applyOnePatch(client, cwd, p))) {
      applied.push(p.path);
    }
  }
  return applied;
}

export function createEventPrinter(
  pending: Array<{ path: string; unifiedDiff: string }>,
  options?: {
    quietSession?: boolean;
    appliedPaths?: string[];
    thinking?: ThinkingDisplayMode;
    progress?: ProgressDisplayMode;
  },
) {
  const progress = createProgressReporter({
    quietSession: options?.quietSession,
    thinking: options?.thinking,
    progress: options?.progress,
  });

  const handlePatch = (event: Extract<AgentEvent, { type: "patch_proposed" }>) => {
    if (event.applied) {
      options?.appliedPaths?.push(event.path);
    } else {
      const entry = { path: event.path, unifiedDiff: event.unifiedDiff };
      const idx = pending.findIndex((x) => x.path === event.path);
      if (idx >= 0) {
        pending[idx] = entry;
        console.log("\x1b[2m  (已更新该文件的待确认 patch)\x1b[0m");
      } else {
        pending.push(entry);
      }
    }
    printPatchSummary(event.path, event.unifiedDiff, {
      applied: event.applied,
    });
  };

  return (event: AgentEvent): string | void => {
    if (event.type === "patch_proposed") {
      handlePatch(event);
      return;
    }
    const sid = progress.handle(event);
    if (event.type === "done") progress.finish();
    return sid;
  };
}

interface ApplyPatchResult {
  ok?: boolean;
  message?: string;
  alreadyApplied?: boolean;
  line?: number;
  expected?: string;
  actual?: string;
  hint?: string;
}

function printApplyPatchFailure(path: string, result: ApplyPatchResult): void {
  console.error(`\n\x1b[31m✖ 无法应用\x1b[0m ${path}`);
  console.error(`  ${result.message ?? "unknown error"}`);
  if (result.line != null) {
    console.error(
      `  行 ${result.line}: 期望 \x1b[2m${result.expected ?? "?"}\x1b[0m`,
    );
    console.error(`        实际 \x1b[2m${result.actual ?? "?"}\x1b[0m`);
  }
  if (result.hint) {
    console.error(`  \x1b[2m${result.hint}\x1b[0m`);
  }
  console.error(
    "\x1b[2m  常见原因：Agent 运行中已改过该文件，待确认的 patch 过期。" +
      "可跳过 (n)，或让 Agent 重新 read_file 后再改。\x1b[0m\n",
  );
}

export function printRunError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("\n✖ 任务失败:\n" + msg);
  if (msg.includes("quota") || msg.includes("429")) {
    console.error(
      "\n提示: 检查 ~/.forge-agent/config.json 中的 baseUrl / apiKey / 额度",
    );
  }
}
