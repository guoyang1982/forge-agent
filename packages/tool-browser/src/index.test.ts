import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserService, type BrowserBackend } from "@forge/browser-core";
import { DEFAULT_PERMISSIONS } from "@forge/protocol";
import { ToolRegistry } from "@forge/tools";
import { WorkspaceGuard } from "@forge/workspace";
import { registerBrowserTools } from "./index.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup(interact: "allow" | "confirm" | "deny" = "allow") {
  const cwd = mkdtempSync(join(tmpdir(), "forge-browser-tools-"));
  dirs.push(cwd);
  const backend: BrowserBackend = {
    id: "iab", label: "Forge Browser",
    capabilities: { existingTabs: false, persistentSession: true, domSnapshot: true, screenshot: true, downloads: false },
    isConnected: () => true,
    listTabs: vi.fn(async () => []),
    open: vi.fn(async ({ url }) => ({ id: "t1", backendId: "iab", title: "", url: url ?? "about:blank", active: true })),
    navigate: vi.fn(async ({ tabId, url }) => ({ id: tabId, backendId: "iab", title: "", url, active: true })),
    snapshot: vi.fn(async (tabId) => ({ tabId, backendId: "iab", title: "", url: "https://example.com", elements: [] })),
    click: vi.fn(async () => undefined), type: vi.fn(async () => undefined),
    screenshot: vi.fn(async (tabId) => ({ tabId, backendId: "iab", mime: "image/png" as const, data: Buffer.from("png").toString("base64") })),
    close: vi.fn(async () => undefined),
  };
  const browser = new BrowserService();
  browser.registerBackend(backend, { makeDefault: true });
  const registry = new ToolRegistry();
  registerBrowserTools(registry, { browser, permissions: { ...DEFAULT_PERMISSIONS.browser, enabled: true, interact } });
  const context = { guard: new WorkspaceGuard(cwd), emit: vi.fn(), autoApply: false, pendingPatches: new Map<string, string>(), confirmCommand: vi.fn(async () => true) };
  return { backend, cwd, registry, context };
}

describe("registerBrowserTools", () => {
  it("registers only when Forge Browser is enabled", () => {
    const registry = new ToolRegistry();
    expect(registerBrowserTools(registry, { browser: new BrowserService(), permissions: { ...DEFAULT_PERMISSIONS.browser, enabled: false } })).toBe(0);
    expect(registry.definitions).toHaveLength(0);
  });

  it("confirms interactions and saves screenshots inside the workspace", async () => {
    const { backend, cwd, registry, context } = setup("confirm");
    await registry.execute({ id: "1", name: "browser_click", arguments: { tab_id: "t1", ref: "e1" } }, context);
    expect(context.confirmCommand).toHaveBeenCalledWith("浏览器点击操作");
    expect(backend.click).toHaveBeenCalled();
    const result = JSON.parse(await registry.execute({ id: "2", name: "browser_screenshot", arguments: { tab_id: "t1", save_to: "shots/page.jpg" } }, context));
    expect(result.imageSavedTo).toBe(join(cwd, "shots/page.png"));
    expect(readFileSync(result.imageSavedTo, "utf8")).toBe("png");
  });

  it("rejects non-web navigation and denied interactions", async () => {
    const { registry, context } = setup("deny");
    await expect(registry.execute({ id: "1", name: "browser_navigate", arguments: { tab_id: "t1", url: "file:///etc/passwd" } }, context)).resolves.toContain("Only HTTP(S)");
    await expect(registry.execute({ id: "2", name: "browser_click", arguments: { tab_id: "t1", ref: "e1" } }, context)).resolves.toContain("permission denied");
  });
});
