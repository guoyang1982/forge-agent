import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExtensionHub } from "../hub.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";
import { ForgeAdapter } from "./forge.js";

function makePluginSource(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hub-src-${name}-`));
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({
      id: name,
      name: `Plugin ${name}`,
      version: "1.0.0",
      capabilities: { skills: ["skills/main.md"] },
    }),
  );
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "skills/main.md"), "# main skill");
  return dir;
}

function makeSkillSource(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hub-skill-${name}-`));
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
  return dir;
}

function newHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "hub-store-"));
  const claudeHome = mkdtempSync(join(tmpdir(), "claude-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "codex-home-"));
  const hub = new ExtensionHub({
    hubDir,
    adapters: {
      forge: new ForgeAdapter(),
      cursor: new CursorAdapter(),
      "claude-code": new ClaudeAdapter({ home: claudeHome }),
      codex: new CodexAdapter({ home: codexHome }),
    },
  });
  return { hub, claudeHome, codexHome };
}

describe("ClaudeAdapter (user scope, temp home)", () => {
  it("deploys a plugin into a local marketplace and enables it", async () => {
    const { hub, claudeHome } = newHub();
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: makePluginSource("demo") });
    const record = await hub.deploy("demo", { agents: ["claude-code"], scope: "user" });

    const dep = record.deployments["claude-code"]!;
    expect(dep.status).toBe("synced");
    expect(dep.mode).toBe("copy");

    const target = join(claudeHome, "plugins", "forge-hub", "demo");
    expect(existsSync(join(target, "skills/main.md"))).toBe(true);
    const cm = JSON.parse(await readFile(join(target, ".claude-plugin/plugin.json"), "utf-8"));
    expect(cm.skills).toBe("./skills/");

    // marketplace manifest lists the plugin
    const mkt = JSON.parse(
      await readFile(
        join(claudeHome, "plugins", "forge-hub", ".claude-plugin", "marketplace.json"),
        "utf-8",
      ),
    );
    expect(mkt.name).toBe("forge-hub");
    expect(mkt.plugins).toEqual([{ name: "demo", source: "./demo" }]);

    // registered in known_marketplaces + settings, and enabled
    const known = JSON.parse(
      await readFile(join(claudeHome, "plugins", "known_marketplaces.json"), "utf-8"),
    );
    expect(known["forge-hub"].source.source).toBe("directory");
    const settings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf-8"));
    expect(settings.enabledPlugins["demo@forge-hub"]).toBe(true);
    expect(settings.extraKnownMarketplaces["forge-hub"]).toBeDefined();
  });

  it("preserves existing settings.json keys when enabling", async () => {
    const { hub, claudeHome } = newHub();
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({ model: "opus", enabledPlugins: { "other@x": true } }),
    );
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: makePluginSource("demo") });
    await hub.deploy("demo", { agents: ["claude-code"], scope: "user" });

    const settings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf-8"));
    expect(settings.model).toBe("opus");
    expect(settings.enabledPlugins["other@x"]).toBe(true);
    expect(settings.enabledPlugins["demo@forge-hub"]).toBe(true);
  });

  it("deploys a skill via copy into ~/.claude/skills", async () => {
    const { hub, claudeHome } = newHub();
    await hub.installLocal({ id: "sk", kind: "skill", sourceDir: makeSkillSource("sk") });
    await hub.deploy("sk", { agents: ["claude-code"], scope: "user" });
    expect(existsSync(join(claudeHome, "skills/sk/SKILL.md"))).toBe(true);
  });

  it("undeploys: removes plugin, disables it, prunes empty marketplace", async () => {
    const { hub, claudeHome } = newHub();
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: makePluginSource("demo") });
    await hub.deploy("demo", { agents: ["claude-code"], scope: "user" });
    await hub.undeploy("demo", "claude-code", "user");

    expect(existsSync(join(claudeHome, "plugins", "forge-hub", "demo"))).toBe(false);
    const settings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf-8"));
    expect(settings.enabledPlugins["demo@forge-hub"]).toBeUndefined();
    expect(settings.extraKnownMarketplaces?.["forge-hub"]).toBeUndefined();
    const known = JSON.parse(
      await readFile(join(claudeHome, "plugins", "known_marketplaces.json"), "utf-8"),
    );
    expect(known["forge-hub"]).toBeUndefined();
  });

  it("keeps the marketplace registered while another plugin remains", async () => {
    const { hub, claudeHome } = newHub();
    await hub.installLocal({ id: "a", kind: "plugin", sourceDir: makePluginSource("a") });
    await hub.installLocal({ id: "b", kind: "plugin", sourceDir: makePluginSource("b") });
    await hub.deploy("a", { agents: ["claude-code"], scope: "user" });
    await hub.deploy("b", { agents: ["claude-code"], scope: "user" });

    await hub.undeploy("a", "claude-code", "user");
    const settings = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf-8"));
    expect(settings.enabledPlugins["a@forge-hub"]).toBeUndefined();
    expect(settings.enabledPlugins["b@forge-hub"]).toBe(true);
    expect(settings.extraKnownMarketplaces["forge-hub"]).toBeDefined();
    const mkt = JSON.parse(
      await readFile(
        join(claudeHome, "plugins", "forge-hub", ".claude-plugin", "marketplace.json"),
        "utf-8",
      ),
    );
    expect(mkt.plugins).toEqual([{ name: "b", source: "./b" }]);
  });
});

