import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { BrowserService } from "@forge/browser-core";
import type { BrowserPermissions, PermissionLevel, ToolDefinition } from "@forge/protocol";
import type { ToolContext, ToolRegistry } from "@forge/tools";

export interface RegisterBrowserToolsOptions { browser: BrowserService; permissions?: BrowserPermissions; }

const definitions: ToolDefinition[] = [
  { name: "browser_list_backends", description: "List Forge Browser backends and their capabilities.", parameters: { type: "object", properties: {} } },
  { name: "browser_list_tabs", description: "List open tabs in Forge Browser or an optional backend.", parameters: { type: "object", properties: { backend_id: { type: "string" } } } },
  { name: "browser_open", description: "Open a visible Forge Browser tab.", parameters: { type: "object", properties: { backend_id: { type: "string" }, url: { type: "string" } } } },
  { name: "browser_navigate", description: "Navigate an existing browser tab to an HTTP(S) URL.", parameters: { type: "object", properties: { backend_id: { type: "string" }, tab_id: { type: "string" }, url: { type: "string" } }, required: ["tab_id", "url"] } },
  { name: "browser_snapshot", description: "Read a normalized DOM/accessibility snapshot with stable element refs.", parameters: { type: "object", properties: { backend_id: { type: "string" }, tab_id: { type: "string" } }, required: ["tab_id"] } },
  { name: "browser_click", description: "Click an element ref returned by browser_snapshot.", parameters: { type: "object", properties: { backend_id: { type: "string" }, tab_id: { type: "string" }, ref: { type: "string" } }, required: ["tab_id", "ref"] } },
  { name: "browser_type", description: "Type into an element ref returned by browser_snapshot.", parameters: { type: "object", properties: { backend_id: { type: "string" }, tab_id: { type: "string" }, ref: { type: "string" }, text: { type: "string" }, clear: { type: "boolean" } }, required: ["tab_id", "ref", "text"] } },
  { name: "browser_screenshot", description: "Capture a browser tab and save it inside the current workspace.", parameters: { type: "object", properties: { backend_id: { type: "string" }, tab_id: { type: "string" }, save_to: { type: "string" } }, required: ["tab_id", "save_to"] } },
  { name: "browser_close", description: "Close a browser tab.", parameters: { type: "object", properties: { backend_id: { type: "string" }, tab_id: { type: "string" } }, required: ["tab_id"] } },
];

export function registerBrowserTools(registry: ToolRegistry, options: RegisterBrowserToolsOptions): number {
  if (options.permissions?.enabled !== true) return 0;
  const [listBackends, listTabs, open, navigate, snapshot, click, type, screenshot, close] = definitions;
  registry.register(listBackends!, async () => JSON.stringify({ backends: options.browser.listBackends() }));
  registry.register(listTabs!, async (args) => JSON.stringify({ tabs: await options.browser.listTabs(optionalString(args.backend_id)) }));
  registry.register(open!, async (args, ctx) => {
    const url = optionalString(args.url);
    if (url) assertWebUrl(url);
    await requirePermission(options.permissions!.open, ctx, `打开浏览器${url ? `：${url}` : ""}`);
    return JSON.stringify(await options.browser.open({ backendId: optionalString(args.backend_id), url }));
  });
  registry.register(navigate!, async (args, ctx) => {
    const url = requiredString(args.url, "url");
    assertWebUrl(url);
    await requirePermission(options.permissions!.open, ctx, `浏览器导航：${url}`);
    return JSON.stringify(await options.browser.navigate({ backendId: optionalString(args.backend_id), tabId: requiredString(args.tab_id, "tab_id"), url }));
  });
  registry.register(snapshot!, async (args) => JSON.stringify(await options.browser.snapshot(requiredString(args.tab_id, "tab_id"), optionalString(args.backend_id))));
  registry.register(click!, async (args, ctx) => {
    await requirePermission(options.permissions!.interact, ctx, "浏览器点击操作");
    await options.browser.click({ backendId: optionalString(args.backend_id), tabId: requiredString(args.tab_id, "tab_id"), ref: requiredString(args.ref, "ref") });
    return JSON.stringify({ ok: true });
  });
  registry.register(type!, async (args, ctx) => {
    await requirePermission(options.permissions!.interact, ctx, "浏览器输入操作");
    await options.browser.type({ backendId: optionalString(args.backend_id), tabId: requiredString(args.tab_id, "tab_id"), ref: requiredString(args.ref, "ref"), text: String(args.text ?? ""), clear: args.clear !== false });
    return JSON.stringify({ ok: true });
  });
  registry.register(screenshot!, async (args, ctx) => {
    const image = await options.browser.screenshot(requiredString(args.tab_id, "tab_id"), optionalString(args.backend_id));
    const requested = requiredString(args.save_to, "save_to");
    const extension = image.mime === "image/jpeg" ? ".jpg" : ".png";
    const saveTo = extname(requested).toLowerCase() === extension ? requested : `${requested.replace(/\.[^/.]+$/, "")}${extension}`;
    const absolute = ctx.guard.resolveSafe(saveTo, "write");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(image.data, "base64"));
    return JSON.stringify({ ok: true, imageSavedTo: absolute, mime: image.mime, width: image.width, height: image.height });
  });
  registry.register(close!, async (args, ctx) => {
    await requirePermission(options.permissions!.interact, ctx, "关闭浏览器标签");
    await options.browser.close(requiredString(args.tab_id, "tab_id"), optionalString(args.backend_id));
    return JSON.stringify({ ok: true });
  });
  return definitions.length;
}

async function requirePermission(level: PermissionLevel, ctx: ToolContext, summary: string): Promise<void> {
  if (level === "allow") return;
  if (level === "deny") throw new Error(`Browser permission denied: ${summary}`);
  if (!ctx.confirmCommand || !(await ctx.confirmCommand(summary))) throw new Error(`Browser permission not granted: ${summary}`);
}

function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function requiredString(value: unknown, name: string): string { const parsed = optionalString(value); if (!parsed) throw new Error(`${name} is required`); return parsed; }
function assertWebUrl(value: string): void { const url = new URL(value); if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) browser URLs are allowed"); }
