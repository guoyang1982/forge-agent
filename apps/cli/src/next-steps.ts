import { detectRunHints, formatRunHintsBlock } from "@forge/workspace";
import { validateShellCommand, runSafeShell } from "@forge/tools";
import { existsSync, readdirSync } from "node:fs";

export function printNextSteps(cwd: string, changedPaths: string[]): void {
  const unique = [...new Set(changedPaths.map((p) => p.replace(/^\//, "")))];
  if (!unique.length) return;
  const result = detectRunHints(cwd, unique);
  console.log(formatRunHintsBlock(result, cwd));
}

export function loadPrimaryRunCommand(
  cwd: string,
  changedPaths: string[] = [],
): string | null {
  const hints = detectRunHints(cwd, changedPaths);
  if (hints.hints.length) return hints.hints[0].command;
  if (!existsSync(cwd)) return null;
  const py = readdirSync(cwd).find((e) => e.endsWith(".py"));
  if (py) return `python3 ${py}`;
  return null;
}

export async function runPrimaryHint(
  cwd: string,
  changedPaths: string[] = [],
): Promise<void> {
  const cmd = loadPrimaryRunCommand(cwd, changedPaths);
  if (!cmd) {
    console.log("\n\x1b[33m未检测到可运行命令。可先让 Agent 生成代码，或手动运行 python3 <文件>\x1b[0m\n");
    return;
  }
  const check = validateShellCommand(cmd);
  if (!check.ok) {
    console.log(`\n\x1b[33m无法运行:\x1b[0m ${check.error}\n`);
    return;
  }

  console.log(`\n\x1b[36m$ cd ${cwd} && ${cmd}\x1b[0m\n`);
  const raw = await runSafeShell(cwd, cmd, 120_000);
  const result = JSON.parse(raw) as {
    ok?: boolean;
    output?: string;
    error?: string;
  };
  if (result.output) process.stdout.write(result.output);
  if (!result.ok) {
    console.error(`\n\x1b[31m退出失败:\x1b[0m ${result.error ?? "non-zero exit"}\n`);
  }
}
