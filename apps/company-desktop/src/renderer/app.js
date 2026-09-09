const METHODS = {
  company: "company.get",
  dashboard: "company.dashboard.get",
  createCompany: "company.create",
  organization: "company.organization.tree",
  hire: "company.employees.hire",
  employees: "company.employees.list",
  workItems: "company.workItems.list",
  createWorkItem: "company.workItems.create",
  upsertArtifact: "company.workArtifacts.upsert",
  acceptArtifact: "company.workArtifacts.accept",
  dispatch: "company.workItems.dispatch",
  requestRun: "company.workItems.requestRun",
  pauseForFix: "company.workItems.pauseForFix",
  approvals: "company.approvals.list",
  decideApproval: "company.approvals.decide",
};

const state = {
  companyId: localStorage.getItem("forgeCompany.companyId") || "",
  companyName: localStorage.getItem("forgeCompany.companyName") || "",
  workItems: [],
  employees: [],
  approvals: [],
  traces: [],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function companyApi() {
  if (!window.forgeCompany?.invoke) throw new Error("公司服务尚未连接");
  return window.forgeCompany;
}

async function invoke(method, params = {}) {
  return companyApi().invoke(method, params);
}

function errorMessage(error) {
  return error?.message || error?.fault?.message || String(error);
}

let toastTimer;
function toast(message, isError = false) {
  const element = $("#toast");
  clearTimeout(toastTimer);
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.remove("hidden");
  toastTimer = setTimeout(() => element.classList.add("hidden"), 3600);
}

async function action(label, callback) {
  $("#globalStatus").textContent = `${label}…`;
  try {
    const result = await callback();
    $("#globalStatus").textContent = "已连接";
    toast(`${label}完成`);
    return result;
  } catch (error) {
    $("#globalStatus").textContent = "操作失败";
    toast(errorMessage(error), true);
    throw error;
  }
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function listFrom(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function pipelineGate(item) {
  if (item.currentGate) return item.currentGate;
  if (item.state === "draft") return item.specVersion ? "缺 plan" : "缺 spec";
  if (["ready", "in_progress", "waiting_input", "blocked"].includes(item.state)) return "执行中";
  if (["submitted", "waiting_approval", "verifying"].includes(item.state)) return "待验收";
  if (["accepted", "completed"].includes(item.state)) return "已完成";
  return item.planVersion ? "执行中" : item.specVersion ? "缺 plan" : "缺 spec";
}

function renderOverview(dashboard = {}) {
  const active = state.workItems.filter((item) =>
    !["accepted", "completed", "cancelled", "rejected"].includes(item.state));
  $("#metricWork").textContent = dashboard.inProgressWorkItems ?? dashboard.activeWorkItems ?? active.length;
  $("#metricEmployees").textContent = dashboard.employees ?? state.employees.length;
  $("#metricApprovals").textContent = dashboard.pendingApprovals ?? state.approvals.length;
  const pipelines = listFrom(dashboard, ["pipelines", "workItems"]);
  const items = pipelines.length ? pipelines : state.workItems;
  $("#pipelineList").classList.toggle("empty", !items.length);
  $("#pipelineList").innerHTML = items.length
    ? items.map((item) => `<div class="list-row">
        <div><b>${escapeHtml(item.title || item.id)}</b><small>${escapeHtml(item.id)} · ${escapeHtml(item.state || "draft")}</small></div>
        <span class="gate">${escapeHtml(pipelineGate(item))}</span>
      </div>`).join("")
    : "暂无工作项";
}

function renderOrganization(payload) {
  const source = listFrom(payload, ["employees", "nodes", "positions"]);
  const employees = source.length ? source : state.employees;
  $("#organizationTree").classList.toggle("empty", !employees.length);
  $("#organizationTree").innerHTML = employees.length
    ? employees.map((employee) => `<div class="org-node">
        <span class="avatar">${escapeHtml((employee.displayName || employee.name || "?").slice(0, 1))}</span>
        <div><b>${escapeHtml(employee.displayName || employee.name || employee.id)}</b>
        <small>${escapeHtml(employee.positionId || employee.position || "未分配岗位")} · L${escapeHtml(employee.autonomyLevel ?? 2)}</small></div>
      </div>`).join("")
    : "暂无员工";
}

function renderApprovals() {
  const actorId = $("#approvalActorId").value.trim();
  $("#approvalList").classList.toggle("empty", !state.approvals.length);
  $("#approvalList").innerHTML = state.approvals.length
    ? state.approvals.map((item) => {
        const ownSubmission = Boolean(actorId && item.assigneeId === actorId);
        return `<article class="approval-row" data-work-item="${escapeHtml(item.workItemId || item.id)}">
          <div><b>${escapeHtml(item.title || item.workItemId || item.id)}</b>
          <small>执行人：${escapeHtml(item.assigneeId || "未知")} · ${escapeHtml(item.state || "待审批")}</small></div>
          <input data-reason placeholder="驳回理由" />
          <button data-decision="approved" ${ownSubmission ? "disabled title=\"不能批准自己的提交\"" : ""}>通过</button>
          <button class="danger" data-decision="rejected">驳回</button>
        </article>`;
      }).join("")
    : "暂无待审批事项";
}

function addTrace(label, result) {
  const runId = result?.runId || result?.id?.startsWith?.("run_") && result.id;
  state.traces.unshift({ label, result, runId });
  $("#traceList").classList.remove("empty");
  $("#traceList").innerHTML = state.traces.map((trace) => {
    const value = trace.result || {};
    const details = [
      value.workItemId && `WorkItem ${value.workItemId}`,
      value.id && `ID ${value.id}`,
      value.version != null && `v${value.version}`,
      value.specVersion != null && `spec v${value.specVersion}`,
      value.planVersion != null && `plan v${value.planVersion}`,
      trace.runId && `Run ${trace.runId}`,
    ].filter(Boolean).join(" · ") || JSON.stringify(value);
    return `<div class="list-row"><div><b>${escapeHtml(trace.label)}</b><small>${escapeHtml(details)}</small></div>
      ${trace.runId ? `<button data-open-run="${escapeHtml(trace.runId)}">在工作台打开</button>` : ""}</div>`;
  }).join("");
}

async function loadData() {
  const setup = $("#setupPanel");
  setup.classList.toggle("hidden", Boolean(state.companyId));
  $("#companyLabel").textContent = state.companyName || (state.companyId ? state.companyId : "尚未创建公司");
  if (!state.companyId) {
    $("#globalStatus").textContent = "等待创建公司";
    renderOverview();
    return;
  }
  $("#globalStatus").textContent = "正在同步…";
  const params = { companyId: state.companyId };
  const [companyResult, dashboardResult, workResult, employeeResult, approvalResult, orgResult] = await Promise.allSettled([
    invoke(METHODS.company, params),
    invoke(METHODS.dashboard, params),
    invoke(METHODS.workItems, params),
    invoke(METHODS.employees, params),
    invoke(METHODS.approvals, params),
    invoke(METHODS.organization, params),
  ]);
  if (companyResult.status === "fulfilled") {
    state.companyName = companyResult.value?.name || state.companyName;
    if (state.companyName) localStorage.setItem("forgeCompany.companyName", state.companyName);
    $("#companyLabel").textContent = state.companyName || state.companyId;
  }
  if (workResult.status === "fulfilled") state.workItems = listFrom(workResult.value, ["workItems", "items"]);
  if (employeeResult.status === "fulfilled") state.employees = listFrom(employeeResult.value, ["employees", "items"]);
  if (approvalResult.status === "fulfilled") state.approvals = listFrom(approvalResult.value, ["pending", "approvals", "items"]);
  renderOverview(dashboardResult.status === "fulfilled" ? dashboardResult.value : {});
  renderOrganization(orgResult.status === "fulfilled" ? orgResult.value : {});
  renderApprovals();
  const failures = [companyResult, dashboardResult, workResult, employeeResult, approvalResult, orgResult]
    .filter((result) => result.status === "rejected");
  $("#globalStatus").textContent = failures.length ? `部分数据不可用 (${failures.length})` : "已同步";
}

function showPage(name) {
  $$("[data-page]").forEach((page) => page.classList.toggle("hidden", page.dataset.page !== name));
  $$("[data-nav]").forEach((button) => button.classList.toggle("on", button.dataset.nav === name));
}

$$("[data-nav]").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.nav)));
$$(".refresh").forEach((button) => button.addEventListener("click", () => void loadData()));