describe("CodexAdapter (local marketplace + config.toml)", () => {
  it("deploys a plugin and registers it in config.toml", async () => {
    const { hub, codexHome } = newHub();
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: makePluginSource("demo") });
    const record = await hub.deploy("demo", { agents: ["codex"], scope: "user" });

    const dep = record.deployments.codex!;
    expect(dep.status).toBe("synced");
    expect(dep.mode).toBe("native");

    const target = join(codexHome, "plugins/forge-hub/plugins/demo");
    expect(existsSync(join(target, "skills/main.md"))).toBe(true);
    expect(existsSync(join(target, ".codex-plugin/plugin.json"))).toBe(true);

    // marketplace manifest lists the plugin with a valid auth policy
    const mkt = JSON.parse(
      await readFile(
        join(codexHome, "plugins/forge-hub/.agents/plugins/marketplace.json"),
        "utf-8",
      ),
    );
    expect(mkt.name).toBe("forge-hub");
    expect(mkt.plugins[0]).toMatchObject({
      name: "demo",
      source: { source: "local", path: "./plugins/demo" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    });

    // install cache copy (v1.0.0 from the plugin manifest) is what marks it installed
    expect(existsSync(join(codexHome, "plugins/cache/forge-hub/demo/1.0.0/skills/main.md"))).toBe(
      true,
    );

    const toml = await readFile(join(codexHome, "config.toml"), "utf-8");
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).toContain("[marketplaces.forge-hub]");
    expect(toml).toContain('source_type = "local"');
    expect(toml).toContain('[plugins."demo@forge-hub"]');
    expect(toml).toContain("enabled = true");
  });

  it("deploys a skill via copy into ~/.codex/skills", async () => {
    const { hub, codexHome } = newHub();
    await hub.installLocal({ id: "sk", kind: "skill", sourceDir: makeSkillSource("sk") });
    await hub.deploy("sk", { agents: ["codex"], scope: "user" });
    expect(existsSync(join(codexHome, "skills/sk/SKILL.md"))).toBe(true);
  });

  it("undeploys a plugin and cleans its config.toml sections", async () => {
    const { hub, codexHome } = newHub();
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: makePluginSource("demo") });
    await hub.deploy("demo", { agents: ["codex"], scope: "user" });
    await hub.undeploy("demo", "codex", "user");

    expect(existsSync(join(codexHome, "plugins/forge-hub/plugins/demo"))).toBe(false);
    expect(existsSync(join(codexHome, "plugins/cache/forge-hub/demo"))).toBe(false);
    const toml = await readFile(join(codexHome, "config.toml"), "utf-8");
    expect(toml).toContain('model = "gpt-5"');
    expect(toml).not.toContain('[plugins."demo@forge-hub"]');
    expect(toml).not.toContain("[marketplaces.forge-hub]");
  });

  it("discovers plugins from all marketplace caches, not only forge-hub", async () => {
    const { hub, codexHome } = newHub();
    const pkg = join(codexHome, "plugins/cache/openai-bundled/browser/1.0.0");
    mkdirSync(join(pkg, ".codex-plugin"), { recursive: true });
    mkdirSync(join(pkg, "skills"), { recursive: true });
    writeFileSync(
      join(pkg, ".codex-plugin/plugin.json"),
      JSON.stringify({ name: "browser", version: "1.0.0" }),
    );
    writeFileSync(join(pkg, "skills/x.md"), "# x");

    const found = await hub.discover({ agents: ["codex"], scope: "user" });
    const agent = found.find((a) => a.agent === "codex");
    expect(agent?.available).toBe(true);
    expect(agent?.found.some((f) => f.id === "browser" && f.kind === "plugin")).toBe(true);
  });

  it("keeps the marketplace section while another plugin remains", async () => {
    const { hub, codexHome } = newHub();
    await hub.installLocal({ id: "a", kind: "plugin", sourceDir: makePluginSource("a") });
    await hub.installLocal({ id: "b", kind: "plugin", sourceDir: makePluginSource("b") });
    await hub.deploy("a", { agents: ["codex"], scope: "user" });
    await hub.deploy("b", { agents: ["codex"], scope: "user" });

    await hub.undeploy("a", "codex", "user");
    const toml = await readFile(join(codexHome, "config.toml"), "utf-8");
    expect(toml).not.toContain('[plugins."a@forge-hub"]');
    expect(toml).toContain('[plugins."b@forge-hub"]');
    expect(toml).toContain("[marketplaces.forge-hub]");
  });
});
