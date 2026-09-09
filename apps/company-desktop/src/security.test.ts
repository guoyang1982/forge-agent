import { describe, expect, it, vi } from "vitest";
import { COMPANY_WINDOW_OPTIONS } from "./host.js";
import { createCompanyPreloadApi } from "./preload-api.js";

function fakeIpc() {
  return {
    invoke: vi.fn(async () => ({ ok: true })),
    on() {},
    off() {},
  };
}

describe("company desktop security boundary", () => {
  it("uses isolation and disables renderer node integration", () => {
    expect(COMPANY_WINDOW_OPTIONS.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
    });
  });

  it("exposes only invoke subscribe openWorkbench getAppInfo", () => {
    expect(Object.keys(createCompanyPreloadApi(fakeIpc()))).toEqual([
      "invoke",
      "subscribe",
      "openWorkbench",
      "getAppInfo",
    ]);
  });

  it("rejects unknown invoke methods", async () => {
    const api = createCompanyPreloadApi(fakeIpc());
    await expect(api.invoke("run")).rejects.toThrow("blocked method: run");
  });

  it("allows company.create via invoke", async () => {
    const ipc = fakeIpc();
    const api = createCompanyPreloadApi(ipc);
    await api.invoke("company.create", { name: "曜石" });
    expect(ipc.invoke).toHaveBeenCalledWith("company:invoke", "company.create", { name: "曜石" });
  });
});
