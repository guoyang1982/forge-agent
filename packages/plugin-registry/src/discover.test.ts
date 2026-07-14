import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectPluginMcpServers, collectPluginSkillPaths } from "./contributions.js";
import { discoverPlugins } from "./discover.js";

describe("plugin discovery", () => {
  it("discovers valid plugin manifests and resolves enabled contributions", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-plugin-"));
    const pluginRoot = join(root, "demo");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        enabledByDefault: true,
        capabilities: {
          skills: ["skills/demo.md"],
          mcpServers: [{ name: "demo", command: "node", args: ["server.js"] }],
        },
      }),
    );

    const plugins = discoverPlugins({ projectDir: root });

    expect(plugins).toHaveLength(1);
    expect(plugins[0].source).toBe("project");
    expect(collectPluginSkillPaths(plugins)[0]).toBe(join(pluginRoot, "skills/demo.md"));
    expect(collectPluginMcpServers(plugins)[0].name).toBe("demo");
  });

  it("ignores invalid manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-plugin-invalid-"));
    const pluginRoot = join(root, "bad");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, "plugin.json"), JSON.stringify({ id: "bad" }));

    expect(discoverPlugins({ projectDir: root })).toEqual([]);
  });

  it("applies config enabled overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-plugin-config-"));
    const pluginRoot = join(root, "demo");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        enabledByDefault: true,
      }),
    );

    const plugins = discoverPlugins({
      projectDir: root,
      config: { plugins: { enabled: { demo: false } } },
    });

    expect(plugins[0].enabled).toBe(false);
  });

  it("reads Cursor agent pointer manifest when Forge plugin.json is absent", async () => {
    const { readPluginManifest } = await import("./manifest.js");
    const root = mkdtempSync(join(tmpdir(), "forge-plugin-cursor-"));
    mkdirSync(join(root, ".cursor-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".cursor-plugin/plugin.json"),
      JSON.stringify({
        name: "brand-guidelines",
        displayName: "Brand Guidelines",
        version: "1.2.0",
        description: "Brand colors",
      }),
    );
    const m = readPluginManifest(root);
    expect(m.id).toBe("brand-guidelines");
    expect(m.name).toBe("Brand Guidelines");
    expect(m.version).toBe("1.2.0");
  });

  it("discovers agent pointer plugins and exposes their skill directory", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-plugin-codex-"));
    const pluginRoot = join(root, "browser");
    mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(pluginRoot, ".codex-plugin/plugin.json"),
      JSON.stringify({
        name: "browser",
        displayName: "Browser",
        version: "26.623.141536",
        skills: "./skills/",
      }),
    );

    const plugins = discoverPlugins({ userDir: root });

    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.id).toBe("browser");
    expect(plugins[0].manifest.name).toBe("Browser");
    expect(collectPluginSkillPaths(plugins)).toEqual([join(pluginRoot, "skills")]);
  });

  it("adapts a standard MCP sidecar from an agent pointer manifest", async () => {
    const { readPluginManifest } = await import("./manifest.js");
    const root = mkdtempSync(join(tmpdir(), "forge-plugin-mcp-"));
    mkdirSync(join(root, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".codex-plugin/plugin.json"),
      JSON.stringify({ name: "database", version: "1.0.0", mcpServers: "./.mcp.json" }),
    );
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { database: { command: "node", args: ["server.js"] } } }),
    );

    expect(readPluginManifest(root).capabilities?.mcpServers).toEqual([
      { name: "database", command: "node", args: ["server.js"], cwd: root },
    ]);
  });

  it("throws a clear error when no plugin manifest exists", async () => {
    const { readPluginManifest } = await import("./manifest.js");
    const root = mkdtempSync(join(tmpdir(), "forge-plugin-empty-"));
    expect(() => readPluginManifest(root)).toThrow(/不是插件包/);
  });
});
