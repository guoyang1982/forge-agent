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

  it("derives a missing plan gate from an accepted spec", () => {
    const helper = app.match(/function pipelineGate\(item\) \{[\s\S]*?\n\}/)?.[0];
    expect(helper).toBeTruthy();
    const pipelineGate = Function(`return (${helper})`)() as (
      item: Record<string, unknown>,
    ) => string;

    expect(pipelineGate({ state: "draft", specVersion: 1 })).toBe("缺 plan");
  });

  it("renders a workbench run button for linked work items", () => {
    const escapeHelper = app.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/)?.[0];
    const buttonHelper = app.match(/function workItemRunButton\(item\) \{[\s\S]*?\n\}/)?.[0];
    expect(escapeHelper).toBeTruthy();
    expect(buttonHelper).toBeTruthy();
    const workItemRunButton = Function(
      `${escapeHelper}\n${buttonHelper}\nreturn workItemRunButton;`,
    )() as (item: Record<string, unknown>) => string;

    expect(workItemRunButton({ runIds: ["run_123"] })).toContain(
      'data-open-run="run_123"',
    );
    expect(workItemRunButton({ runIds: ["run_123"] })).toContain("在工作台打开");
    expect(workItemRunButton({ runIds: [] })).toBe("");
  });

  it("shows the delivery chain and only marks complete traces delivered", () => {
    const escapeHelper = app.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/)?.[0];
    const deliveredHelper = app.match(/function canMarkDelivered\(trace\) \{[\s\S]*?\n\}/)?.[0];
    const traceHelper = app.match(/function deliveryTraceHtml\(item\) \{[\s\S]*?\n\}/)?.[0];
    expect(escapeHelper).toBeTruthy();
    expect(deliveredHelper).toBeTruthy();
    expect(traceHelper).toBeTruthy();
    const deliveryTraceHtml = Function(
      `${escapeHelper}\n${deliveredHelper}\n${traceHelper}\nreturn deliveryTraceHtml;`,
    )() as (item: Record<string, unknown>) => string;

    const incomplete = deliveryTraceHtml({
      id: "work_1",
      trace: {
        workItemId: "work_1",
        specVersion: 1,
        runIds: [],
        artifactIds: ["artifact_intent", "artifact_spec"],
        validationIds: [],
      },
    });
    expect(incomplete).toContain(
      "work_1 → spec v1 → plan — → run/artifact artifact_intent, artifact_spec → 验证证据 无",
    );
    expect(incomplete).not.toContain("已交付");

    const completeTrace = {
      id: "work_1",
      trace: {
        workItemId: "work_1",
        specVersion: 1,
        planVersion: 2,
        runIds: ["run_1"],
        artifactIds: ["artifact_intent", "artifact_spec", "artifact_plan"],
        validationIds: ["validation_1"],
      },
    };
    const waitingApproval = deliveryTraceHtml({
      ...completeTrace,
      state: "waiting_approval",
    });
    expect(waitingApproval).toContain(
      "work_1 → spec v1 → plan v2 → run/artifact run_1 → 验证证据 validation_1",
    );
    expect(waitingApproval).not.toContain("已交付");
    expect(deliveryTraceHtml({ ...completeTrace, state: "accepted" })).toContain(
      "已交付",
    );
  });
});
