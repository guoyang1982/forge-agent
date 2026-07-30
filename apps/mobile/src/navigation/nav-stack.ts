export type NavTarget =
  | { kind: "workspace"; cwd: string }
  | { kind: "file"; cwd: string; path: string }
  | { kind: "diff"; cwd: string; path: string };

function isFileLike(
  target: NavTarget,
): target is Extract<NavTarget, { kind: "file" | "diff" }> {
  return target.kind === "file" || target.kind === "diff";
}

export function navTargetsEqual(a: NavTarget, b: NavTarget): boolean {
  if (a.kind !== b.kind || a.cwd !== b.cwd) return false;
  if (a.kind === "workspace" || b.kind === "workspace") return true;
  return a.path === b.path;
}

/** Same filesystem path — file and diff views are one document. */
export function sameNavDocument(a: NavTarget, b: NavTarget): boolean {
  return isFileLike(a) && isFileLike(b) && a.cwd === b.cwd && a.path === b.path;
}

/**
 * Push navigation without deepening uselessly:
 * - exact duplicate of top → no-op
 * - file ↔ diff for the same path → replace top (tab switch)
 * - another file/diff while already viewing one → replace top
 * - target already in stack → jump back to that entry
 * - otherwise append
 */
export function reduceNavStack(stack: NavTarget[], target: NavTarget): NavTarget[] {
  const top = stack[stack.length - 1];
  if (top && navTargetsEqual(top, target)) return stack;

  if (top && sameNavDocument(top, target)) {
    return [...stack.slice(0, -1), target];
  }

  if (top && isFileLike(top) && isFileLike(target)) {
    return [...stack.slice(0, -1), target];
  }

  const existingExact = stack.findIndex((item) => navTargetsEqual(item, target));
  if (existingExact >= 0) return stack.slice(0, existingExact + 1);

  if (target.kind === "workspace") {
    const existingWorkspace = stack.findIndex(
      (item) => item.kind === "workspace" && item.cwd === target.cwd,
    );
    if (existingWorkspace >= 0) return stack.slice(0, existingWorkspace + 1);
  }

  const existingDocument = isFileLike(target)
    ? stack.findIndex((item) => sameNavDocument(item, target))
    : -1;
  if (existingDocument >= 0) {
    return [...stack.slice(0, existingDocument), target];
  }

  return [...stack, target];
}

/** One-tap escape from a deep stack: workspace if present, else clear. */
export function popNavToRoot(stack: NavTarget[]): NavTarget[] {
  const workspace = stack.find((item) => item.kind === "workspace");
  return workspace ? [workspace] : [];
}
