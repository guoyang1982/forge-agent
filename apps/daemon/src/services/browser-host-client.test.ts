import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { browserHostSocketPath, browserHostTokenPath } from "@forge/browser-core";
import { DesktopBrowserBackend } from "./browser-host-client.js";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("DesktopBrowserBackend", () => {
  it("authenticates and exchanges Browser RPC over the local socket", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "forge-browser-client-"));
    dirs.push(dataDir);
    const token = "test-browser-token";
    writeFileSync(browserHostTokenPath(dataDir), `${token}\n`);
    const socketPath = browserHostSocketPath(dataDir);
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (raw: string) => {
        const request = JSON.parse(raw.trim());
        expect(request.token).toBe(token);
        expect(request.method).toBe("listTabs");
        socket.end(`${JSON.stringify({ id: request.id, result: [{ id: "t1", backendId: "iab", title: "Test", url: "https://example.com", active: true }] })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));

    const backend = new DesktopBrowserBackend(dataDir);
    expect(backend.isConnected()).toBe(true);
    await expect(backend.listTabs()).resolves.toEqual([
      expect.objectContaining({ id: "t1", backendId: "iab" }),
    ]);
  });

  it("surfaces errors returned by the Desktop Browser host", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "forge-browser-client-"));
    dirs.push(dataDir);
    writeFileSync(browserHostTokenPath(dataDir), "token\n");
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (raw: string) => {
        const request = JSON.parse(raw.trim());
        socket.end(`${JSON.stringify({ id: request.id, error: "tab missing" })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => server.listen(browserHostSocketPath(dataDir), resolve).once("error", reject));

    await expect(new DesktopBrowserBackend(dataDir).snapshot("missing")).rejects.toThrow("tab missing");
  });
});
