import type {
  AgentEvent,
  ProgressDisplayMode,
  ThinkingDisplayMode,
} from "@forge/protocol";
import { ThinkingDisplay } from "./thinking-display.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

function formatToolArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  if (typeof a.path === "string") return dim(a.path);
  if (typeof a.pattern === "string") return dim(`"${a.pattern}"`);
  if (typeof a.command === "string") {
    const cmd = String(a.command);
    return dim(cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd);
  }
  return "";
}

function summarizeToolResult(
  name: string,
  result: string,
): { text: string; failed: boolean } {
  try {
    const j = JSON.parse(result) as Record<string, unknown>;
    if (j.ok === false) {
      let msg = String(j.error ?? "failed");
      if (j.line != null) msg += ` @L${j.line}`;
      if (j.expected != null && j.actual != null) {
        msg += ` (expected "${j.expected}" got "${j.actual}")`;
      } else if (typeof j.hint === "string" && j.hint.length < 80) {
        msg += ` — ${j.hint}`;
      }
      return { text: red(msg), failed: true };
    }
    if (typeof j.path === "string") return { text: dim(j.path), failed: false };
    if (name === "list_dir" && Array.isArray(j.items)) {
      return { text: dim(`${j.items.length} entries`), failed: false };
    }
    if (name === "read_file" && typeof j.content === "string") {
      const preview = j.content.split("\n").length;
      const total =
        typeof j.totalLines === "number" ? j.totalLines : preview;
      const label =
        total > preview
          ? `${preview} lines shown / ${total} total`
          : `${total} lines`;
      return { text: dim(label), failed: false };
    }
    if (name === "grep") {
      if (typeof j.matchCount === "number") {
        const label =
          j.matchCount === 0
            ? "no matches"
            : `${j.matchCount} match${j.matchCount === 1 ? "" : "es"}`;
        return { text: dim(label), failed: false };
      }
      if (Array.isArray(j.matches)) {
        return { text: dim(`${j.matches.length} matches`), failed: false };
      }
    }
    if (name === "write_file" || name === "write_patch") {
      if (j.status === "pending_confirmation") {
        return { text: yellow("pending confirm"), failed: false };
      }
      if (j.ok) return { text: green("ok"), failed: false };
    }
    if (name === "memory_search" && Array.isArray(j.results)) {
      return { text: dim(`${j.results.length} hits`), failed: false };
    }
  } catch {
    /* not json */
  }
  return { text: "", failed: false };
}

/** In-place status on stderr so stdout streaming stays clean. */
function writeStatusLine(text: string): void {
  process.stderr.write(`\r\x1b[2K${text}`);
}

function clearStatusLine(): void {
  process.stderr.write("\r\x1b[2K");
}

/** Short label for the single in-place progress line on stderr. */
function briefStatusLabel(message: string): string {
  const body = message.replace(/^Step \d+\/\d+:\s*/i, "").trim();
  if (/^[\w-]+ \d/.test(body) || /^[\w-]+…$/.test(body)) {
    return body;
  }
  const tool = body.match(/生成\s+(\S+)\s+参数\s*(\([^)]+\))?/);
  if (tool) {
    const size = tool[2]?.replace(/[()]/g, "") ?? "";
    return size ? `${tool[1]} ${size}` : `${tool[1]}…`;
  }
  if (/等待|处理中/.test(body)) return "处理中…";
  if (/连接/.test(body)) return "连接…";
  return body.length > 48 ? `${body.slice(0, 45)}…` : body;
}

export interface ProgressReporter {
  handle(event: AgentEvent): string | void;
  finish(): void;
}

