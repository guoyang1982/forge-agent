import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry, type ToolContext } from "@forge/tools";
import { attachMcpTools, McpClient } from "./index.js";

const imageServer = String.raw`
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      reply(message.id, { protocolVersion: "2024-11-05", capabilities: {} });
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: [{
        name: "get_app_state",
        inputSchema: {
          type: "object",
          properties: { app: { type: "string" } },
          required: ["app"],
        },
      }] });
    } else if (message.method === "tools/call") {
      reply(message.id, {
        content: [
          { type: "text", text: JSON.stringify(message.params.arguments) },
          { type: "image", data: Buffer.from("browser-image").toString("base64"), mimeType: "image/jpeg" },
        ],
      });
    }
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
`;

describe("attachMcpTools Computer Use screenshots", () => {
  it("saves the MCP app image inside the workspace without forwarding Forge's path argument", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "forge-mcp-image-"));
    const client = new McpClient({
      name: "computer-use",
      command: process.execPath,
      args: ["--input-type=module", "-e", imageServer],
    });
    const registry = new ToolRegistry();

    try {
      await attachMcpTools(registry, [client]);
      const definition = registry.definitions.find(
        (tool) => tool.name === "mcp_computer_use_get_app_state",
      );
      expect(definition?.parameters).toMatchObject({
        properties: { save_screenshot_to: { type: "string" } },
      });

      const guard = createTestGuard(workspace);
      const result = JSON.parse(
        await registry.execute(
          {
            id: "screenshot",
            name: "mcp_computer_use_get_app_state",
            arguments: {
              app: "com.google.Chrome",
              save_screenshot_to: "artifacts/chrome.png",
            },
          },
          {
            guard,
            emit: () => {},
            autoApply: true,
            pendingPatches: new Map(),
          } satisfies ToolContext,
        ),
      );

      expect(result).toMatchObject({
        ok: true,
        imageSavedTo: join(workspace, "artifacts/chrome.jpg"),
      });
      expect(result.result).toBe('{"app":"com.google.Chrome"}\n');
      await expect(
        readFile(join(workspace, "artifacts/chrome.jpg"), "utf8"),
      ).resolves.toBe("browser-image");
    } finally {
      client.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("rejects screenshot paths outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "forge-mcp-image-"));
    const client = new McpClient({
      name: "computer-use",
      command: process.execPath,
      args: ["--input-type=module", "-e", imageServer],
    });
    const registry = new ToolRegistry();

    try {
      await attachMcpTools(registry, [client]);
      const result = JSON.parse(
        await registry.execute(
          {
            id: "escape",
            name: "mcp_computer_use_get_app_state",
            arguments: {
              app: "com.google.Chrome",
              save_screenshot_to: "../outside.png",
            },
          },
          {
            guard: createTestGuard(workspace),
            emit: () => {},
            autoApply: true,
            pendingPatches: new Map(),
          } satisfies ToolContext,
        ),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Path not allowed");
    } finally {
      client.stop();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function createTestGuard(workspace: string): ToolContext["guard"] {
  return {
    resolveSafe(requestedPath: string) {
      const resolved = join(workspace, requestedPath);
      if (!resolved.startsWith(`${workspace}/`)) {
        throw new Error(`Path not allowed: ${resolved}`);
      }
      return resolved;
    },
  } as ToolContext["guard"];
}
