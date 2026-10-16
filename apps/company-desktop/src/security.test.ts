import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DAEMON_COMPANY_METHODS } from "@forge/protocol";
import { COMPANY_WINDOW_OPTIONS } from "./host.js";
import { COMPANY_INVOKE_METHODS, createCompanyPreloadApi } from "./preload-api.js";

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

  it("exposes only invoke subscribe openWorkbench getAppInfo onOpenWork", () => {
    expect(Object.keys(createCompanyPreloadApi(fakeIpc()))).toEqual([
      "invoke",
      "subscribe",
      "openWorkbench",
      "getAppInfo",
      "onOpenWork",
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

  it("keeps CJS preload off the ESM-only protocol package", () => {
    const source = readFileSync(join(import.meta.dirname, "preload-api.ts"), "utf8");
    expect(source).not.toMatch(/from ["']@forge\/protocol["']/);
    expect([...COMPANY_INVOKE_METHODS].sort()).toEqual(
      Object.values(DAEMON_COMPANY_METHODS).sort(),
    );
  });

  it("compiled company preload loads as CommonJS", () => {
    const dist = join(import.meta.dirname, "../dist");
    const preload = readFileSync(join(dist, "preload.cjs"), "utf8");
    expect(preload).toMatch(/require\(["']\.\/preload-api\.cjs["']\)/);
    const req = createRequire(join(dist, "preload.cjs"));
    expect(typeof req("./preload-api.cjs").createCompanyPreloadApi).toBe("function");
  });
});

describe("company renderer guardrails", () => {
  const markup = readFileSync(join(rendererDir, "index.html"), "utf8");
  const app = readFileSync(join(rendererDir, "app.js"), "utf8");
  const css = readFileSync(join(rendererDir, "styles.css"), "utf8");

  it("keeps a toast host so actions can report success and failure", () => {
    expect(markup).toContain('id="toast"');
    expect(app).toMatch(/if \(!element\) return;/);
  });

  it("lets document pages scroll instead of clipping the canvas", () => {
    expect(markup).toMatch(/class="page page-scroll"[^>]*data-page="overview"/);
    expect(markup).toMatch(/class="page hidden page-scroll"[^>]*data-page="delivery"/);
    expect(markup).toMatch(/class="page hidden page-fill"[^>]*data-page="organization"/);
    expect(markup).toMatch(/class="page hidden page-fill"[^>]*data-page="work"/);
    expect(markup).toMatch(/class="page hidden page-fill"[^>]*data-page="approvals"/);
    expect(markup).toContain("overview-grid");
    expect(markup).toContain("delivery-stack");
    expect(markup).toContain("deliveryLoopSteps");
    expect(markup).toContain("workLoopSteps");
    expect(markup).toMatch(/id="approvalList"[\s\S]*id="approvalHistory"/);
    expect(css).toMatch(/\.page-scroll\s*\{[^}]*overflow:\s*auto/);
    expect(css).toMatch(/\.page-fill\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.delivery-grid[\s\S]*?align-content:\s*start/);
    expect(css).toMatch(/\.overview-grid\s*\{/);
    expect(css).toMatch(/\.stage-block\.is-current/);
  });

  it("renders company documents with the Workbench markdown preview", () => {
    expect(markup).toContain("markdown-preview.bundle.js");
    expect(css).toMatch(/\.md-preview\s*\{/);
    expect(css).toMatch(/\.md-preview table\s*\{/);
  });

  it("keeps delivery execution history out of a second work-item dump", () => {
    expect(markup).not.toContain("deliveryTimelineHost");
    expect(app).not.toMatch(/function deliveryTimelineSteps/);
    expect(css).toMatch(/\.workspace-files\s*\{/);
  });

  it("does not offer L3 or L4 autonomy when hiring", () => {
    expect(markup).not.toMatch(/<option[^>]+value=["'](?:3|4)["']/);
  });

  it("keeps the CEO inbox as a draft-only intake", () => {
    expect(markup).toMatch(/只能把需求记成 draft|不会过规格、计划/);
    expect(app).toMatch(/\$\("#ceoForm"\)[\s\S]*createDemand/);
    expect(app).toMatch(/showPage\("work"\)/);
  });

  it("lets an operator pick a draft and continue the work chain", () => {
    expect(markup).toContain("workInbox");
    expect(app).toMatch(/function selectWorkItem\(item\)/);
    expect(app).toContain('gateForm [name=workItemId]');
    expect(app).toContain("data-select-work");
    expect(app).toMatch(/if \(value == null \|\| value === ""\) continue;/);
    expect(app).toMatch(/function draftSpecFromDemand\(item\)/);
    expect(app).toContain('gateForm [name=spec]');
    expect(app).toContain("item.specDraft || draftSpecFromDemand(item)");
    expect(markup).toContain("drafterId");
    expect(markup).toContain("模型代写");
    expect(app).toContain("company.workArtifacts.draft");
    expect(app).toMatch(/function pickDefaultDrafterId\(item\)/);
    expect(app).toMatch(/function pickDefaultAssigneeId\(item\)/);
    expect(app).toContain("RESEARCH_ROLE_PATTERN");
    expect(app).toContain("SEAT_TALENT_BY_TITLE");
    expect(app).toContain("市场调查员");
    expect(app).toContain("product-trend-researcher");
    expect(app).toContain("talentTemplateId");
    expect(app).toMatch(/function suggestedTalentId\(title\) \{[\s\S]*?SEAT_TALENT_BY_TITLE/);
    expect(markup).toContain("按人才包起草");
    expect(markup).toMatch(/设置 → 模型配置/);
    expect(app).toContain("正在调用模型");
    expect(app).toContain("已按所选员工人才包起草");
    expect(app).toContain("result.talentRole");
    expect(app).toContain("result.error");
    expect(app).toContain("模型起草失败");
  });

  it("shows the reviewer preview conclusion and still requires a human confirm", () => {
    expect(app).toContain("company.workItems.previewApproval");
    const escapeHelper = app.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/)?.[0];
    const previewHelper = app.match(/function approvalPreviewHtml\(preview\) \{[\s\S]*?\n\}/)?.[0];
    expect(escapeHelper).toBeTruthy();
    expect(previewHelper).toBeTruthy();
    const approvalPreviewHtml = Function(
      `${escapeHelper}\n${previewHelper}\nreturn approvalPreviewHtml;`,
    )() as (preview: Record<string, unknown> | undefined) => string;
    const html = approvalPreviewHtml({
      reviewerName: "沈清",
      talentRole: "质量负责人",
      recommendation: "approved",
      summary: "对照验收通过",
      findings: ["总览可见"],
    });
    expect(html).toContain("沈清");
    expect(html).toContain("建议通过");
    expect(html).toContain("对照验收通过");
    expect(html).not.toContain("已自动批准");
    expect(app).toContain("fixWorkItem");
    expect(app).toContain("驳回并开修复单");
    expect(app).toContain("已验收关闭");
    expect(app).toContain("已带入原文和驳回点");
    expect(app).toMatch(/decision === "approved"/);
    expect(app).toContain("state.decisions");
    expect(app).toContain("审批记录");
    expect(app).toContain("onOpenWork");
    expect(app).toContain("openFix");
    expect(app).toContain("等待输入");
    expect(app).toContain("无测试证据");
  });

  it("renders the organization from departments", () => {
    expect(app).toMatch(/payload\?\.departments/);
  });

  it("onboards employees through company RPCs without hiring workbench talents", () => {
    expect(markup).toContain("talentTemplateId");
    expect(markup).toContain("modelProfileId");
    expect(markup).toContain("执行模型");
    expect(markup).toContain("bindForm");
    expect(markup).toContain("class=\"split\"");
    expect(markup).toContain("orgIdle");
    expect(markup).toContain("data-staff-panel");
    expect(app).toContain("company.employees.onboard");
    expect(app).toContain("company.employees.bind");
    expect(app).not.toContain("talents.hire");
    expect(app).toContain("workspace-row");
    expect(app).toContain("org-vacant");
    expect(app).toMatch(/function workspaceName\(path\)/);
    expect(app).toMatch(/function mergeEmployees\(/);
    expect(app).toMatch(/mergeEmployees\(\s*state\.employees,/);
    expect(app).toContain("applyDemoSeedForms");
    expect(markup).toContain("workspaceModal");
    expect(markup).toContain("workspace-search");
    expect(markup).toContain("workspace-open");
    expect(markup).toContain("bindBoundSkills");
    expect(markup).toContain("bindKit");
    expect(markup).toContain("metricGoals");
    expect(markup).toContain("ceoBrief");
    expect(markup).toContain("goalForm");
    expect(markup).toContain("projectForm");
    expect(markup).toContain("projectWorkspaceForm");
    expect(app).toContain("company.ceo.brief");
    expect(app).toContain("company.goals.create");
    expect(app).toContain("company.projects.create");
    expect(app).toContain("company.projects.bindWorkspaces");
    expect(app).toContain("knowledgeRefs");
    expect(app).toContain("select.ws-env");
    expect(app).toContain("employee.memories");
    expect(app).toContain("qualityGates");
    expect(markup).toContain('data-nav="delivery"');
    expect(markup).toContain("deliveryIntakeHost");
    expect(markup).toContain("features/delivery/delivery-ui.js");
    expect(app).toContain("company.delivery.gates.decide");
    expect(app).toContain("openWorkbenchTakeover");
    expect(app).toMatch(/function renderDelivery\(/);
    expect(app).toMatch(/function employeeBoundSkillsHtml\(/);
    expect(app).toMatch(/function employeeKitHtml\(/);
    expect(app).toMatch(/function formatSkillList\(/);
    expect(app).toMatch(/function talentOptionLabel\(talent\) \{[\s\S]*?formatSkillList/);
    expect(app).toMatch(/memories: Array.isArray\(employee.memories\)/);
  });

  it("filters and pages project directories in the picker modal", () => {
    const nameHelper = app.match(/function workspaceName\(path\) \{[\s\S]*?\n\}/)?.[0];
    const searchHelper = app.match(/function workspaceSearchText\(workspace\) \{[\s\S]*?\n\}/)?.[0];
    const filterHelper = app.match(/function filterWorkspaces\([\s\S]*?\n\}/)?.[0];
    const pageHelper = app.match(/function pageWorkspaces\([\s\S]*?\n\}/)?.[0];
    expect(nameHelper && searchHelper && filterHelper && pageHelper).toBeTruthy();
    const helpers = Function(
      `${nameHelper}\n${searchHelper}\n${filterHelper}\n${pageHelper}\nreturn { filterWorkspaces, pageWorkspaces };`,
    )() as {
      filterWorkspaces: (
        workspaces: Array<{ id: string; label?: string; rootPath?: string }>,
        query?: string,
        scope?: string,
        grantedIds?: string[],
        defaultId?: string,
      ) => Array<{ id: string }>;
      pageWorkspaces: <T>(items: T[], page?: number, pageSize?: number) => {
        items: T[];
        page: number;
        total: number;
        count: number;
      };
    };

    const workspaces = [
      { id: "ws-docs", label: "Documents", rootPath: "/Users/guoyang/Documents" },
      { id: "ws-forge-a", label: "forge-agent", rootPath: "/Users/work_space/ai_workspace_new/forge-agent" },
      { id: "ws-forge-b", label: "forge-agent", rootPath: "/tmp/forge-agent" },
      { id: "ws-log", label: "log-monitor", rootPath: "/Users/work_space/qiyi_projects/log-monitor" },
    ];
    expect(helpers.filterWorkspaces(workspaces, "Documents", "").map((item) => item.id)).toEqual([
      "ws-docs",
    ]);
    expect(helpers.filterWorkspaces(workspaces, "qiyi_projects", "").map((item) => item.id)).toEqual([
      "ws-log",
    ]);
    expect(
      helpers.filterWorkspaces(workspaces, "", "granted", ["ws-docs", "ws-log"]).map((item) => item.id),
    ).toEqual(["ws-docs", "ws-log"]);
    expect(helpers.filterWorkspaces(workspaces, "", "default", [], "ws-forge-a").map((item) => item.id)).toEqual([
      "ws-forge-a",
    ]);

    const page = helpers.pageWorkspaces(workspaces, 2, 2);
    expect(page.count).toBe(4);
    expect(page.total).toBe(2);
    expect(page.page).toBe(2);
    expect(page.items.map((item) => item.id)).toEqual(["ws-forge-b", "ws-log"]);
  });

  it("loads each employee's own talent pack into the bind form", () => {
    expect(app).toContain("selected?.profile?.talentTemplateId");
    expect(app).toContain("selected?.profile?.modelProfileId");
    expect(app).toContain("fillModelSelect");
    expect(markup).toContain("talent-search");
    expect(markup).toContain('data-talent-picker="bind"');
    expect(markup).toContain("talentModal");
    expect(markup).toContain("talent-open");
  });

  it("explains bind permission failures in Chinese", () => {
    const helper = app.match(/function errorMessage\(error\) \{[\s\S]*?\n\}/)?.[0];
    expect(helper).toBeTruthy();
    const errorMessage = Function(`return (${helper})`)() as (error: unknown) => string;
    expect(errorMessage({ message: "model profile not found" })).toContain("模型");
    expect(errorMessage({ message: "workspace not found" })).toContain("项目目录");
    expect(errorMessage({ message: "employee can have at most one default workspace" })).toContain("主区");
    expect(errorMessage({ message: "company budget exhausted" })).toContain("预算");
    expect(errorMessage({ message: "workspace write lease conflict" })).toContain("占用");
    expect(app).toContain("talentPickerState.bind.selectedId");
  });

  it("filters talent packs by search and category", () => {
    const zh = app.match(/const TALENT_CATEGORY_ZH = \{[\s\S]*?\n\};/)?.[0];
    const keys = app.match(/const TALENT_CATEGORY_KEYS = \[[\s\S]*?\];/)?.[0];
    const categoryOf = app.match(/function talentCategoryOf\(talent\) \{[\s\S]*?\n\}/)?.[0];
    const categoryLabel = app.match(/function talentCategoryLabel\(category\) \{[\s\S]*?\n\}/)?.[0];
    const searchText = app.match(/function talentSearchText\(talent\) \{[\s\S]*?\n\}/)?.[0];
    const filterHelper = app.match(/function filterTalents\(talents, query, category\) \{[\s\S]*?\n\}/)?.[0];
    expect(zh && keys && categoryOf && categoryLabel && searchText && filterHelper).toBeTruthy();
    const filterTalents = Function(
      `${zh}\n${keys}\n${categoryOf}\n${categoryLabel}\n${searchText}\n${filterHelper}\nreturn filterTalents;`,
    )() as (
      talents: Array<{ id: string; role?: string; category?: string; suggestedSkills?: string[] }>,
      query?: string,
      category?: string,
    ) => Array<{ id: string }>;

    const talents = [
      { id: "engineering-senior-developer", role: "高级工程师", suggestedSkills: ["ts"] },
      { id: "academic-anthropologist", role: "学术人类学家" },
      { id: "product-expert", role: "产品专家", category: "product" },
    ];
    expect(filterTalents(talents, "人类", "").map((item) => item.id)).toEqual([
      "academic-anthropologist",
    ]);
    expect(filterTalents(talents, "", "engineering").map((item) => item.id)).toEqual([
      "engineering-senior-developer",
    ]);
    expect(filterTalents(talents, "产品", "").map((item) => item.id)).toEqual(["product-expert"]);
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

    expect(pipelineGate({ state: "draft", specVersion: 1 })).toBe("待确认计划");
    expect(pipelineGate({ state: "blocked", specVersion: 1, planVersion: 1 })).toBe("已驳回待修");
    expect(pipelineGate({
      state: "blocked",
      currentGate: "执行失败待修",
      specVersion: 1,
      planVersion: 1,
    })).toBe("执行失败待修");
    expect(pipelineGate({ state: "completed", specVersion: 1, planVersion: 1 })).toBe("已完成");
  });

  it("renders a workbench run button for the latest linked run", () => {
    const escapeHelper = app.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/)?.[0];
    const start = app.indexOf("function shortId(value) {");
    const end = app.indexOf("function workQueueItems(");
    expect(escapeHelper).toBeTruthy();
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const workItemRunButton = Function(
      `${escapeHelper}\n${app.slice(start, end)}\nreturn workItemRunButton;`,
    )() as (item: Record<string, unknown>) => string;

    expect(workItemRunButton({ runIds: ["run_123"] })).toContain(
      'data-open-run="run_123"',
    );
    expect(workItemRunButton({ runIds: ["run_old", "run_123"] })).toContain(
      'data-open-run="run_123"',
    );
    expect(workItemRunButton({
      id: "work_1",
      trace: {
        runs: [{
          runId: "run_123",
          sessionId: "sess_123",
          cwd: "/tmp/repo",
        }],
      },
    })).toContain('data-open-session="sess_123"');
    expect(workItemRunButton({ runIds: ["run_123"] })).toContain("在工作台看这次执行");
    expect(workItemRunButton({ runIds: [] })).toBe("");
    expect(workItemRunButton({ planVersion: 1, state: "ready" })).toContain(
      "去工作台手动开跑",
    );
  });

  it("shows a compact execution summary instead of the unused delivery dump", () => {
    const escapeHelper = app.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/)?.[0];
    const start = app.indexOf("function shortId(value) {");
    const end = app.indexOf("function renderOverview");
    expect(escapeHelper).toBeTruthy();
    const deliveryTraceHtml = Function(
      `${escapeHelper}\n${app.slice(start, end)}\nreturn deliveryTraceHtml;`,
    )() as (item: Record<string, unknown>) => string;

    const incomplete = deliveryTraceHtml({
      id: "work_1",
      trace: {
        workItemId: "work_1",
        specVersion: 1,
        runIds: [],
        runs: [],
        artifactIds: ["artifact_intent", "artifact_spec"],
        validationIds: [],
      },
    });
    expect(incomplete).not.toContain("work_1 →");
    expect(incomplete).not.toContain("验证 无");
    expect(incomplete).not.toContain("已交付");

    const completeTrace = {
      id: "work_1",
      title: "移动端也能看公司经营台",
      trace: {
        workItemId: "work_1",
        specVersion: 1,
        planVersion: 2,
        runIds: ["run_1"],
        runs: [{ runId: "run_1", createdAt: "2026-08-01T09:32:00.000Z" }],
        artifactIds: ["artifact_intent", "artifact_spec", "artifact_plan"],
        validationIds: ["validation_1"],
        validations: [{
          id: "validation_1",
          runId: "run_1",
          validatorId: "company.tests",
          status: "passed",
          summary: "tests passed",
        }],
      },
    };
    const waitingApproval = deliveryTraceHtml({
      ...completeTrace,
      state: "waiting_approval",
    });
    expect(waitingApproval).toContain("Run 1");
    expect(waitingApproval).toContain("08-01");
    expect(waitingApproval).toContain("规格 v1");
    expect(waitingApproval).toContain("计划 v2");
    expect(waitingApproval).toContain("自检 通过");
    expect(waitingApproval).not.toContain("validation_1");
    expect(waitingApproval).not.toContain("已交付");
    expect(deliveryTraceHtml({
      ...completeTrace,
      trace: {
        ...completeTrace.trace,
        validations: [{
          id: "validation_self",
          runId: "run_1",
          validatorId: "company.self_check",
          status: "passed",
          summary: "执行自检通过",
        }],
      },
    })).toContain("无测试证据");
    expect(deliveryTraceHtml({
      ...completeTrace,
      trace: {
        ...completeTrace.trace,
        evidence: [{
          id: "ev_1",
          runId: "run_1",
          claim: "feat: maximize pane",
          sourceKind: "git.commit",
          sourceRef: "abc1234",
        }],
        outputs: [{
          id: "out_1",
          runId: "run_1",
          mediaType: "text/x-diff",
          contentRef: "sha256:diff1",
        }],
      },
    })).toContain("abc1234");
    expect(deliveryTraceHtml({ ...completeTrace, state: "accepted" })).toContain(
      "已交付",
    );
  });

  it("collapses duplicate work items and lists each run against its work item", () => {
    const escapeHelper = app.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/)?.[0];
    const start = app.indexOf("function shortId(value) {");
    const end = app.indexOf("function renderOverview");
    const describeStart = app.indexOf("function describeTrace(label, value, runId) {");
    const describeEnd = app.indexOf("function draftSpecFromDemand(item) {");
    expect(escapeHelper).toBeTruthy();
    const helpers = Function(
      `${escapeHelper}\n${app.slice(start, end)}\n${app.slice(describeStart, describeEnd)}\nreturn { workQueueItems, hiddenDuplicateCount, executionTraceListHtml };`,
    )() as {
      workQueueItems: (
        items: Array<Record<string, unknown>>,
        selectedId?: string,
        showAll?: boolean,
      ) => Array<Record<string, unknown>>;
      hiddenDuplicateCount: (
        items: Array<Record<string, unknown>>,
        item: Record<string, unknown>,
      ) => number;
      executionTraceListHtml: (
        items: Array<Record<string, unknown>>,
        traces: Array<Record<string, unknown>>,
      ) => string;
    };

    const items = [
      { id: "draft_old", title: "移动端也能看公司经营台", state: "draft" },
      {
        id: "running",
        title: "移动端也能看公司经营台",
        state: "in_progress",
        updatedAt: "2026-09-10T09:32:00.000Z",
        runIds: ["run_2604d3d2-3efb-4440"],
        trace: {
          runs: [{
            runId: "run_2604d3d2-3efb-4440",
            createdAt: "2026-09-10T09:32:00.000Z",
            state: "running",
            sessionId: "sess_2604",
            cwd: "/tmp/log-monitor",
          }],
        },
      },
      { id: "other", title: "团队版窗格一键最大化", state: "draft" },
    ];
    expect(helpers.workQueueItems(items).map((item) => item.id)).toEqual([
      "running",
      "other",
    ]);
    expect(helpers.workQueueItems(items, "draft_old").map((item) => item.id)).toEqual([
      "draft_old",
      "running",
      "other",
    ]);
    expect(helpers.hiddenDuplicateCount(items, items[1])).toBe(1);

    const html = helpers.executionTraceListHtml(items, [
      { label: "执行请求", runId: "run_2604d3d2-3efb-4440" },
      { label: "红灯修复", result: { title: "修复项" } },
    ]);
    expect(html).toContain("移动端也能看公司经营台");
    expect(html).toContain("2604d3d2");
    expect(html).toContain("在工作台看这次执行");
    expect(html).toContain('data-open-session="sess_2604"');
    expect(html).not.toContain("执行请求");
    expect(html).toContain("修复项");
  });

  it("pins the blocked reason in the work inspector instead of hiding it with the red-light form", () => {
    expect(markup).toContain('id="workBlockReason"');
    expect(markup).toContain("阻塞原因");
    expect(app).toContain("function workBlockView");
    expect(app).toContain("执行完成，待处理阻塞");
    expect(app).toContain('halt.classList.toggle("hidden", Boolean(item.openFix) || item.type === "fix")');
    expect(app).not.toContain('item.type === "fix" || item.state === "blocked"');

    const escapeHelper = app.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/)?.[0];
    const pipelineStart = app.indexOf("function pipelineGate(item) {");
    const overviewStart = app.indexOf("function renderOverview");
    const hintStart = app.indexOf("function nextStepHint(item) {");
    const hintEnd = app.indexOf("function selectWorkItem(item) {");
    expect(escapeHelper).toBeTruthy();
    expect(pipelineStart).toBeGreaterThan(0);
    expect(overviewStart).toBeGreaterThan(pipelineStart);
    expect(hintStart).toBeGreaterThan(0);
    expect(hintEnd).toBeGreaterThan(hintStart);
    const helpers = Function(
      `${escapeHelper}\n${app.slice(pipelineStart, overviewStart)}\n${app.slice(hintStart, hintEnd)}\nreturn { workBlockView, nextStepHint, workItemMeta, executionTraceListHtml };`,
    )() as {
      workBlockView: (item: Record<string, unknown>) => Record<string, string> | null;
      nextStepHint: (item: Record<string, unknown>) => string;
      workItemMeta: (item: Record<string, unknown>) => string;
      executionTraceListHtml: (
        items: Array<Record<string, unknown>>,
        traces: Array<Record<string, unknown>>,
      ) => string;
    };

    const blockedFix = {
      id: "work_blocked_fix",
      type: "fix",
      title: "Fix: 移动端也能看公司经营台",
      state: "blocked",
      currentGate: "已驳回待修",
      problem: "最大化后还原比例错了，先暂停并派修复。",
      openFix: {
        id: "work_nested_fix",
        title: "Fix: Fix: 移动端也能看公司经营台",
      },
      runIds: ["e0def405-d757-42ff-b080-416dc33dfabd"],
      trace: {
        runs: [{
          runId: "e0def405-d757-42ff-b080-416dc33dfabd",
          createdAt: "2026-09-11T03:07:29.532Z",
          state: "succeeded",
        }],
      },
    };

    const view = helpers.workBlockView(blockedFix);
    expect(view?.gate).toBe("已驳回待修");
    expect(view?.reason).toContain("最大化后还原比例错了");
    expect(view?.next).toContain("Fix: Fix: 移动端也能看公司经营台");
    expect(view?.openFixId).toBe("work_nested_fix");

    const hint = helpers.nextStepHint(blockedFix);
    expect(hint).toContain("最大化后还原比例错了");
    expect(hint).toContain("已有修复单");
    expect(hint).not.toContain("看红灯");

    expect(helpers.workItemMeta(blockedFix)).toContain("执行完后被驳回");
    expect(helpers.executionTraceListHtml([blockedFix], [])).toContain("已驳回待修");
    expect(helpers.workBlockView({
      id: "work_draft",
      title: "新需求",
      state: "draft",
    })).toBeNull();
  });
});
