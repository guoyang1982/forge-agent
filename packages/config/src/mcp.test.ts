import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpServers, readUserMcpConfig, saveUserMcpConfig } from "./mcp.js";

describe("loadMcpServers", () => {
  it("returns empty when mcp.json is missing (built-in file tools used)", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mcp-"));
    expect(loadMcpServers(dir, "/any/cwd")).toEqual([]);
  });

  it("loads servers from mcp.json when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mcp-"));
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        servers: [{ name: "custom", command: "echo", args: [], enabled: true }],
      }),
    );
    const servers = loadMcpServers(dir);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("custom");
  });

  it("saves a local command and keeps env out of the result", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mcp-"));
    const saved = saveUserMcpConfig(
      dir,
      JSON.stringify({
        mcpServers: {
          docs: {
            command: "npx",
            args: ["-y", "some-mcp"],
            env: { API_TOKEN: "super-secret-value" },
            enabled: true,
          },
        },
      }),
    );
    expect(saved.names).toEqual(["docs"]);
    expect(JSON.stringify(saved)).not.toContain("super-secret-value");
    const stored = JSON.parse(readFileSync(saved.path, "utf-8")) as {
      servers: Array<{ env?: Record<string, string> }>;
    };
    expect(stored.servers[0]?.env?.API_TOKEN).toBe("super-secret-value");
    // Windows does not expose POSIX owner/group permission bits.
    if (process.platform !== "win32") {
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    }
    expect(loadMcpServers(dir)).toHaveLength(1);
  });

  it("saves a public https MCP url and rejects local or credentialed urls", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mcp-"));
    const secret = "super-secret-value";
    const saved = saveUserMcpConfig(
      dir,
      JSON.stringify({
        servers: [{ name: "kling", url: "https://klingai.com/mcp", enabled: true }],
      }),
    );
    expect(saved.names).toEqual(["kling"]);
    expect(JSON.stringify(saved)).not.toContain("access_token");
    expect(loadMcpServers(dir)[0]?.url).toBe("https://klingai.com/mcp");
    expect(() =>
      saveUserMcpConfig(
        dir,
        JSON.stringify({
          servers: [{ name: "remote", url: `https://user:${secret}@klingai.com/mcp` }],
        }),
      ),
    ).toThrow(/https/);
    try {
      saveUserMcpConfig(
        dir,
        JSON.stringify({
          servers: [{ name: "remote", url: `https://user:${secret}@klingai.com/mcp` }],
        }),
      );
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(() =>
      saveUserMcpConfig(
        dir,
        JSON.stringify({ servers: [{ name: "local", url: "http://127.0.0.1/mcp" }] }),
      ),
    ).toThrow(/https|本机/);
  });

  it("rejects remote URLs and does not echo secret-looking text", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mcp-"));
    const secret = "super-secret-value";
    expect(() =>
      saveUserMcpConfig(
        dir,
        JSON.stringify({
          servers: [{ name: "remote", command: "npx", url: `https://example.test/${secret}` }],
        }),
      ),
    ).toThrow(/只能保留一种/);
    try {
      saveUserMcpConfig(
        dir,
        JSON.stringify({
          servers: [{ name: "bad", command: "npx", env: { TOKEN: `${secret}\n` } }],
        }),
      );
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toMatch(/环境变量值无效/);
    }
    expect(readUserMcpConfig(dir).exists).toBe(false);
  });

  it("rejects shell operators in the command", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-mcp-"));
    chmodSync(dir, 0o700);
    expect(() =>
      saveUserMcpConfig(
        dir,
        JSON.stringify({ servers: [{ name: "bad", command: "sh;curl" }] }),
      ),
    ).toThrow(/shell/);
  });
});
