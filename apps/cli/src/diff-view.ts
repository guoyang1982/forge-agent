import { createFileFromPatch } from "@forge/workspace";
import { patchFoldedHintLine } from "./commands-hint.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

const DEFAULT_MAX_LINES = 72;

export interface DiffPreviewOptions {
  maxLines?: number;
  applied?: boolean;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  hunks: number;
  isCreate: boolean;
}

/** One-line collapsed summary (default when patch is proposed). */
export function printPatchSummary(
  path: string,
  unifiedDiff: string,
  options?: { applied?: boolean },
): void {
  const stats = summarizeDiff(unifiedDiff);
  const status = options?.applied ? DIM + " (已自动应用)" : "";

  if (stats.isCreate) {
    const content = createFileFromPatch(unifiedDiff);
    const n = content?.split("\n").length ?? stats.additions;
    console.log(
      `\n📝 ${CYAN}${path}${RESET} ${GREEN}新建 ${n} 行${RESET}${status}${RESET}`,
    );
    if (!options?.applied) console.log(patchFoldedHintLine());
    return;
  }

  const label =
    stats.additions || stats.deletions
      ? `${GREEN}+${stats.additions}${RESET} ${RED}−${stats.deletions}${RESET}`
      : DIM + "无行变更";
  console.log(`\n📝 ${CYAN}${path}${RESET} ${label}${status}${RESET}`);
  if (!options?.applied) console.log(patchFoldedHintLine());
}

export function summarizeDiff(unifiedDiff: string): DiffStats {
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("@@")) hunks++;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  const isCreate =
    unifiedDiff.includes("--- /dev/null") ||
    /@@ -0,0 \+\d+,\d+ @@/.test(unifiedDiff);
  return { additions, deletions, hunks, isCreate };
}

/** Colored diff / new-file preview for terminal (Cursor/Codex-style). */
export function printPatchPreview(
  path: string,
  unifiedDiff: string,
  options?: DiffPreviewOptions,
): void {
  const max = options?.maxLines ?? DEFAULT_MAX_LINES;
  const stats = summarizeDiff(unifiedDiff);
  const status = options?.applied ? DIM + " (已自动应用)" : "";

  if (stats.isCreate) {
    printNewFilePreview(path, unifiedDiff, stats, status, max);
    return;
  }

  const label =
    stats.additions || stats.deletions
      ? `${GREEN}+${stats.additions}${RESET} ${RED}−${stats.deletions}${RESET}`
      : "";
  console.log(
    `\n${CYAN}── 修改预览: ${path}${RESET} ${label}${status}${RESET}`,
  );
  printColoredDiffBody(unifiedDiff, max);
  console.log(patchFoldedHintLine());
  console.log("");
}

function printNewFilePreview(
  path: string,
  unifiedDiff: string,
  stats: DiffStats,
  status: string,
  max: number,
): void {
  const content = createFileFromPatch(unifiedDiff);
  const lineCount = content?.split("\n").length ?? stats.additions;
  console.log(
    `\n${CYAN}── 新建文件: ${path}${RESET} ${GREEN}${lineCount} 行${RESET}${status}${RESET}`,
  );
  if (!content) {
    printColoredDiffBody(unifiedDiff, max);
    console.log("");
    return;
  }
  const lines = content.split("\n");
  const show = Math.min(lines.length, max);
  for (let i = 0; i < show; i++) {
    const n = String(i + 1).padStart(4, " ");
    console.log(`${DIM}${n}│${RESET} ${lines[i]}`);
  }
  if (lines.length > show) {
    console.log(
      `${DIM}     … ${lines.length - show} more lines (${lines.length} total)${RESET}`,
    );
  }
  console.log("");
}

function printColoredDiffBody(unifiedDiff: string, maxLines: number): void {
  const raw = unifiedDiff.split("\n");
  const body: string[] = [];
  for (const line of raw) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      body.push(`${DIM}${line}${RESET}`);
      continue;
    }
    if (!line.startsWith("@@") && body.length === 0 && !line.trim()) continue;
    body.push(colorDiffLine(line));
  }

  const show = Math.min(body.length, maxLines);
  for (let i = 0; i < show; i++) {
    console.log(`  ${body[i]}`);
  }
  if (body.length > show) {
    console.log(
      `${DIM}  … ${body.length - show} more diff lines (confirm to apply full patch)${RESET}`,
    );
  }
}

function colorDiffLine(line: string): string {
  if (line.startsWith("@@")) {
    return `${CYAN}${line}${RESET}`;
  }
  if (line.startsWith("+")) {
    return `${GREEN}+${line.slice(1)}${RESET}`;
  }
  if (line.startsWith("-")) {
    return `${RED}−${line.slice(1)}${RESET}`;
  }
  if (line.startsWith(" ")) {
    return `${DIM} ${line.slice(1)}${RESET}`;
  }
  return line;
}
