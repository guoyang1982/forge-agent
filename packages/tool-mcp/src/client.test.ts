import { describe, expect, it } from "vitest";
import { McpClient } from "./client.js";

const mockServer = String.raw`
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
      reply(message.id, { tools: [{ name: "hang", inputSchema: { type: "object" } }] });
    } else if (message.method === "tools/call") {
      // Deliberately never reply. The client must invalidate this transport.
    }
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
`;

const elicitingServer = String.raw`
let buffer = "";
let toolCallId;
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
      reply(message.id, { tools: [{ name: "protected", inputSchema: { type: "object" } }] });
    } else if (message.method === "tools/call") {
      toolCallId = message.id;
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: "permission-1",
        method: "elicitation/create",
        params: { message: "Allow app access?", requestedSchema: { type: "object" } },
      }) + "\n");
    } else if (message.id === "permission-1" && message.result?.action === "accept") {
      setTimeout(() => reply(toolCallId, {
        content: [{ type: "text", text: "allowed" }],
      }), 30);
    }
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
`;

describe("McpClient transport recovery", () => {
  it("invalidates a timed-out process and starts a fresh one on the next call", async () => {
    const client = new McpClient(
      {
        name: "hung-probe",
        command: process.execPath,
        args: ["--input-type=module", "-e", mockServer],
      },
      { requestTimeoutMs: 300 },
    );

    try {
      await client.start();
      await expect(client.callTool("hang", {})).rejects.toThrow(
        "MCP timeout: tools/call",
      );
      expect(client.isRunning()).toBe(false);

      await expect(client.listTools()).resolves.toEqual([
        { name: "hang", inputSchema: { type: "object" } },
      ]);
      expect(client.isRunning()).toBe(true);
    } finally {
      client.stop();
    }
  });

  it("answers server elicitation without timing out the parent tool call", async () => {
    const client = new McpClient(
      {
        name: "elicitation-probe",
        command: process.execPath,
        args: ["--input-type=module", "-e", elicitingServer],
      },
      { requestTimeoutMs: 50, serverRequestTimeoutMs: 500 },
    );

    try {
      await expect(
        client.callTool("protected", {}, {
          onServerRequest: async (request) => {
            expect(request.method).toBe("elicitation/create");
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { action: "accept", content: {} };
          },
        }),
      ).resolves.toBe('{"ok":true,"result":"allowed"}');
    } finally {
      client.stop();
    }
  });

  it("calls a remote MCP with the bearer token and reads an SSE tool list", async () => {
    const token = "remote-access-token";
    const original = globalThis.fetch;
    const authorizations: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authorizations.push(headers.get("authorization") || "");
      const body = JSON.parse(String(init?.body)) as { id?: number; method?: string };
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
          headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
        });
      }
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "generate", description: "生成" }] },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const client = new McpClient({
      name: "kling",
      url: "https://klingai.com/mcp",
      authorization: token,
    });
    try {
      await expect(client.listTools()).resolves.toEqual([
        { name: "generate", description: "生成" },
      ]);
      expect(authorizations.every((value) => value === `Bearer ${token}`)).toBe(true);
    } finally {
      client.stop();
      globalThis.fetch = original;
    }
  });
});
