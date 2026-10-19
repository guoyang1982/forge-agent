import { describe, expect, it } from "vitest";
import { buildConnectorCatalog, connectionChoices, mcpRowToConnector } from "./catalog.js";

describe("connector catalog", () => {
  it("maps a plugin MCP server to a connected local connector", () => {
    const entry = mcpRowToConnector({
      name: "computer-use",
      command: "node",
      args: ["mcp/server.mjs"],
      enabled: true,
      source: "plugin:computer-use",
    });
    expect(entry.kind).toBe("mcp-local");
    expect(entry.source).toBe("plugin");
    expect(entry.health).toBe("connected");
    expect(entry.statusNote).toContain("无需写入 mcp.servers");
    expect(entry.examples.length).toBeGreaterThan(0);
  });

  it("keeps examples disconnected and lists plugin servers before them", () => {
    const catalog = buildConnectorCatalog({
      installed: [
        {
          name: "filesystem",
          command: "npx",
          args: ["server"],
          enabled: false,
          source: "mcp.json.example",
        },
        {
          name: "computer-use",
          command: "node",
          args: [],
          enabled: true,
          source: "plugin:computer-use",
        },
      ],
      configured: [],
    });
    expect(catalog.map((item) => item.name)).toEqual(["computer-use", "filesystem"]);
    expect(catalog[1]?.health).toBe("disconnected");
    expect(catalog[1]?.enabled).toBe(false);
  });

  it("offers an existing connector, an API key, or browser login", () => {
    const catalog = buildConnectorCatalog({
      installed: [
        {
          name: "computer-use",
          command: "node",
          enabled: true,
          source: "plugin:computer-use",
        },
      ],
    });
    const found = connectionChoices("computer-use", catalog);
    expect(found.exact?.id).toContain("computer-use");
    expect(found.choices.map((choice) => choice.id)).toEqual([
      "existing",
      "api-key",
      "browser",
    ]);
    const missing = connectionChoices("可灵", catalog);
    expect(missing.exact).toBeNull();
    expect(missing.choices[1]?.label).toBe("用 API 密钥");
    expect(missing.choices[2]?.label).toBe("用浏览器登录官网");
  });
});
