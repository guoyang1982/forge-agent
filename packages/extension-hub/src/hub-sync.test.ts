import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CursorAdapter } from "./adapters/cursor.js";
import { ForgeAdapter } from "./adapters/forge.js";
import { ExtensionHub } from "./hub.js";

function makePluginSource(name: string, body = "# main skill"): string {
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
  writeFileSync(join(dir, "skills/main.md"), body);
  return dir;
}

function newHub() {
  const hubDir = mkdtempSync(join(tmpdir(), "hub-store-"));
  const cwd = mkdtempSync(join(tmpdir(), "hub-cwd-"));
  const claudeHome = mkdtempSync(join(tmpdir(), "claude-home-"));
  const hub = new ExtensionHub({
    hubDir,
    adapters: {
      forge: new ForgeAdapter(),
      cursor: new CursorAdapter(),
      "claude-code": new ClaudeAdapter({ home: claudeHome }),
    },
  });
  return { hub, cwd, claudeHome };
}

describe("ExtensionHub.sync", () => {
  it("flags a deleted deployment as missing, then re-deploys on sync", async () => {
    const { hub, cwd } = newHub();
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: makePluginSource("demo") });
    await hub.deploy("demo", { agents: ["forge"], scope: "project", cwd });

    // Simulate the agent losing the deployment.
    rmSync(join(cwd, ".forge/plugins/demo"), { recursive: true, force: true });
    let reg = await hub.list();
    expect(reg.extensions.demo.deployments.forge!.status).toBe("missing");

    const entries = await hub.sync("demo");
    const entry = entries.find((e) => e.agent === "forge")!;
    expect(entry.action).toBe("redeployed");
    expect(entry.after).toBe("synced");
    expect(existsSync(join(cwd, ".forge/plugins/demo"))).toBe(true);

    reg = await hub.list();
    expect(reg.extensions.demo.deployments.forge!.status).toBe("synced");
  });

  it("re-syncs a drifted deployment and skips already-synced ones", async () => {
    const { hub, cwd } = newHub();
    await hub.installLocal({ id: "demo", kind: "plugin", sourceDir: makePluginSource("demo") });
    await hub.deploy("demo", { agents: ["forge"], scope: "project", cwd });

    // New content -> registry contentHash changes -> deployment drifts.
    await hub.installLocal({
      id: "demo",
      kind: "plugin",
      sourceDir: makePluginSource("demo", "# changed"),
    });
    let reg = await hub.list();
    expect(reg.extensions.demo.deployments.forge!.status).toBe("drift");

    const first = await hub.sync();
    expect(first.find((e) => e.agent === "forge")!.action).toBe("redeployed");
    reg = await hub.list();
    expect(reg.extensions.demo.deployments.forge!.status).toBe("synced");

    // Second sync is a no-op.
    const second = await hub.sync();
    expect(second.find((e) => e.agent === "forge")!.action).toBe("skipped");
  });
});

describe("ExtensionHub.discover + importFromAgent", () => {
  it("discovers an agent-installed extension and imports it into the hub", async () => {
    const { hub, claudeHome } = newHub();
    // Place a bare skill package directly in Claude's skills dir.
    const skillDir = join(claudeHome, "skills", "foo");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# foo skill\n");

    let discovery = await hub.discover({ agents: ["claude-code"], scope: "user" });
    const claude = discovery.find((d) => d.agent === "claude-code")!;
    expect(claude.available).toBe(true);
    const foo = claude.found.find((f) => f.id === "foo")!;
    expect(foo.inHub).toBe(false);

    const record = await hub.importFromAgent("claude-code", "foo", { scope: "user" });
    expect(record.id).toBe("foo");
    expect(record.source?.type).toBe("agent-import");
    expect(existsSync(hub.storePath("skill", "foo"))).toBe(true);

    discovery = await hub.discover({ agents: ["claude-code"], scope: "user" });
    const foo2 = discovery
      .find((d) => d.agent === "claude-code")!
      .found.find((f) => f.id === "foo")!;
    expect(foo2.inHub).toBe(true);
    expect(foo2.hubMatches).toBe(true);
  });
});
