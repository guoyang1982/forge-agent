import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAEMON_METHODS, V2_RPC_METHODS } from "@forge/protocol";
import { TypedRouter } from "../host/router.js";
import type { ForgeDaemonContext } from "./context.js";
import { createDaemonModules } from "./index.js";
import { createSystemModule } from "./system-module.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("daemon business modules", () => {
  it("registers every declared product method exactly once", () => {
    const router = new TypedRouter();
    const context = {
      serverVersion: "0.2.0-test",
      build: "modules-test",
    } as ForgeDaemonContext;

    createSystemModule({
      capabilities: () => ({
        protocolVersion: 2,
        serverVersion: "0.2.0-test",
        methods: [],
        eventTypes: [],
        features: {},
      }),
      status: async () => ({ ok: true, migrationVersion: null, modules: [] }),
    }).register(router, context);

    for (const module of createDaemonModules(context)) {
      module.register(router, context);
    }

    const kernelMethods = new Set<string>(V2_RPC_METHODS);
    const productMethods = router.methods().filter((method) => !kernelMethods.has(method));

    expect(new Set(productMethods)).toEqual(
      new Set(Object.values(DAEMON_METHODS)),
    );
    expect(productMethods).toHaveLength(Object.values(DAEMON_METHODS).length);
    expect(router.methods()).toEqual(
      expect.arrayContaining([
        "run.create",
        "run.get",
        "run.cancel",
        "run.resume",
        "events.read",
        "events.cursor.ack",
        "workspace.groups.create",
        "approvals.list",
        "budgets.get",
        "artifacts.get",
        "validations.list",
        "agentProfiles.publish",
      ]),
    );
  });

  it("keeps main as the composition root instead of a business router", () => {
    const source = readFileSync(
      join(repoRoot, "apps", "daemon", "src", "main.ts"),
      "utf8",
    );

    expect(source).not.toContain("if (method ===");
  });
});