$("#createCompanyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = formValues(event.currentTarget);
  try {
    const company = await action("创建公司", () => invoke(METHODS.createCompany, { name: values.name }));
    state.companyId = company.id || company.companyId;
    state.companyName = company.name || values.name;
    if (!state.companyId) throw new Error("创建成功但未返回 companyId");
    localStorage.setItem("forgeCompany.companyId", state.companyId);
    localStorage.setItem("forgeCompany.companyName", state.companyName);
    await loadData();
  } catch {}
});

$("#hireForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = formValues(event.currentTarget);
  try {
    await action("雇佣员工", () => invoke(METHODS.hire, {
      companyId: state.companyId,
      displayName: values.displayName,
      positionId: values.positionId,
      autonomyLevel: Number(values.autonomyLevel),
    }));
    event.currentTarget.reset();
    await loadData();
  } catch {}
});

async function createDemand(values, source) {
  const result = await action("登记需求", () => invoke(METHODS.createWorkItem, {
    companyId: state.companyId,
    type: "intent",
    title: values.title,
    problem: values.problem,
    expectedOutcome: values.expectedOutcome,
    ownerId: values.ownerId,
  }));
  addTrace(source, result);
  await loadData();
  return result;
}

$("#demandForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await createDemand(formValues(event.currentTarget), "需求已登记");
    if (result?.id) $("#gateForm [name=workItemId]").value = result.id;
  } catch {}
});

