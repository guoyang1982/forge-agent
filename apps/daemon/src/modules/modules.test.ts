import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DAEMON_METHODS, V2_RPC_METHODS } from "@forge/protocol";
import { TypedRouter } from "../host/router.js";
import type { ForgeDaemonContext } from "./context.js";
import { createDaemonModules } from "./index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("daemon business modules", () => {
  it("registers every declared compatibility method exactly once", () => {
    const router = new TypedRouter();
    const context = {} as ForgeDaemonContext;

    for (const module of createDaemonModules(context)) {
      module.register(router, context);
    }

    const v2Methods = new Set<string>(V2_RPC_METHODS);
    const legacyMethods = router.methods().filter((method) => !v2Methods.has(method));

    expect(new Set(legacyMethods)).toEqual(
      new Set(Object.values(DAEMON_METHODS)),
    );
    expect(legacyMethods).toHaveLength(Object.values(DAEMON_METHODS).length);
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
