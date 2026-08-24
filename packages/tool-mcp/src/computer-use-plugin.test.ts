import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const serverPath = fileURLToPath(
  new URL("../../../plugins/computer-use/mcp/server.mjs", import.meta.url),
);

describe("Forge Computer Use MCP plugin", () => {
  let child: ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  it("advertises accessibility and pointer tools without requiring the macOS runtime at startup", async () => {
    child = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const call = createRpcClient(child);

    await call("initialize", {});
    const result = (await call("tools/list", {})) as {
      tools: Array<{
        name: string;
        inputSchema: {
          required?: string[];
          properties?: Record<string, unknown>;
        };
      }>;
    };
    const names = result.tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "list_apps",
        "open_app",
        "get_app_state",
        "click",
        "drag",
        "type_text",
        "set_value",
        "select_text",
        "perform_secondary_action",
        "scroll",
      ]),
    );
    expect(result.tools.find((tool) => tool.name === "get_app_state")?.inputSchema.properties)
      .toMatchObject({
        include_accessibility: expect.any(Object),
        max_elements: expect.objectContaining({ description: expect.stringContaining("Defaults to 100") }),
        accessibility_format: expect.objectContaining({ enum: ["compact", "structured", "both"] }),
        time_budget_ms: expect.objectContaining({ maximum: 20_000 }),
      });
    expect(result.tools.find((tool) => tool.name === "click")?.inputSchema.required)
      .toEqual(["app"]);
    expect(result.tools.find((tool) => tool.name === "click")?.inputSchema.properties)
      .toMatchObject({ element_index: expect.any(Object), snapshot_id: expect.any(Object) });
  });

  it("keeps accessibility snapshots bounded and compact by default", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(serverPath, "utf8"));

    expect(source).toContain('Number(argv[1] || 100)');
    expect(source).toContain('Number(argv[2] || 18000)');
    expect(source).toContain('visit(frontWindow, { root: "window"');
    expect(source).toContain('return stop("time_budget")');
    expect(source).toContain('? options.accessibility_format\n    : "compact"');
    expect(source).toContain("do not retry with a larger max_elements");
    expect(source).toContain('permissionScope = "apps.control"');
    expect(source).toContain('"apps.open"');
    expect(source).toContain("[...key].length !== 1");
    expect(source).toContain("keystroke keyText");
    expect(source).toContain("set savedClipboard to the clipboard as record");
    expect(source).toContain('keystroke "v" using command down');
    expect(source).toContain("set the clipboard to savedClipboard");
  });
});

function createRpcClient(child: ChildProcessWithoutNullStreams) {
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message ?? "MCP error"));
    else request.resolve(message.result);
  });
  child.once("exit", (code) => {
    for (const request of pending.values()) {
      request.reject(new Error(`Computer Use MCP exited before replying (${code})`));
    }
    pending.clear();
  });

  return (method: string, params: Record<string, unknown>) => {
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
}
