import { describe, expect, it } from "vitest";
import { composeReadOnlyToolGate } from "./read-only-tools.js";

describe("composeReadOnlyToolGate", () => {
  const readOnly = { runtime: { provider: "forge", sandboxMode: "read-only" } };

  it("is a no-op for ordinary runs", () => {
    expect(composeReadOnlyToolGate({})).toBeUndefined();
    const inner = (name: string) => name !== "x";
    expect(composeReadOnlyToolGate({ runtime: { provider: "forge" } }, inner)).toBe(inner);
  });

  it("denies write, command and mutation tools for read-only runs", () => {
    const gate = composeReadOnlyToolGate(readOnly)!;
    for (const name of ["read_file", "list_dir", "grep", "web_search", "web_fetch"]) {
      expect(gate(name)).toBe(true);
    }
    for (const name of ["write_file", "write_patch", "run_command", "move_file", "rename_file", "node_repl", "software_install", "api_request", "download_file", "browser_click", "mcp__x__y"]) {
      expect(gate(name)).toBe(false);
    }
  });

  it("still applies the inner (talent) gate", () => {
    const gate = composeReadOnlyToolGate(readOnly, (name) => name !== "grep")!;
    expect(gate("read_file")).toBe(true);
    expect(gate("grep")).toBe(false);
  });
});
