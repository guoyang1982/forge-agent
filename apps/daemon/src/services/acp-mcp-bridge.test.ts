import { describe, expect, it } from "vitest";
import { toAcpMcpServer } from "./acp-mcp-bridge.js";

describe("ACP MCP bridge", () => {
  it("resolves plugin-relative executable commands against the plugin cwd", () => {
    const server = toAcpMcpServer({
      name: "computer-use",
      command: "./Computer Use.app/Contents/MacOS/Client",
      args: ["mcp"],
      cwd: "/plugins/computer-use",
    });

    expect(server.command).toBe(
      "/plugins/computer-use/Computer Use.app/Contents/MacOS/Client",
    );
    expect(server.args).toEqual(["mcp"]);
  });

  it("keeps PATH-resolved commands unchanged", () => {
    expect(
      toAcpMcpServer({
        name: "demo",
        command: "node",
        args: ["server.mjs"],
        cwd: "/plugins/demo",
      }).command,
    ).toBe("node");
  });
});
