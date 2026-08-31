import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelStore } from "@forge/channel";
import { MobileChannelAdapter } from "@forge/channel-mobile";
import type {
  AdapterContext,
  ChannelAdapter,
  ChannelAdapterHealth,
  ChannelKind,
} from "@forge/channel-core";
import { ForgeStore } from "@forge/store";
import { ChannelGateway } from "./gateway.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tempDirs: string[] = [];

function tempDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), "forge-channel-gateway-"));
  tempDirs.push(path);
  return path;
}

function withStore<T>(dataDir: string, fn: (store: ChannelStore) => T): T {
  const owner = ForgeStore.open({
    dbPath: join(dataDir, "data.db"),
    migrationsDir: join(repoRoot, "migrations"),
    owner: "test",
  });
  try {
    return fn(new ChannelStore(owner.db));
  } finally {
    owner.close();
  }
}

class FakeAdapter implements ChannelAdapter {
  readonly capability = "interactive" as const;
  starts = 0;
  stops = 0;
  adapterId = "";

  constructor(
    readonly kind: ChannelKind,
    private readonly failStart = false,
  ) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.starts += 1;
    this.adapterId = ctx.adapterId;
    if (this.failStart) throw new Error(`${this.kind} unavailable`);
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  async health(): Promise<ChannelAdapterHealth> {
    return {
      adapterId: this.adapterId,
      kind: this.kind,
      status: "connected",
    };
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("ChannelGateway adapter reconciliation", () => {
  it("keeps unchanged channels running and restarts only changed channels", async () => {
    const dataDir = tempDataDir();
    const records = withStore(dataDir, (store) => ({
      ilink: store.create({
        kind: "ilink",
        name: "WeChat",
        cwd: "/workspace/a",
        enabled: true,
        config: { botToken: "token-a" },
      }),
      mobile: store.create({
        kind: "mobile",
        name: "Forge Mobile",
        cwd: "/workspace/a",
        enabled: true,
        config: { relayOrigin: "https://relay.example.com" },
      }),
    }));
    const created: FakeAdapter[] = [];
    const gateway = new ChannelGateway({
      dataDir,
      adapterFactory: (kind) => {
        const adapter = new FakeAdapter(kind);
        created.push(adapter);
        return adapter;
      },
    });

    try {
      await gateway.reloadAdapters();
      expect(created).toHaveLength(2);
      expect(gateway.getStatus()).toMatchObject({
        pid: process.pid,
        adapters: expect.arrayContaining([
          expect.objectContaining({ kind: "ilink", status: "connected" }),
          expect.objectContaining({ kind: "mobile", status: "connected" }),
        ]),
      });

      await gateway.reloadAdapters();
      expect(created).toHaveLength(2);
      expect(created.map((adapter) => adapter.stops)).toEqual([0, 0]);

      withStore(dataDir, (store) => {
        store.update(records.mobile.id, { config: { relayOrigin: "https://relay-2.example.com" } });
      });
      await gateway.reloadAdapters();

      expect(created).toHaveLength(3);
      const originalIlink = created.find((adapter) => adapter.adapterId === records.ilink.id);
      const originalMobile = created.find(
        (adapter) => adapter.adapterId === records.mobile.id && adapter.stops === 1,
      );
      expect(originalIlink?.starts).toBe(1);
      expect(originalIlink?.stops).toBe(0);
      expect(originalMobile?.starts).toBe(1);
      expect(originalMobile?.stops).toBe(1);

      withStore(dataDir, (store) => {
        store.update(records.mobile.id, { enabled: false });
      });
      await gateway.reloadAdapters();

      expect(originalIlink?.stops).toBe(0);
      expect(created.at(-1)?.stops).toBe(1);
    } finally {
      await gateway.stop();
    }
  });

  it("isolates one adapter start failure from healthy channels", async () => {
    const dataDir = tempDataDir();
    withStore(dataDir, (store) => {
      store.create({
        kind: "ilink",
        name: "WeChat",
        cwd: "/workspace/a",
        enabled: true,
        config: { botToken: "token-a" },
      });
      store.create({
        kind: "mobile",
        name: "Forge Mobile",
        cwd: "/workspace/a",
        enabled: true,
        config: { relayOrigin: "https://relay.example.com" },
      });
    });
    const gateway = new ChannelGateway({
      dataDir,
      adapterFactory: (kind) => new FakeAdapter(kind, kind === "mobile"),
    });

    try {
      await expect(gateway.reloadAdapters()).resolves.toBeUndefined();
      const statuses = gateway.getStatus().adapters;
      expect(statuses.find((status) => status.kind === "ilink")?.status).toBe("connected");
      expect(statuses.find((status) => status.kind === "mobile")).toMatchObject({
        status: "disconnected",
        lastError: expect.stringContaining("mobile unavailable"),
      });
    } finally {
      await gateway.stop();
    }
  });

  it("keeps a message channel connected when the real Mobile adapter cannot reach Relay", async () => {
    const dataDir = tempDataDir();
    const configPath = join(dataDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        permissions: {
          mobile: {
            enabled: true,
            pair: "allow",
            run: "allow",
            approve: "allow",
            allowedProjects: [dataDir],
            maxDevices: 3,
            maxConcurrentRunsPerDevice: 1,
          },
        },
      }),
    );
    vi.stubEnv("FORGE_CONFIG_PATH", configPath);
    vi.stubEnv("FORGE_DATA_DIR", dataDir);

    withStore(dataDir, (store) => {
      store.create({
        kind: "ilink",
        name: "WeChat",
        cwd: dataDir,
        enabled: true,
        config: { botToken: "token-a" },
      });
      store.create({
        kind: "mobile",
        name: "Forge Mobile",
        cwd: dataDir,
        enabled: true,
        config: {
          relayOrigin: "http://127.0.0.1:1",
          enrollmentToken: "test-enrollment-token-with-32-bytes",
        },
      });
    });

    const messageAdapter = new FakeAdapter("ilink");
    const gateway = new ChannelGateway({
      dataDir,
      adapterFactory: (kind) =>
        kind === "mobile" ? new MobileChannelAdapter() : messageAdapter,
    });

    try {
      await expect(gateway.reloadAdapters()).resolves.toBeUndefined();
      const statuses = gateway.getStatus().adapters;
      expect(messageAdapter).toMatchObject({ starts: 1, stops: 0 });
      expect(statuses.find((status) => status.kind === "ilink")?.status).toBe("connected");
      expect(statuses.find((status) => status.kind === "mobile")).toMatchObject({
        status: "disconnected",
        lastError: expect.stringContaining("start failed"),
      });
    } finally {
      await gateway.stop();
    }
  });
});
