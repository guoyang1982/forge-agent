import { describe, expect, it } from "vitest";
import {
  popNavToRoot,
  reduceNavStack,
  type NavTarget,
} from "./nav-stack";

const workspace = (cwd = "/repo"): NavTarget => ({ kind: "workspace", cwd });
const file = (path: string, cwd = "/repo"): NavTarget => ({ kind: "file", cwd, path });
const diff = (path: string, cwd = "/repo"): NavTarget => ({ kind: "diff", cwd, path });

describe("reduceNavStack", () => {
  it("appends the first target", () => {
    expect(reduceNavStack([], workspace())).toEqual([workspace()]);
  });

  it("no-ops when pushing the exact top again", () => {
    const stack = [workspace(), file("a.ts")];
    expect(reduceNavStack(stack, file("a.ts"))).toBe(stack);
  });

  it("replaces top when switching file ↔ diff for the same path", () => {
    expect(reduceNavStack([workspace(), file("a.ts")], diff("a.ts"))).toEqual([
      workspace(),
      diff("a.ts"),
    ]);
    expect(reduceNavStack([workspace(), diff("a.ts")], file("a.ts"))).toEqual([
      workspace(),
      file("a.ts"),
    ]);
  });

  it("does not stack file→diff→file→diff for the same path", () => {
    let stack: NavTarget[] = [workspace()];
    stack = reduceNavStack(stack, file("a.ts"));
    stack = reduceNavStack(stack, diff("a.ts"));
    stack = reduceNavStack(stack, file("a.ts"));
    stack = reduceNavStack(stack, diff("a.ts"));
    expect(stack).toEqual([workspace(), diff("a.ts")]);
  });

  it("replaces the current file/diff when opening another path", () => {
    expect(reduceNavStack([workspace(), file("a.ts")], file("b.ts"))).toEqual([
      workspace(),
      file("b.ts"),
    ]);
    expect(reduceNavStack([workspace(), diff("a.ts")], file("b.ts"))).toEqual([
      workspace(),
      file("b.ts"),
    ]);
  });

  it("jumps back when re-opening an existing workspace", () => {
    expect(reduceNavStack([workspace(), file("a.ts")], workspace())).toEqual([
      workspace(),
    ]);
  });

  it("keeps conversation-rooted diffs shallow", () => {
    let stack: NavTarget[] = [];
    stack = reduceNavStack(stack, diff("a.ts"));
    stack = reduceNavStack(stack, file("a.ts"));
    stack = reduceNavStack(stack, diff("a.ts"));
    expect(stack).toEqual([diff("a.ts")]);
  });
});

describe("popNavToRoot", () => {
  it("returns the workspace entry when present", () => {
    expect(popNavToRoot([workspace(), file("a.ts"), diff("a.ts")])).toEqual([
      workspace(),
    ]);
  });

  it("clears conversation-only stacks", () => {
    expect(popNavToRoot([diff("a.ts")])).toEqual([]);
  });
});
