import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelGatewayHost } from "./channel-gateway-host.js";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hosts: ChannelGatewayHost[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("ChannelGatewayHost restart policy", () => {
  it("recovers an unexpectedly killed Gateway but does not restart after stop", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "forge-gateway-host-"));
    tempDirs.push(dataDir);
    const port = 40_000 + Math.floor(Math.random() * 10_000);
    const host = new ChannelGatewayHost({
      dataDir,
      pidFile: join(dataDir, "gateway.pid"),
      listenPort: port,
      gatewayEntry: join(appRoot, "test-fixtures", "channel-gateway-fixture.mjs"),
      healthTimeoutMs: 3_000,
      restartBaseDelayMs: 20,
      restartMaxDelayMs: 100,
    });
    hosts.push(host);

    const first = await host.start();
    expect(first.running).toBe(true);
    expect(first.pid).toBeTypeOf("number");
    process.kill(first.pid!, "SIGKILL");

    const recovered = await eventually(async () => {
      const status = await host.getStatus();
      return status.running && status.pid !== first.pid ? status : null;
    });
    expect(recovered.pid).not.toBe(first.pid);

    await host.stop();
    await eventually(async () => ((await host.getStatus()).running ? null : true));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await host.getStatus()).running).toBe(false);
  });
});

async function eventually<T>(fn: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not met before timeout");
}
