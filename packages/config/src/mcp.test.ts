import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpServers } from "./mcp.js";

describe("loadMcpServers", () => {
  it("returns empty when mcp.json is missing (built-in file tools used)", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mcp-"));
    expect(loadMcpServers(dir, "/any/cwd")).toEqual([]);
  });

  it("loads servers from mcp.json when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mcp-"));
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        servers: [{ name: "custom", command: "echo", args: [], enabled: true }],
      }),
    );
    const servers = loadMcpServers(dir);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("custom");
  });
});
