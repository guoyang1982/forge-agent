import type { ToolDefinition } from "@forge/protocol";
import type { ToolContext, ToolRegistry } from "@forge/tools";
import {
  McpClient,
  type McpServerConfig,
  type McpServerRequestHandler,
} from "./client.js";
import { loadMcpFromConfig } from "./loader.js";

export type {
  McpServerConfig,
  McpServerRequest,
  McpServerRequestHandler,
  McpToolCallOptions,
} from "./client.js";
export { McpClient } from "./client.js";
export { loadMcpFromConfig } from "./loader.js";
export {
  registryHasMcpFilesystemWrites,
} from "./filesystem.js";
export {
  McpClientPool,
  getMcpClientPool,
  clearMcpClientPool,
  mcpPoolCacheKey,
} from "./pool.js";

export async function attachMcpTools(
  registry: ToolRegistry,
  clients: McpClient[],
  options: { onServerRequest?: McpServerRequestHandler } = {},
): Promise<number> {
  let count = 0;
  for (const client of clients) {
    const tools = await client.listTools();
    for (const t of tools) {
      const localName = `${client.prefix}${t.name}`.replace(
        /[^a-zA-Z0-9_]/g,
        "_",
      );
      const supportsScreenshotSave =
        client.config.name === "computer-use" && t.name === "get_app_state";
      const parameters = supportsScreenshotSave
        ? addScreenshotSaveParameter(t.inputSchema)
        : ((t.inputSchema as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
          });
      const def: ToolDefinition = {
        name: localName,
        description:
          `[MCP:${client.config.name}] ${t.description ?? t.name}` +
          (supportsScreenshotSave
            ? " When the user asks for a screenshot file, set save_screenshot_to to a workspace-relative image path; Forge saves the app screenshot returned by Computer Use and reports the actual path."
            : ""),
        parameters,
      };
      registry.register(def, async (args, ctx) => {
        const { forwardedArgs, imageOutputPath } = prepareToolArguments(
          args,
          ctx,
          supportsScreenshotSave,
        );
        return client.callTool(t.name, forwardedArgs, {
          onServerRequest: options.onServerRequest,
          imageOutputPath,
        });
      });
      count++;
    }
  }
  return count;
}

function addScreenshotSaveParameter(
  inputSchema?: Record<string, unknown>,
): Record<string, unknown> {
  const schema = { ...(inputSchema ?? { type: "object" }) };
  const existingProperties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  schema.properties = {
    ...existingProperties,
    save_screenshot_to: {
      type: "string",
      description:
        "Optional workspace-relative .png, .jpg, or .webp path. Forge saves the application screenshot returned by Computer Use here and may correct the extension to match the returned image MIME type. Use imageSavedTo from the result as the actual path. Never use system/full-screen screenshot commands instead.",
    },
  };
  return schema;
}

function prepareToolArguments(
  args: Record<string, unknown>,
  ctx: ToolContext,
  supportsScreenshotSave: boolean,
): {
  forwardedArgs: Record<string, unknown>;
  imageOutputPath?: string;
} {
  if (!supportsScreenshotSave || !("save_screenshot_to" in args)) {
    return { forwardedArgs: args };
  }
  const { save_screenshot_to: requestedPath, ...forwardedArgs } = args;
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    throw new Error("save_screenshot_to must be a non-empty workspace path");
  }
  if (!/\.(?:png|jpe?g|webp)$/i.test(requestedPath)) {
    throw new Error("save_screenshot_to must end with .png, .jpg, or .webp");
  }
  return {
    forwardedArgs,
    imageOutputPath: ctx.guard.resolveSafe(requestedPath, "write"),
  };
}
