import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExtensionHub } from "./hub.js";

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

function newHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "hub-store-"));
  const cwd = mkdtempSync(join(tmpdir(), "hub-cwd-"));
  return { hub: new ExtensionHub({ hubDir }), hubDir, cwd };
}

describe("ExtensionHub end-to-end (project scope)", () => {
  it("installs into store and registers with parsed capabilities", async () => {
    const { hub } = newHub();
    const record = await hub.installLocal({
      id: "demo",
      kind: "plugin",
      sourceDir: makePluginSource("demo"),
    });
    expect(record.name).toBe("Plugin demo");
    expect(record.capabilities.skills).toEqual(["skills/main.md"]);
    expect(record.contentHash).toMatch(/^sha256:/);
    expect(existsSync(hub.storePath("plugin", "demo"))).toBe(true);
  });

  it("deploys to forge (symlink) and cursor (sideload) with synced status", async () => {
    const { hub, cwd } = newHub();
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: makePluginSource("demo") });

    const record = await hub.deploy("demo", {
      agents: ["forge", "cursor"],
      scope: "project",
      cwd,
    });

    const forge = record.deployments.forge!;
    const cursor = record.deployments.cursor!;
    expect(forge.status).toBe("synced");
    expect(forge.mode).toBe("symlink");
    expect(existsSync(join(cwd, ".forge/plugins/demo"))).toBe(true);

    expect(cursor.status).toBe("synced");
    expect(cursor.mode).toBe("sideload");
    expect(cursor.manifestVariant).toBe(".cursor-plugin/plugin.json");
    const target = join(cwd, ".cursor/plugins/local/demo");
    expect(existsSync(join(target, "skills/main.md"))).toBe(true);
    // Cursor manifest was generated from the Forge manifest.
    const cm = JSON.parse(await readFile(join(target, ".cursor-plugin/plugin.json"), "utf-8"));
    expect(cm.skills).toBe("./skills/");
  });

  it("records and blocks a deployment with an unmet host runtime", async () => {
    const { hub, cwd } = newHub();
    const source = makePluginSource("codex-browser");
    writeFileSync(
      join(source, "skills/main.md"),
      "Use mcp__node_repl__js with agent.browsers.list().",
    );
    await hub.installLocal({ id: "codex-browser", kind: "plugin", sourceDir: source });

    const record = await hub.deploy("codex-browser", {
      agents: ["forge"],
      scope: "project",
      cwd,
    });

    expect(record.compatibility?.forge.status).toBe("incompatible");
    expect(record.compatibility?.codex.status).toBe("compatible");
    expect(record.deployments.forge).toMatchObject({ status: "error" });
  });

  it("marks an existing incompatible deployment as an error during list", async () => {
    const { hub, cwd } = newHub();
    const source = makePluginSource("legacy-browser");
    writeFileSync(join(source, "skills/main.md"), "Use mcp__node_repl__js.");
    const record = await hub.installLocal({ id: "legacy-browser", kind: "plugin", sourceDir: source });
    record.deployments.forge = {
      scope: "project",
      cwd,
      path: join(cwd, ".forge/plugins/legacy-browser"),
      mode: "symlink",
      deployedHash: record.contentHash,
      status: "synced",
    };
    // Persist a deployment that predates compatibility metadata.
    const legacyRecord = { ...record, compatibility: undefined };
    const registryPath = join(hub.hubDir, "registry.json");
    writeFileSync(registryPath, JSON.stringify({ version: 1, extensions: { "legacy-browser": legacyRecord } }));

    const listed = await hub.list();
    expect(listed.extensions["legacy-browser"].deployments.forge).toMatchObject({
      status: "error",
      note: expect.stringContaining("不兼容"),
    });
  });

  it("undeploys from one agent, keeping the store and other agents", async () => {
    const { hub, cwd } = newHub();
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: makePluginSource("demo") });
    await hub.deploy("demo", { agents: ["forge", "cursor"], scope: "project", cwd });

    await hub.undeploy("demo", "cursor", "project", cwd);

    expect(existsSync(join(cwd, ".cursor/plugins/local/demo"))).toBe(false);
    expect(existsSync(join(cwd, ".forge/plugins/demo"))).toBe(true);
    expect(existsSync(hub.storePath("plugin", "demo"))).toBe(true);

    const reg = await hub.list();
    expect(reg.extensions.demo.deployments.cursor).toBeUndefined();
    expect(reg.extensions.demo.deployments.forge).toBeDefined();
  });

  it("removes the extension from store and all agents", async () => {
    const { hub, cwd } = newHub();
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: makePluginSource("demo") });
    await hub.deploy("demo", { agents: ["forge", "cursor"], scope: "project", cwd });

    await hub.remove("demo");

    expect(existsSync(join(cwd, ".forge/plugins/demo"))).toBe(false);
    expect(existsSync(join(cwd, ".cursor/plugins/local/demo"))).toBe(false);
    expect(existsSync(hub.storePath("plugin", "demo"))).toBe(false);
    const reg = await hub.list();
    expect(reg.extensions.demo).toBeUndefined();
  });

  it("flags drift when store content changes after deploy", async () => {
    const { hub, cwd } = newHub();
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: makePluginSource("demo") });
    await hub.deploy("demo", { agents: ["forge"], scope: "project", cwd });

    // Reinstall with different content -> new contentHash, stale deployedHash.
    const changed = makePluginSource("demo");
    writeFileSync(join(changed, "skills/main.md"), "# changed skill body");
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: changed });

    const reg = await hub.list();
    expect(reg.extensions.demo.deployments.forge!.status).toBe("drift");
  });
});
