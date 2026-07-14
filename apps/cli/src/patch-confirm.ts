import type { Interface } from "node:readline";
import { createInterface } from "node:readline";
import {
  printPatchPreview,
  printPatchSummary,
  summarizeDiff,
} from "./diff-view.js";

export type PatchConfirmAnswer = "yes" | "no" | "view";

const EXPANDED_MAX_LINES = 200;

export function formatPatchConfirmPromptFor(
  path: string,
  unifiedDiff: string,
): string {
  const stats = summarizeDiff(unifiedDiff);
  const label = stats.isCreate
    ? `\x1b[32m新建文件\x1b[0m`
    : `\x1b[32m+${stats.additions}\x1b[0m \x1b[31m−${stats.deletions}\x1b[0m`;
  return `\n应用 \x1b[36m${path}\x1b[0m (${label})？ \x1b[2m[v] 展开  [y] 应用  [n] 跳过\x1b[0m `;
}

export function parsePatchConfirmAnswer(raw: string): PatchConfirmAnswer {
  const a = raw.trim().toLowerCase();
  if (a === "v" || a === "view" || a === "diff") return "view";
  if (a === "y" || a === "yes") return "yes";
  return "no";
}

export type ApplyAllChoice = "all" | "each" | "none";

export function askApplyAllPending(
  rl: Interface,
  paths: string[],
): Promise<ApplyAllChoice> {
  const preview = paths
    .slice(0, 4)
    .map((p) => `\x1b[36m${p}\x1b[0m`)
    .join(", ");
  const suffix = paths.length > 4 ? ` … +${paths.length - 4}` : "";
  return new Promise((resolve) => {
    rl.question(
      `\n\x1b[1m待应用 ${paths.length} 个文件:\x1b[0m ${preview}${suffix}\n` +
        `  \x1b[32mY\x1b[0m/回车 = 全部应用   \x1b[2mn\x1b[0m = 逐个确认   \x1b[2ms\x1b[0m = 全部跳过\n` +
        `请选择: `,
      (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === "n" || a === "each") resolve("each");
        else if (a === "s" || a === "skip" || a === "no") resolve("none");
        else resolve("all");
      },
    );
  });
}

export function askPatchConfirm(
  rl: Interface,
  item: { path: string; unifiedDiff: string },
): Promise<PatchConfirmAnswer> {
  return new Promise((resolve) => {
    rl.question(formatPatchConfirmPromptFor(item.path, item.unifiedDiff), (answer) => {
      resolve(parsePatchConfirmAnswer(answer));
    });
  });
}

export function askPatchConfirmOnce(
  item: { path: string; unifiedDiff: string },
): Promise<PatchConfirmAnswer> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(formatPatchConfirmPromptFor(item.path, item.unifiedDiff), (answer) => {
      rl.close();
      resolve(parsePatchConfirmAnswer(answer));
    });
  });
}

export function expandPatchPreview(item: {
  path: string;
  unifiedDiff: string;
}): void {
  printPatchPreview(item.path, item.unifiedDiff, { maxLines: EXPANDED_MAX_LINES });
}

export { printPatchSummary };
