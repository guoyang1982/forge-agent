import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { COMPANY_WINDOW_OPTIONS } from "./host.js";
import { createCompanyPreloadApi } from "./preload-api.js";

const rendererDir = join(import.meta.dirname, "renderer");

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

describe("company renderer guardrails", () => {
  const markup = readFileSync(join(rendererDir, "index.html"), "utf8");
  const app = readFileSync(join(rendererDir, "app.js"), "utf8");

  it("does not offer L3 or L4 autonomy when hiring", () => {
    expect(markup).not.toMatch(/<option[^>]+value=["'](?:3|4)["']/);
  });

  it("renders the organization from departments", () => {
    expect(app).toMatch(/payload\?\.departments/);
  });

  it("only allows an independent identified actor to approve", () => {
    const helper = app.match(/function canApprove\(actorId, assigneeId\) \{[\s\S]*?\n\}/)?.[0];
    expect(helper).toBeTruthy();
    const canApprove = Function(`return (${helper})`)() as (
      actorId: string,
      assigneeId: string,
    ) => boolean;

    expect(canApprove("", "emp_1")).toBe(false);
    expect(canApprove("emp_1", "emp_1")).toBe(false);
    expect(canApprove("emp_2", "emp_1")).toBe(true);
  });
});
