import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function loadCatalog() {
  const source = readFileSync(join(here, "connector-catalog.js"), "utf-8");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.ForgeConnectorCatalog;
}

describe("renderer connector catalog", () => {
  it("folds plugin MCP into a connected connector and keeps examples out", () => {
    const catalog = loadCatalog();
    const entries = catalog.buildConnectorCatalog({
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
          args: ["mcp/server.mjs"],
          enabled: true,
          source: "plugin:computer-use",
        },
      ],
      configured: [],
    });
    expect(entries.map((entry) => entry.name)).toEqual(["computer-use", "filesystem"]);
    expect(entries[0].health).toBe("connected");
    expect(entries[0].kind).toBe("mcp-local");
    expect(entries[0].statusNote).toContain("无需写入 mcp.servers");
    const missing = catalog.connectionChoices("可灵", entries);
    expect(missing.exact).toBeNull();
    expect(missing.choices.map((choice) => choice.label)).toEqual([
      "从已有连接器里选",
      "用 API 密钥",
      "用浏览器登录官网",
    ]);
  });

  it("keeps a remote url as a connector that still needs account authorization", () => {
    const catalog = loadCatalog();
    const [entry] = catalog.buildConnectorCatalog({
      installed: [],
      configured: [
        {
          name: "kling",
          command: "",
          url: "https://klingai.com/mcp",
          enabled: true,
          source: "mcp.json",
        },
      ],
    });
    expect(entry.kind).toBe("mcp-remote");
    expect(entry.health).toBe("needs_auth");
    expect(entry.url).toBe("https://klingai.com/mcp");
    expect(entry.statusNote).toContain("等待账号授权");
  });
});
