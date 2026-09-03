import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectDaemon } from "@forge/bus";
import { ForgeStore } from "@forge/store";
import { DaemonHost } from "./daemon-host.js";
import type { DaemonContext, DaemonModule } from "./types.js";

const fixtureRoots: string[] = [];
const hosts: DaemonHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.stop().catch(() => {});
  }
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("DaemonHost lifecycle", () => {
  it("starts modules in registration order and stops them in reverse", async () => {
    const calls: string[] = [];
    const fixture = hostFixture();
    const host = trackHost(
      new DaemonHost(
        [lifecycleModule("store", calls), lifecycleModule("runtime", calls)],
        fixture.context,
      ),
    );

    await host.start();
    await host.stop();

    expect(calls).toEqual([
      "start:store",
      "start:runtime",
      "stop:runtime",
      "stop:store",
    ]);
    expect(fixture.store.db.open).toBe(false);
  });

  it("rolls back started modules and closes the store when startup fails", async () => {
    const calls: string[] = [];
    const fixture = hostFixture();
    const host = trackHost(
      new DaemonHost(
        [
          lifecycleModule("store", calls),
          lifecycleModule("runtime", calls, { failStart: true }),
        ],
        fixture.context,
      ),
    );

    await expect(host.start()).rejects.toThrow("runtime failed");
    expect(calls).toEqual(["start:store", "start:runtime", "stop:store"]);
    expect(fixture.store.db.open).toBe(false);
    expect(existsSync(fixture.socketPath)).toBe(false);
  });

  it("starts the RPC listener only after every module is ready", async () => {
    const fixture = hostFixture();
    const module: DaemonModule<DaemonContext> = {
      id: "runtime",
      register: () => {},
      start: () => {
        expect(existsSync(fixture.socketPath)).toBe(false);
      },
    };
    const host = trackHost(new DaemonHost([module], fixture.context));

    await host.start();
    expect(existsSync(fixture.socketPath)).toBe(true);
  });
});

describe("DaemonHost system module", () => {
  it("serves a typed ping response", async () => {
    const fixture = hostFixture();
    const host = trackHost(new DaemonHost([], fixture.context));
    await host.start();
    const client = await connectDaemon(fixture.socketPath);

    try {
      await expect(client.request("system.ping", {})).resolves.toEqual({
        ok: true,
        version: "0.2.0-test",
        build: "host-test",
      });
    } finally {
      client.close();
    }
  });

  it("aggregates methods, event types, and module features", async () => {
    const fixture = hostFixture();
    const host = trackHost(
      new DaemonHost(
        [
          {
            id: "runtime",
            feature: { version: 3, enabled: true },
            register: () => {},
          },
        ],
        fixture.context,
      ),
    );
    await host.start();
    const client = await connectDaemon(fixture.socketPath);

    try {
      const capabilities = await client.request("system.capabilities", {});
      expect(new Set(capabilities.methods)).toEqual(
        new Set(["ping", "system.ping", "system.capabilities", "system.status"]),
      );
      expect(capabilities).toMatchObject({
        protocolVersion: 2,
        serverVersion: "0.2.0-test",
        eventTypes: ["run.updated"],
        features: {
          system: { version: 1, enabled: true },
          runtime: { version: 3, enabled: true },
        },
      });
    } finally {
      client.close();
    }
  });

  it("reports migration and sanitized module health", async () => {
    const fixture = hostFixture({
      "002_next.sql": "CREATE TABLE next_feature (id INTEGER PRIMARY KEY);",
    });
    const host = trackHost(
      new DaemonHost(
        [
          {
            id: "runtime",
            register: () => {},
          },
          {
            id: "external",
            register: () => {},
            health: () => {
              throw new Error(`backend unavailable at ${fixture.root}/secret.sock`);
            },
          },
        ],
        fixture.context,
      ),
    );
    await host.start();
    const client = await connectDaemon(fixture.socketPath);

    try {
      const status = await client.request("system.status", {});
      expect(status).toEqual({
        ok: false,
        migrationVersion: "002_next.sql",
        modules: [
          { id: "system", status: "healthy" },
          { id: "runtime", status: "healthy" },
          { id: "external", status: "degraded" },
        ],
      });
      expect(JSON.stringify(status)).not.toContain(fixture.root);
      expect(JSON.stringify(status)).not.toContain("secret.sock");
    } finally {
      client.close();
    }
  });
});

function hostFixture(extraMigrations: Record<string, string> = {}): {
  root: string;
  socketPath: string;
  store: ForgeStore;
  context: DaemonContext;
} {
  const root = mkdtempSync(join(tmpdir(), "forge-daemon-host-"));
  fixtureRoots.push(root);
  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir);
  writeFileSync(
    join(migrationsDir, "001_init.sql"),
    "CREATE TABLE host_fixture (id INTEGER PRIMARY KEY);",
  );
  for (const [name, sql] of Object.entries(extraMigrations)) {
    writeFileSync(join(migrationsDir, name), sql);
  }
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  const socketPath = join(root, "daemon.sock");
  return {
    root,
    socketPath,
    store,
    context: {
      socketPath,
      store,
      serverVersion: "0.2.0-test",
      build: "host-test",
      eventTypes: ["run.updated"],
    } as DaemonContext,
  };
}

function lifecycleModule(
  id: string,
  calls: string[],
  options: { failStart?: boolean } = {},
): DaemonModule<DaemonContext> {
  return {
    id,
    register: () => {},
    start: () => {
      calls.push(`start:${id}`);
      if (options.failStart) throw new Error(`${id} failed`);
    },
    stop: () => {
      calls.push(`stop:${id}`);
    },
  };
}

function trackHost(host: DaemonHost): DaemonHost {
  hosts.push(host);
  return host;
}
