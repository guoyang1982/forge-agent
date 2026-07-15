import { describe, expect, it } from "vitest";
import {
  resolveDevelopmentNodeExecutable,
  shouldReplaceConnectedDaemon,
  waitForDaemonDisconnect,
} from "./daemon-lifecycle.js";

describe("resolveDevelopmentNodeExecutable", () => {
  it("prefers an explicit Forge Node executable", () => {
    expect(
      resolveDevelopmentNodeExecutable({
        FORGE_NODE_EXECUTABLE: "/custom/node",
        npm_node_execpath: "/npm/node",
      }),
    ).toBe("/custom/node");
  });

  it("uses the package manager Node executable when available", () => {
    expect(resolveDevelopmentNodeExecutable({ npm_node_execpath: "/npm/node" })).toBe(
      "/npm/node",
    );
  });

  it("falls back to node on PATH", () => {
    expect(resolveDevelopmentNodeExecutable({})).toBe("node");
  });
});

describe("shouldReplaceConnectedDaemon", () => {
  it("replaces a matching daemon on the first development startup", () => {
    expect(
      shouldReplaceConnectedDaemon({
        isPackaged: false,
        developmentDaemonSynchronized: false,
        observedBuild: "same-static-build",
        expectedBuild: "same-static-build",
      }),
    ).toBe(true);
  });

  it("reuses the synchronized development daemon when the build matches", () => {
    expect(
      shouldReplaceConnectedDaemon({
        isPackaged: false,
        developmentDaemonSynchronized: true,
        observedBuild: "current-build",
        expectedBuild: "current-build",
      }),
    ).toBe(false);
  });

  it("reuses a matching packaged daemon", () => {
    expect(
      shouldReplaceConnectedDaemon({
        isPackaged: true,
        developmentDaemonSynchronized: false,
        observedBuild: "release-build",
        expectedBuild: "release-build",
      }),
    ).toBe(false);
  });

  it("replaces a mismatched daemon after synchronization", () => {
    expect(
      shouldReplaceConnectedDaemon({
        isPackaged: false,
        developmentDaemonSynchronized: true,
        observedBuild: "old-build",
        expectedBuild: "new-build",
      }),
    ).toBe(true);
  });
});

describe("waitForDaemonDisconnect", () => {
  it("waits until the old daemon stops answering before allowing replacement", async () => {
    let probes = 0;
    const pauses: number[] = [];

    await waitForDaemonDisconnect(
      async () => {
        probes += 1;
        if (probes < 3) return { ok: true };
        throw new Error("socket closed");
      },
      async (ms) => {
        pauses.push(ms);
      },
      { attempts: 4, intervalMs: 25 },
    );

    expect(probes).toBe(3);
    expect(pauses).toEqual([25, 25]);
  });

  it("fails instead of spawning alongside a daemon that never disconnects", async () => {
    await expect(
      waitForDaemonDisconnect(
        async () => ({ ok: true }),
        async () => {},
        { attempts: 2, intervalMs: 1 },
      ),
    ).rejects.toThrow("did not release its socket");
  });
});
