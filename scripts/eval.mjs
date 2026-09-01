#!/usr/bin/env node
/**
 * Lightweight eval: isolated config + daemon + optional live agent runs.
 * Requires: pnpm build. Live agent runs require FORGE_MODEL_API_KEY.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "apps/cli/dist/cli.js");
const daemon = join(root, "apps/daemon/dist/main.js");
const evalRoot = mkdtempSync(join(tmpdir(), "forge-eval-"));
const dataDir = join(evalRoot, "data");
const workspace = join(evalRoot, "workspace");
const env = {
  ...process.env,
  FORGE_DATA_DIR: dataDir,
};
let cleaned = false;
let daemonProc;

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [cli, ...args], {
      cwd: opts.cwd ?? workspace,
      stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env,
    });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (d) => (stdout += d));
    p.stderr?.on("data", (d) => (stderr += d));
    p.on("close", (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`forge ${args.join(" ")} exited ${code}\n${stderr}`)),
    );
    p.on("error", reject);
  });
}

function startDaemon() {
  const p = spawn("node", [daemon], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    env,
  });
  return p;
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  daemonProc?.kill();
  rmSync(evalRoot, { recursive: true, force: true });
}

async function waitForPing() {
  for (let i = 0; i < 30; i++) {
    try {
      await run(["ping"], { capture: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("daemon did not respond to ping");
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    throw new Error(`${label} did not include ${JSON.stringify(expected)}\n${text}`);
  }
}

function runExecutionGate() {
  const targets = [
    "packages/store/src/core-execution-migrations.test.ts",
    "packages/store/src/legacy-upgrade.test.ts",
    "packages/event-store/src/store.test.ts",
    "packages/execution/src/trace.test.ts",
    "packages/execution/src/store.test.ts",
    "packages/execution/src/executor.test.ts",
    "packages/execution/src/recovery.test.ts",
    "packages/daemon-client/src/subscription.test.ts",
    "apps/daemon/src/durable-restart.e2e.test.ts",
  ];
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", ...targets],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) {
    throw new Error("durable execution gate failed");
  }
}

async function main() {
  if (!existsSync(cli) || !existsSync(daemon)) {
    console.error("Run pnpm build first.");
    process.exit(1);
  }

  console.log("=== Durable execution gate ===\n");
  runExecutionGate();
  console.log("\n✓ durable execution gate\n");

  console.log("=== Forge eval ===\n");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify(
      {
        name: "forge-eval-workspace",
        scripts: {
          dev: "node index.js",
          test: "node --test",
        },
      },
      null,
      2,
    ),
  );

  daemonProc = startDaemon();
  process.on("exit", cleanup);

  await waitForPing();
  console.log("\n✓ ping\n");

  const status = await run(["status", "--json"], { capture: true });
  const statusJson = JSON.parse(status.stdout);
  if (statusJson.activeRun !== false) {
    throw new Error(`unexpected activeRun in status: ${status.stdout}`);
  }
  console.log("✓ status --json\n");

  const { SessionStore } = await import("../packages/session/dist/index.js");
  const store = new SessionStore(join(dataDir, "data.db"), join(root, "migrations"));
  const seededSessionId = store.createSession(workspace);
  for (let i = 0; i < 5; i++) {
    store.appendMessage(seededSessionId, {
      role: "user",
      content: `eval session message ${i}`,
    });
  }
  store.close();

  const sessions = await run(["sessions", "--json"], { capture: true });
  assertIncludes(sessions.stdout, seededSessionId, "sessions --json");
  const session = await run(["session", seededSessionId.slice(0, 8), "--json"], {
    capture: true,
  });
  assertIncludes(session.stdout, "eval session message 4", "session --json");
  const compact = await run(
    ["compact", seededSessionId.slice(0, 8), "--keep-last", "2", "--json"],
    { capture: true },
  );
  const compactJson = JSON.parse(compact.stdout);
  if (compactJson.summarizedMessages !== 3 || compactJson.keptMessages !== 2) {
    throw new Error(`unexpected compact result: ${compact.stdout}`);
  }
  console.log("✓ sessions/session/compact\n");

  await run(["init", "--agents", "--cwd", workspace]);
  const agents = readFileSync(join(workspace, "AGENTS.md"), "utf-8");
  assertIncludes(agents, "forge-eval-workspace", "AGENTS.md");
  assertIncludes(agents, "npm run dev", "AGENTS.md");
  assertIncludes(agents, "npm test", "AGENTS.md");
  console.log("✓ init --agents\n");

  const pluginRoot = join(workspace, ".forge/plugins/eval-plugin");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(
    join(pluginRoot, "plugin.json"),
    JSON.stringify(
      {
        id: "eval-plugin",
        name: "Eval Plugin",
        version: "1.0.0",
        enabledByDefault: true,
        capabilities: {
          skills: ["skills/eval.md"],
        },
      },
      null,
      2,
    ),
  );
  mkdirSync(join(pluginRoot, "skills"), { recursive: true });
  writeFileSync(
    join(pluginRoot, "skills/eval.md"),
    "---\nname: Eval Skill\ntriggers: eval plugin\n---\nUse this eval skill.\n",
  );
  const plugins = await run(["plugins", "list", "--cwd", workspace], {
    capture: true,
  });
  assertIncludes(plugins.stdout, "forge-demo", "builtin demo plugin");
  assertIncludes(plugins.stdout, "eval-plugin", "plugins list");
  assertIncludes(plugins.stdout, "enabled", "plugins list");
  await run(["plugins", "validate", "forge-demo", "--cwd", workspace]);
  await run(["plugins", "validate", "eval-plugin", "--cwd", workspace]);
  const disable = await run(["plugins", "disable", "eval-plugin", "--cwd", workspace], {
    capture: true,
  });
  assertIncludes(disable.stdout, "Runtime reloaded", "plugins disable reload");
  const disabled = await run(["plugins", "list", "--cwd", workspace], {
    capture: true,
  });
  assertIncludes(disabled.stdout, "disabled", "plugins disable");
  const enable = await run(["plugins", "enable", "eval-plugin", "--cwd", workspace], {
    capture: true,
  });
  assertIncludes(enable.stdout, "Runtime reloaded", "plugins enable reload");
  const projectDisable = await run(
    ["plugins", "disable", "eval-plugin", "--cwd", workspace, "--project"],
    { capture: true },
  );
  assertIncludes(projectDisable.stdout, "(project)", "plugins project disable");
  const projectConfig = readFileSync(join(workspace, ".forge/config.json"), "utf-8");
  assertIncludes(projectConfig, '"eval-plugin": false', "project plugin config");
  const projectDisabled = await run(["plugins", "list", "--cwd", workspace], {
    capture: true,
  });
  assertIncludes(projectDisabled.stdout, "disabled", "plugins project disabled");
  await run(["plugins", "enable", "eval-plugin", "--cwd", workspace, "--project"], {
    capture: true,
  });
  console.log("✓ plugins list/validate/enable/disable\n");

  if (!process.env.FORGE_MODEL_API_KEY) {
    console.log("Skip live runs (no FORGE_MODEL_API_KEY). Offline eval passed.");
    cleanup();
    return;
  }

  console.log("--- plan: structured ---");
  const plan = await run(["plan", "add a README section", "--cwd", workspace, "--json"], {
    capture: true,
  });
  JSON.parse(plan.stdout);
  console.log("\n✓ plan --json\n");

  console.log("--- review: structured ---");
  const review = await run(["review", "--cwd", workspace, "--json"], {
    capture: true,
  });
  JSON.parse(review.stdout);
  console.log("\n✓ review --json\n");

  console.log("--- run: list dir ---");
  await run(["run", "用 list_dir 列出当前目录", "--cwd", workspace]);
  console.log("\n✓ list_dir run\n");

  console.log("--- run: echo tool ---");
  await run(["run", "调用 echo 工具说 eval-ok", "--cwd", workspace]);
  console.log("\n✓ echo run\n");

  console.log("\n=== Eval passed ===");
  cleanup();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
