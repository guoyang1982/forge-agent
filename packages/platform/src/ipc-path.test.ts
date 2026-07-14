import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDaemonIpcPath } from "./ipc-path.js";

describe("resolveDaemonIpcPath", () => {
  it("uses a unix socket under the data dir on posix", () => {
    const prev = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(resolveDaemonIpcPath("/data/forge")).toBe(
        join("/data/forge", "daemon.sock"),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: prev });
    }
  });

  it("uses a stable named pipe on Windows", () => {
    const prev = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const path = resolveDaemonIpcPath("C:\\Users\\alice\\.forge-agent");
      expect(path).toMatch(/^\\\\\.\\pipe\\forge-agent-[0-9a-f]{12}$/);
      expect(path).toBe(resolveDaemonIpcPath("C:\\Users\\alice\\.forge-agent"));
      const other = resolveDaemonIpcPath("C:\\Users\\bob\\.forge-agent");
      expect(other).not.toBe(path);
    } finally {
      Object.defineProperty(process, "platform", { value: prev });
    }
  });
});
