import { describe, expect, it, vi } from "vitest";
import { BrowserService, type BrowserBackend } from "./index.js";

function backend(id = "iab"): BrowserBackend {
  return {
    id,
    label: "Forge Browser",
    capabilities: { existingTabs: false, persistentSession: true, domSnapshot: true, screenshot: true, downloads: false },
    isConnected: () => true,
    listTabs: vi.fn(async () => [{ id: "tab-1", backendId: id, title: "Example", url: "https://example.com", active: true }]),
    open: vi.fn(async () => ({ id: "tab-1", backendId: id, title: "Example", url: "https://example.com", active: true })),
    navigate: vi.fn(async (input) => ({ id: input.tabId, backendId: id, title: "Next", url: input.url, active: true })),
    snapshot: vi.fn(async (tabId) => ({ tabId, backendId: id, title: "Example", url: "https://example.com", elements: [{ ref: "e1", role: "button", name: "Continue" }] })),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    screenshot: vi.fn(async (tabId) => ({ tabId, backendId: id, mime: "image/png" as const, data: "aW1hZ2U=" })),
    close: vi.fn(async () => undefined),
  };
}

describe("BrowserService", () => {
  it("routes the common browser contract through the default backend", async () => {
    const service = new BrowserService();
    const iab = backend();
    service.registerBackend(iab, { makeDefault: true });
    await expect(service.listTabs()).resolves.toHaveLength(1);
    await expect(service.open({ url: "https://example.com" })).resolves.toMatchObject({ backendId: "iab" });
    await expect(service.snapshot("tab-1")).resolves.toMatchObject({ elements: [{ ref: "e1" }] });
  });

  it("reports independent disconnected backends", () => {
    const service = new BrowserService();
    service.registerBackend(backend("iab"), { makeDefault: true });
    const chrome = backend("chrome");
    chrome.isConnected = () => false;
    service.registerBackend(chrome);
    expect(service.listBackends()).toEqual([
      expect.objectContaining({ id: "iab", connected: true }),
      expect.objectContaining({ id: "chrome", connected: false }),
    ]);
    expect(() => service.open({ backendId: "chrome" })).toThrow(/disconnected/);
  });
});
