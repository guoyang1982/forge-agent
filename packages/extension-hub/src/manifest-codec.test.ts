import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCapabilitiesFromDir,
  toCursorManifest,
} from "./manifest-codec.js";

describe("toCursorManifest", () => {
  it("maps Forge capabilities to directory-pointer fields", () => {
    const { path, manifest } = toCursorManifest({
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      capabilities: {
        skills: ["skills/a.md"],
        commands: [{ name: "demo:x", description: "" }],
        mcpServers: [{ name: "demo", command: "node", args: [] }],
      },
    });
    expect(path).toBe(".cursor-plugin/plugin.json");
    expect(manifest.name).toBe("demo");
    expect(manifest.displayName).toBe("Demo");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.commands).toBe("./commands/");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.hooks).toBe("./hooks/hooks-cursor.json");
  });

  it("omits fields when capabilities are empty", () => {
    const { manifest } = toCursorManifest({ id: "bare", name: "Bare", version: "0.1.0" });
    expect(manifest.skills).toBeUndefined();
    expect(manifest.mcpServers).toBeUndefined();
  });
});

describe("parseCapabilitiesFromDir", () => {
  it("reads capabilities from a Forge plugin.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-caps-"));
    writeFileSync(
      join(dir, "plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        capabilities: {
          skills: ["skills/a.md"],
          mcpServers: [{ name: "demo", command: "node" }],
        },
      }),
    );
    const caps = await parseCapabilitiesFromDir(dir);
    expect(caps.skills).toEqual(["skills/a.md"]);
    expect(caps.mcpServers).toEqual(["demo"]);
  });

  it("falls back to a directory-pointer skill manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-caps-skill-"));
    mkdirSync(join(dir, ".cursor-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".cursor-plugin/plugin.json"),
      JSON.stringify({ name: "sk", skills: "./skills/" }),
    );
    const caps = await parseCapabilitiesFromDir(dir);
    expect(caps.skills).toEqual(["./skills/"]);
  });

  it("reads standard MCP server names from a sidecar declaration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-caps-mcp-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { browser: { command: "node" } } }),
    );
    const caps = await parseCapabilitiesFromDir(dir);
    expect(caps.mcpServers).toEqual(["browser"]);
  });
});