$("#gateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = formValues(event.currentTarget);
  try {
    const spec = await action("保存规格", () => invoke(METHODS.upsertArtifact, {
      workItemId: values.workItemId, kind: "spec", content: values.spec, actorId: values.actorId,
    }));
    const acceptedSpec = await action("接受规格", () => invoke(METHODS.acceptArtifact, {
      artifactId: spec.id, actorId: values.actorId,
    }));
    const plan = await action("保存计划", () => invoke(METHODS.upsertArtifact, {
      workItemId: values.workItemId, kind: "plan", content: values.plan, actorId: values.actorId,
    }));
    const acceptedPlan = await action("接受计划", () => invoke(METHODS.acceptArtifact, {
      artifactId: plan.id, actorId: values.actorId,
    }));
    addTrace("规格门通过", acceptedSpec);
    addTrace("计划门通过", acceptedPlan);
    $("#dispatchForm [name=workItemId]").value = values.workItemId;
    $("#dispatchForm [name=actorId]").value = values.actorId;
    await loadData();
  } catch {}
});

$("#dispatchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = formValues(event.currentTarget);
  try {
    const dispatched = await action("派活", () => invoke(METHODS.dispatch, values));
    const run = await action("请求执行", () => invoke(METHODS.requestRun, { workItemId: values.workItemId }));
    addTrace("已派活", dispatched);
    addTrace("执行请求", run);
    await loadData();
  } catch {}
});

$("#fixForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await action("暂停并派修复", () => invoke(METHODS.pauseForFix, formValues(event.currentTarget)));
    addTrace("红灯修复", result);
    await loadData();
  } catch {}
});

$("#approvalActorId").addEventListener("input", renderApprovals);
$("#approvalList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-decision]");
  if (!button) return;
  const row = button.closest("[data-work-item]");
  const actorId = $("#approvalActorId").value.trim();
  const reason = row.querySelector("[data-reason]").value.trim();
  if (button.dataset.decision === "rejected" && !reason) return toast("驳回必须填写理由", true);
  try {
    await action(button.dataset.decision === "approved" ? "审批通过" : "审批驳回", () =>
      invoke(METHODS.decideApproval, {
        workItemId: row.dataset.workItem,
        actorId,
        decision: button.dataset.decision,
        reason,
      }));
    await loadData();
  } catch {}
});

$("#traceList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-run]");
  if (button) void window.forgeCompany.openWorkbench(`forge://workbench/run/${button.dataset.openRun}`);
});

$("#openWorkbenchBtn").addEventListener("click", () => void window.forgeCompany?.openWorkbench());
$("#ceoDrawerBtn").addEventListener("click", () => $("#ceoDrawer").classList.remove("hidden"));
$("#closeDrawerBtn").addEventListener("click", () => $("#ceoDrawer").classList.add("hidden"));
$("#ceoDrawer").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.classList.add("hidden");
});
$("#ceoForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await createDemand(formValues(event.currentTarget), "CEO 需求草稿");
    $("#ceoDrawer").classList.add("hidden");
    event.currentTarget.reset();
  } catch {}
});

showPage("overview");
void loadData().catch((error) => {
  $("#globalStatus").textContent = "连接失败";
  toast(errorMessage(error), true);
});