export function createProgressReporter(options?: {
  quietSession?: boolean;
  thinking?: ThinkingDisplayMode;
  progress?: ProgressDisplayMode;
}): ProgressReporter {
  const runStarted = Date.now();
  let currentStep = 0;
  let maxSteps = 0;
  let sawText = false;
  const progressMode = options?.progress ?? "compact";
  const thinkingUi = new ThinkingDisplay(options?.thinking ?? "collapse");

  const handle = (event: AgentEvent): string | void => {
    switch (event.type) {
      case "hooks_applied": {
        clearStatusLine();
        console.log(
          dim(
            `  ◆ Hook 已注入: ${event.sources.join(", ")} (${event.chars} 字)`,
          ),
        );
        return;
      }

      case "skill_active": {
        clearStatusLine();
        if (
          (event.matchMode === "explicit" || event.matchMode === "implicit") &&
          event.matched &&
          event.skillName
        ) {
          const id = event.skillId ? dim(` (${event.skillId})`) : "";
          const via =
            event.matchMode === "implicit" ? " · 触发词匹配" : "";
          console.log(
            dim(
              `  ◆ 预加载 Skill: ${event.skillName}${id}${via}（Skill 目录共 ${event.loadedCount} 个）`,
            ),
          );
        } else {
          console.log(
            dim(
              `  ◆ Skill 目录 ${event.loadedCount} 个（未预加载，模型按需读取）`,
            ),
          );
        }
        return;
      }

      case "skill_used": {
        clearStatusLine();
        console.log(
          dim(
            `  ◆ 模型加载 Skill: ${event.skillName} (${event.skillId})`,
          ),
        );
        return;
      }

      case "step_start":
        currentStep = event.step;
        maxSteps = event.maxSteps;
        sawText = false;
        thinkingUi.reset();
        clearStatusLine();
        if (progressMode === "verbose") {
          if (event.step > 1) {
            process.stderr.write(
              dim(`\n── step ${event.step}/${event.maxSteps} ──\n`),
            );
          } else {
            process.stderr.write(dim(`\n── step 1/${event.maxSteps} ──\n`));
          }
        }
        return;

      case "status": {
        const elapsed =
          event.elapsedSec != null && event.elapsedSec > 0
            ? dim(` · ${event.elapsedSec}s`)
            : "";
        const label = briefStatusLabel(event.message);
        const stepTag =
          currentStep > 0 && maxSteps > 0
            ? `[${currentStep}/${maxSteps}] `
            : "";
        const icon = event.phase === "model" ? "◇" : "◎";
        writeStatusLine(dim(`  ${icon} ${stepTag}${label}${elapsed}`));
        return;
      }

      case "thinking_start":
        clearStatusLine();
        thinkingUi.start();
        return;

      case "thinking_delta":
        thinkingUi.delta(event.delta);
        return;

      case "thinking_end":
        thinkingUi.end(event.durationMs);
        return;

      case "text_delta":
        if (!sawText) {
          sawText = true;
          clearStatusLine();
          process.stdout.write("\n");
        }
        process.stdout.write(event.delta);
        return;

      case "tool_start": {
        clearStatusLine();
        const step =
          event.step != null ? dim(` [${event.step}/${maxSteps || "?"}]`) : "";
        const detail = formatToolArgs(event.name, event.args);
        const suffix = detail ? ` ${detail}` : "";
        console.log(`\n⏺ ${event.name}${step}${suffix}`);
        return;
      }

      case "tool_end": {
        clearStatusLine();
        const ms = event.durationMs ?? 0;
        const { text: summary, failed } = summarizeToolResult(
          event.name,
          event.result,
        );
        const tail = summary ? ` — ${summary}` : "";
        const mark = failed ? "✖" : "✓";
        console.log(
          `  ${mark} ${event.name} ${dim(`(${formatDuration(ms)})`)}${tail}`,
        );
        return;
      }

      case "warning":
        clearStatusLine();
        console.log(`\n\x1b[33m⚠ ${event.message}\x1b[0m`);
        if (event.message.includes("最大步数")) {
          console.log(
            `\x1b[2m  提示：本轮结果已保存，可直接输入续聊指令继续同一 session。\x1b[0m`,
          );
        }
        return;

      case "error":
        clearStatusLine();
        console.error(`\n✖ ${event.message}`);
        return;

      case "done":
        clearStatusLine();
        if (!options?.quietSession) {
          return event.sessionId;
        }
        return event.sessionId;

      default:
        return;
    }
  };

  const finish = () => {
    clearStatusLine();
    const total = formatDuration(Date.now() - runStarted);
    const stepInfo =
      currentStep > 0 ? ` · ${currentStep} step${currentStep > 1 ? "s" : ""}` : "";
    process.stderr.write(dim(`\n── done (${total}${stepInfo}) ──\n`));
  };

  return { handle, finish };
}
