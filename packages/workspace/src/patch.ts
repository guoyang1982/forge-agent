import { readFileSync } from "node:fs";

const FUZZ_WINDOW = 50;

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export interface PatchDiagnostic {
  message: string;
  line?: number;
  expected?: string;
  actual?: string;
  hint: string;
}

export function diagnosePatchFailure(
  original: string,
  diff: string,
): PatchDiagnostic {
  const lines = normalizeEol(original).split("\n");
  const diffLines = diff.split("\n");
  let i = 0;
  let lineNo = 0;

  while (i < diffLines.length) {
    const hunk = diffLines[i];
    if (!hunk.startsWith("@@")) {
      i++;
      continue;
    }
    const match = hunk.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (!match) {
      return {
        message: "Invalid hunk header (expected @@ -N,M +N,M @@)",
        hint: "Regenerate patch after read_file; hunk line numbers must match file.",
      };
    }
    lineNo = parseInt(match[1], 10) - 1;
    i++;
    while (i < diffLines.length && !diffLines[i].startsWith("@@")) {
      const dl = diffLines[i];
      if (dl.startsWith("---") || dl.startsWith("+++")) {
        i++;
        continue;
      }
      if (dl.startsWith("-") || dl.startsWith(" ")) {
        const expected = dl.slice(1);
        const actual = lines[lineNo];
        if (actual !== expected) {
          const near = findLineNear(lines, expected, lineNo);
          const extra =
            near != null
              ? ` (same text found at line ${near + 1} — fix @@ line number)`
              : "";
          return {
            message: `Context mismatch at line ${lineNo + 1}${extra}`,
            line: lineNo + 1,
            expected: truncatePreview(expected),
            actual: truncatePreview(actual),
            hint:
              "Call read_file on this path immediately before write_patch. " +
              "Every ' ' and '-' line must match the file exactly (spaces, quotes). " +
              "For large edits use write_file with overwrite:true instead of write_patch.",
          };
        }
        if (dl.startsWith("-")) lines.splice(lineNo, 1);
        else lineNo++;
      } else if (dl.startsWith("+")) {
        lineNo++;
      }
      i++;
    }
  }

  return {
    message: "Patch does not apply cleanly (dry-run)",
    hint: "read_file then rewrite patch, or use write_file overwrite:true.",
  };
}

function truncatePreview(s: string | undefined, max = 72): string {
  if (s === undefined) return "(end of file)";
  const one = s.replace(/\t/g, "→");
  return one.length > max ? one.slice(0, max) + "…" : one;
}

function findLineNear(
  lines: string[],
  target: string,
  near: number,
): number | null {
  const start = Math.max(0, near - FUZZ_WINDOW);
  const end = Math.min(lines.length, near + FUZZ_WINDOW);
  for (let i = start; i < end; i++) {
    if (lines[i] === target) return i;
  }
  return null;
}

/**
 * Unified diff applier, git-style: each hunk's old block (context + deletions)
 * is matched as a whole, at the declared line first, then at the nearest offset
 * in either direction. Per-line fuzz is deliberately avoided — repeated lines
 * (blank lines, `else:` …) used to drag the cursor to the wrong spot, failing
 * patches whose @@ numbers were merely shifted.
 */
export function applySimplePatch(
  original: string,
  diff: string,
): string | null {
  const lines = normalizeEol(original).split("\n");
  const diffLines = diff.split("\n");
  while (diffLines.length && diffLines[diffLines.length - 1] === "") {
    diffLines.pop();
  }

  type Hunk = { oldStart: number; ops: string[] };
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const dl of diffLines) {
    if (dl.startsWith("@@")) {
      const m = dl.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (!m) return null;
      cur = { oldStart: parseInt(m[1], 10) - 1, ops: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur || dl.startsWith("---") || dl.startsWith("+++")) continue;
    // Some generators emit bare empty lines for empty context.
    const op = dl === "" ? " " : dl;
    if (op.startsWith("+") || op.startsWith("-") || op.startsWith(" ")) {
      cur.ops.push(op);
    }
  }
  if (!hunks.length) return null;

  let offset = 0;
  for (const h of hunks) {
    const oldBlock = h.ops
      .filter((op) => !op.startsWith("+"))
      .map((op) => op.slice(1));
    const newBlock = h.ops
      .filter((op) => !op.startsWith("-"))
      .map((op) => op.slice(1));
    const at = findBlockNear(lines, oldBlock, h.oldStart + offset);
    if (at === null) return null;
    lines.splice(at, oldBlock.length, ...newBlock);
    offset += newBlock.length - oldBlock.length;
  }
  return lines.join("\n");
}

/** Locate a hunk's old block: declared position first, then nearest offset. */
function findBlockNear(
  lines: string[],
  block: string[],
  anchor: number,
): number | null {
  const clamp = (n: number) => Math.max(0, Math.min(n, lines.length));
  if (!block.length) return clamp(anchor); // pure-insertion hunk
  const matchesAt = (pos: number) => {
    if (pos < 0 || pos + block.length > lines.length) return false;
    for (let k = 0; k < block.length; k++) {
      if (lines[pos + k] !== block[k]) return false;
    }
    return true;
  };
  const start = clamp(anchor);
  if (matchesAt(start)) return start;
  for (let d = 1; d <= lines.length; d++) {
    if (matchesAt(start + d)) return start + d;
    if (matchesAt(start - d)) return start - d;
  }
  return null;
}

/** Diff that creates a new file (--- /dev/null). */
export function buildCreateFileDiff(path: string, content: string): string {
  const lines = content.split("\n");
  return [
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join("\n");
}

/** Full replace diff for overwrite — deletes all old lines, adds new (avoids append-on-overwrite bug). */
export function buildReplaceFileDiff(
  path: string,
  previous: string,
  content: string,
): string {
  if (!previous) return buildCreateFileDiff(path, content);
  const oldLines = normalizeEol(previous).split("\n");
  const newLines = content.split("\n");
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ].join("\n");
}

export function createFileFromPatch(diff: string): string | null {
  const lines = diff.split("\n");
  const out: string[] = [];
  let inHunk = false;
  let sawAdd = false;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      out.push(line.slice(1));
      sawAdd = true;
      continue;
    }
    if (line.startsWith(" ")) {
      out.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) return null;
  }

  if (!sawAdd) return null;
  return out.join("\n");
}

/** True when diff hunks are already reflected on disk (stale pending patch). */
export function isEffectivelyApplied(original: string, diff: string): boolean {
  const lines = normalizeEol(original).split("\n");
  let sawChange = false;
  for (const raw of diff.split("\n")) {
    if (
      raw.startsWith("---") ||
      raw.startsWith("+++") ||
      raw.startsWith("@@")
    ) {
      continue;
    }
    if (raw.startsWith("-")) {
      sawChange = true;
      if (lines.includes(raw.slice(1))) return false;
    } else if (raw.startsWith("+")) {
      sawChange = true;
      if (!lines.includes(raw.slice(1))) return false;
    }
  }
  return sawChange;
}

export function readWorkspaceFileSync(abs: string): string | null {
  try {
    return normalizeEol(readFileSync(abs, "utf-8"));
  } catch {
    return null;
  }
}
