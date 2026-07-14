import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeCompatibilityFromDir } from "./compatibility.js";

function packageWithSkill(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hub-compat-"));
  mkdirSync(join(dir, "skills", "example"), { recursive: true });
  writeFileSync(join(dir, "skills", "example", "SKILL.md"), text);
  return dir;
}

describe("analyzeCompatibilityFromDir", () => {
  it("marks Codex browser runtime skills as Codex-only", async () => {
    const result = await analyzeCompatibilityFromDir(
      packageWithSkill("Use mcp__node_repl__js and agent.browsers.list()."),
    );

    expect(result.codex.status).toBe("compatible");
    expect(result.forge).toMatchObject({ status: "incompatible" });
    expect(result.cursor).toMatchObject({ status: "incompatible" });
    expect(result["claude-code"].requirements).toContain("Codex Node REPL / browser runtime");
  });

  it("recognizes Cursor and Claude Code private runtime markers", async () => {
    const result = await analyzeCompatibilityFromDir(
      packageWithSkill("Call vscode.commands.executeCommand then parse $ARGUMENTS."),
    );

    expect(result.cursor.status).toBe("incompatible");
    expect(result["claude-code"].status).toBe("incompatible");
    expect(result.codex.status).toBe("incompatible");
  });

  it("marks standard MCP packages as adaptable rather than host-specific", async () => {
    const dir = packageWithSkill("Use the configured MCP tool.");
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: { database: { command: "node", args: ["server.js"] } },
    }));

    const result = await analyzeCompatibilityFromDir(dir);
    expect(result.forge.status).toBe("adaptable");
    expect(result.codex.status).toBe("adaptable");
  });
});
