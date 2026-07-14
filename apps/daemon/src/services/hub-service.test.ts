import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import {
  handleHubDeploy,
  handleHubInstall,
  handleHubList,
  handleHubRemove,
  handleHubSync,
  handleHubUndeploy,
} from "./hub-service.js";

function makeSkillSource(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hub-svc-src-${id}-`));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: test\n---\n# ${id}\n`);
  return dir;
}

function newDeps() {
  return { dataDir: mkdtempSync(join(tmpdir(), "hub-svc-data-")) };
}

describe("hub-service RPC handlers", () => {
  it("installs from sourceDir and lists with protocol shape", async () => {
    const deps = newDeps();
    const res = await handleHubInstall(
      { kind: "skill", id: "probe", sourceDir: makeSkillSource("probe") },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.item?.id).toBe("probe");
    expect(res.item?.kind).toBe("skill");

    const list = await handleHubList({}, deps);
    expect(list.items.map((i) => i.id)).toContain("probe");
    expect(list.items[0].contentHash).toMatch(/^sha256:/);
  });

  it("deploys to forge+cursor (project scope) and reports statuses", async () => {
    const deps = newDeps();
    const cwd = mkdtempSync(join(tmpdir(), "hub-svc-cwd-"));
    await handleHubInstall({ kind: "skill", id: "probe", sourceDir: makeSkillSource("probe") }, deps);

    const res = await handleHubDeploy(
      { extId: "probe", agents: ["forge", "cursor"], scope: "project", cwd },
      deps,
    );
    expect(res.item?.deployments.forge?.status).toBe("synced");
    expect(res.item?.deployments.cursor?.status).toBe("synced");
    expect(existsSync(join(cwd, ".forge/skills/probe"))).toBe(true);
    expect(existsSync(join(cwd, ".cursor/skills/probe"))).toBe(true);
  });

  it("undeploys from one agent and removes entirely", async () => {
    const deps = newDeps();
    const cwd = mkdtempSync(join(tmpdir(), "hub-svc-cwd-"));
    await handleHubInstall({ kind: "skill", id: "probe", sourceDir: makeSkillSource("probe") }, deps);
    await handleHubDeploy({ extId: "probe", agents: ["forge", "cursor"], scope: "project", cwd }, deps);

    await handleHubUndeploy({ extId: "probe", agent: "cursor", scope: "project", cwd }, deps);
    expect(existsSync(join(cwd, ".cursor/skills/probe"))).toBe(false);
    expect(existsSync(join(cwd, ".forge/skills/probe"))).toBe(true);

    await handleHubRemove({ extId: "probe" }, deps);
    expect(existsSync(join(cwd, ".forge/skills/probe"))).toBe(false);
    const list = await handleHubList({}, deps);
    expect(list.items).toHaveLength(0);
  });

  it("re-syncs a missing deployment", async () => {
    const deps = newDeps();
    const cwd = mkdtempSync(join(tmpdir(), "hub-svc-cwd-"));
    await handleHubInstall({ kind: "skill", id: "probe", sourceDir: makeSkillSource("probe") }, deps);
    await handleHubDeploy({ extId: "probe", agents: ["forge"], scope: "project", cwd }, deps);

    rmSync(join(cwd, ".forge/skills/probe"), { recursive: true, force: true });
    let list = await handleHubList({}, deps);
    expect(list.items[0].deployments.forge?.status).toBe("missing");

    const sync = await handleHubSync({ extId: "probe" }, deps);
    expect(sync.entries.find((e) => e.agent === "forge")?.action).toBe("redeployed");
    expect(existsSync(join(cwd, ".forge/skills/probe"))).toBe(true);

    list = await handleHubList({}, deps);
    expect(list.items[0].deployments.forge?.status).toBe("synced");
  });
});
