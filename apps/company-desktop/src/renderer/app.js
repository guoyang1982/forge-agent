const METHODS = {
  company: "company.get",
  dashboard: "company.dashboard.get",
  createCompany: "company.create",
  organization: "company.organization.tree",
  ensureCrew: "company.organization.ensureCrew",
  hire: "company.employees.hire",
  onboardOptions: "company.employees.onboardOptions",
  onboard: "company.employees.onboard",
  bindEmployee: "company.employees.bind",
  grantDefaultWorkspace: "company.employees.grantDefaultWorkspace",
  employees: "company.employees.list",
  workItems: "company.workItems.list",
  readOutput: "company.workOutputs.read",
  readWorkspaceFile: "company.workFiles.read",
  createWorkItem: "company.workItems.create",
  upsertArtifact: "company.workArtifacts.upsert",
  acceptArtifact: "company.workArtifacts.accept",
  draftArtifacts: "company.workArtifacts.draft",
  dispatch: "company.workItems.dispatch",
  requestRun: "company.workItems.requestRun",
  pauseForFix: "company.workItems.pauseForFix",
  previewApproval: "company.workItems.previewApproval",
  approvals: "company.approvals.list",
  decideApproval: "company.approvals.decide",
  ceoBrief: "company.ceo.brief",
  goals: "company.goals.list",
  createGoal: "company.goals.create",
  projects: "company.projects.list",
  createProject: "company.projects.create",
  bindProjectWorkspaces: "company.projects.bindWorkspaces",
  deliveryGateDecide: "company.delivery.gates.decide",
  deliveryGateLatest: "company.delivery.gates.latest",
  deliveryGateSnapshot: "company.delivery.gates.snapshot",
  workflowCapabilities: "company.workflows.capabilities",
  startWorkflow: "company.workflows.start",
  researchWorkflowStatus: "company.workflows.researchStatus",
};

const RESEARCH_WORKFLOW_ID = "forge.company.requirement-research";

function readCollapsedDepartments() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem("forgeCompany.collapsedDepartments") || "[]");
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [],
    );
  } catch {
    return new Set();
  }
}

const state = {
  companyId: localStorage.getItem("forgeCompany.companyId") || "",
  companyName: localStorage.getItem("forgeCompany.companyName") || "",
  selectedWorkItemId: sessionStorage.getItem("forgeCompany.selectedWorkItemId") || "",
  workItems: [],
  employees: [],
  positions: [],
  onboard: { positions: [], talents: [], workspaces: [] },
  org: { departments: [], positions: [], employees: [] },
  collapsedDepartments: readCollapsedDepartments(),
  selectedEmployeeId: "",
  selectedPositionId: "",
  staffTab: "idle",
  approvals: [],
  decisions: [],
  traces: [],
  goals: [],
  projects: [],
  ceoBrief: null,
  deliveryProjectId: sessionStorage.getItem("forgeCompany.deliveryProjectId") || "",
  workflowCapabilities: [],
  researchWorkflow: null,
  feasibilityPending: false,
  deliveryIntakeKeepOpen: false,
  deliveryGates: {},
  deliveryGateSnapshots: {},
  deliveryDecisionPending: false,
  deliveryGatesError: false,
};

const workDrafts = globalThis.ForgeDraftStore.createDraftStore(() => localStorage, "work");
const deliveryDrafts = globalThis.ForgeDraftStore.createDraftStore(() => localStorage, "delivery");
const workDraftKey = (id, companyId = state.companyId) => JSON.stringify([companyId, id]);
function draftNotice(form, message, discard = true) {
  if (!form) return;
  let notice = form.querySelector(".draft-notice");
  if (!notice) {
    notice = document.createElement("div");
    notice.className = "draft-notice hint";
    notice.setAttribute("role", "status");
    form.prepend(notice);
  }
  notice.replaceChildren(document.createTextNode(message));
  if (discard) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.dataset.discardDraft = form.id;
    button.textContent = "放弃本机草稿";
    notice.append(button);
  }
}
function clearSubmittedDraft(store, key, submitted) {
  const current = store.get(key);
  if (current && Object.entries(current).some(([name, value]) => submitted[name] !== value)) return;
  if (!store.delete(key)) toast("提交已成功，但本机草稿未能清除，请检查浏览器存储。", true);
}
let loadVersion = 0;
let deliverySelectionInitialized = false;
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
  const raw = String(error?.fault?.message || error?.message || error);
  if (raw.includes("assignee has no default write workspace")) {
    return "执行人没有主写目录。请到组织页给这位员工授权一个可写主区。";
  }
  if (raw.includes("work item has no assignee")) return "还没有派执行人。";
  if (raw.includes("plan not accepted")) return "计划还没接受，不能开跑。";
  if (raw.includes("work item already has an active run")) return "这条工作还在跑，等它结束再请求。";
  if (raw.includes("talent template not found")) {
    return "找不到这个人才包。请重新点「选择/更换」再保存。";
  }
  if (raw.includes("model profile not found")) {
    return "找不到这个模型。请选公司已配置的模型，或不选则用公司默认模型。";
  }
  if (raw.includes("workspace not found")) {
    return "有个项目目录已失效。请先点刷新，再勾选可写和主区。";
  }
  if (raw.includes("at most one default workspace")) {
    return "主区只能选一个。请只勾选一个主区后再保存。";
  }
  if (raw.includes("company budget exhausted")) {
    return "公司预算已用完，先加额度再开跑。";
  }
  if (raw.includes("workspace write lease conflict")) {
    return "这个目录正在被别的 Run 占用，等它结束再开跑。";
  }
  if (raw.includes("assignee has no write workspace in the project group")) {
    return "执行人没有这个项目组里的写目录。请先授权，或改绑项目目录组。";
  }
  if (raw.includes("has no workspace grant in the project group")) {
    return "调研人还没有这个项目目录组的权限。请重新绑定一次项目目录组，或给数字人授权该目录。";
  }
  if (raw.includes("goal not found")) {
    return "先立目标，再挂项目。";
  }
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^DaemonRpcError:\s*/, "");
}

function hasDefaultWriteWorkspace(employee) {
  return (employee?.workspaces || []).some((grant) => grant.isDefault && grant.mode === "write");
}

function defaultWriteGrant(employee) {
  return (employee?.workspaces || []).find((grant) => grant.isDefault && grant.mode === "write");
}

function workspaceLabel(workspaceId) {
  const listed = (state.onboard.workspaces || []).find((item) => item.id === workspaceId);
  return listed?.label || listed?.rootPath || workspaceId;
}

function employeeOf(id) {
  return state.employees.find((item) => item.id === id);
}

function employeeLabel(idOrEmployee) {
  const employee = typeof idOrEmployee === "string" ? employeeOf(idOrEmployee) : idOrEmployee;
  if (!employee) return "未指定";
  const name = employee.displayName || employee.name || "未命名";
  const title = positionTitle(employee.positionId);
  return title ? `${title} · ${name}` : name;
}

function formatSkillList(skills, max = 6) {
  const list = (skills || []).map((item) => String(item || "").trim()).filter(Boolean);
  if (!list.length) return "";
  if (list.length <= max) return list.join("、");
  return `${list.slice(0, max).join("、")} 等${list.length}项`;
}

function capabilityKitLine(profile) {
  const skills = (profile?.skills || []).filter(Boolean);
  const tools = (profile?.tools || []).filter(Boolean);
  const gates = (profile?.qualityGates || []).filter(Boolean);
  const parts = [];
  if (skills.length) parts.push(`技能 ${formatSkillList(skills)}`);
  if (tools.length) parts.push(`工具 ${tools.join("、")}`);
  if (gates.length) parts.push(`质量要求 ${gates.join("；")}`);
  const knowledge = (profile?.knowledgeRefs || []).filter(Boolean);
  const connectors = (profile?.connectors || []).filter(Boolean);
  if (knowledge.length) parts.push(`知识 ${knowledge.join("、")}`);
  if (connectors.length) parts.push(`连接器 ${connectors.join("、")}`);
  return parts.join(" · ");
}

function memoryKindLabel(kind) {
  if (kind === "gate") return "验收要求";
  if (kind === "standing") return "常驻";
  return "经验";
}

function employeeBoundSkillsHtml(employee) {
  const skills = (employee?.profile?.skills || []).filter(Boolean);
  if (!skills.length) {
    return `<p class="hint">尚未绑定技能。选择人才包并保存后生效。</p>`;
  }
  return `<div class="bound-skills">
    <span class="field-label">已绑定技能 · ${skills.length}</span>
    <ul class="skill-chip-list">${skills.map((skill) =>
      `<li><code>${escapeHtml(skill)}</code></li>`).join("")}</ul>
  </div>`;
}

function employeeKitHtml(employee) {
  const tools = (employee?.profile?.tools || []).filter(Boolean);
  const memories = employee?.memories || [];
  return [
    tools.length
      ? `<p class="kit-line">工具 ${escapeHtml(tools.join("、"))}</p>`
      : "",
    memories.length
      ? `<ul class="memory-list">${memories.map((row) =>
        `<li><small>${escapeHtml(memoryKindLabel(row.kind))}</small>${escapeHtml(row.content)}</li>`).join("")}</ul>`
      : `<p class="hint">暂无经验记录。完成验收后会自动积累。</p>`,
  ].join("");
}

function employeeTalentLabel(employee) {
  const role = employee?.profile?.talentRole || "未绑定人才";
  const skills = formatSkillList(employee?.profile?.skills);
  return skills ? `${role} · ${skills}` : role;
}

function fillEmployeeSelect(select, selectedId, options = {}) {
  if (!select) return;
  const current = selectedId || select.value;
  const requireWrite = Boolean(options.requireWrite);
  select.innerHTML = state.employees.map((employee) => {
    const ready = hasDefaultWriteWorkspace(employee);
    const label = `${employeeLabel(employee)}${requireWrite && !ready ? " · 无主写目录" : ""}`;
    return `<option value="${escapeHtml(employee.id)}">${escapeHtml(label)}</option>`;
  }).join("");
  if (current && [...select.options].some((option) => option.value === current)) {
    select.value = current;
  } else if (select.options.length) {
    const ready = requireWrite ? state.employees.find(hasDefaultWriteWorkspace) : null;
    select.value = ready?.id || select.options[0].value;
  }
}

function setSelectedWorkTitle(item) {
  const title = item?.title || (item?.id ? "未命名工作项" : "未选工作项");
  for (const id of ["gateWorkTitle", "dispatchWorkTitle", "fixWorkTitle"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = title;
  }
}

function renderPersonSelects(item) {
  fillEmployeeSelect($("#demandForm [name=ownerId]"), item?.ownerId);
  fillEmployeeSelect($("#ceoForm [name=ownerId]"), item?.ownerId);
  fillEmployeeSelect($("#gateForm [name=actorId]"), item?.ownerId);
  fillEmployeeSelect($("#fixForm [name=ownerId]"), item?.ownerId);
  fillEmployeeSelect($("#approvalActorId"), $("#approvalActorId")?.value);
  renderDispatchAssignees(item);
  if (item) renderDrafterOptions(pickDefaultDrafterId(item));
}

function updateDispatchWorkspaceHint() {
  const hint = $("#dispatchWorkspaceHint");
  const assigneeId = $("#dispatchForm [name=assigneeId]")?.value;
  const employee = state.employees.find((item) => item.id === assigneeId);
  if (!hint) return;
  const item = selectedWorkItem();
  const researcher = employeeByRole(RESEARCH_ROLE_PATTERN);
  if (isResearchWork(item)) {
    if (!researcher) {
      hint.textContent = "调研应派给市场调查员。岗位还空着，先去组织入职（人才包选 Trend 研究员），并授权一个可写主区。空缺时暂用产品助理，不要派给执行工程师。";
      return;
    }
    if (assigneeId && assigneeId !== researcher.id) {
      hint.textContent = `调研应派给市场调查员 · ${researcher.displayName}。当前选的是别人。`;
      return;
    }
  }
  const grant = defaultWriteGrant(employee);
  hint.textContent = grant
    ? `${employee.displayName || "执行人"} 将在「${workspaceLabel(grant.workspaceId)}」里开跑。`
    : `${employee?.displayName || "执行人"}没有主写目录。请先到组织页授权一个可写主区。`;
}

function renderDispatchAssignees(item) {
  const assigneeSelect = $("#dispatchForm [name=assigneeId]");
  const actorSelect = $("#dispatchForm [name=actorId]");
  const preferred = pickDefaultAssigneeId(item)
    || (hasDefaultWriteWorkspace(state.employees.find((entry) => entry.id === assigneeSelect?.value))
      ? assigneeSelect.value
      : "")
    || "";
  fillEmployeeSelect(assigneeSelect, preferred, { requireWrite: true });
  fillEmployeeSelect(actorSelect, item?.ownerId || actorSelect?.value);
  updateDispatchWorkspaceHint();
}

let toastTimer;
function toast(message, isError = false) {
  const element = $("#toast");
  if (!element) return;
  clearTimeout(toastTimer);
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.remove("hidden");
  toastTimer = setTimeout(() => element.classList.add("hidden"), isError ? 8000 : 3600);
}

async function action(label, callback) {
  const status = $("#globalStatus");
  if (status) status.textContent = `${label}…`;
  try {
    const result = await callback();
    if (status) status.textContent = "已连接";
    toast(`${label}完成`);
    return result;
  } catch (error) {
    if (status) status.textContent = "操作失败";
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
  if (item.currentGate) return ({ "缺 spec": "待确认需求", "缺 plan": "待确认计划" })[item.currentGate] || item.currentGate;
  if (item.state === "draft") return item.specVersion ? "待确认计划" : "待确认需求";
  if (item.state === "blocked") return "已驳回待修";
  if (["ready", "in_progress"].includes(item.state)) return "执行中";
  if (item.state === "waiting_input") return "等待输入";
  if (["submitted", "waiting_approval", "verifying"].includes(item.state)) return "待验收";
  if (["accepted", "completed"].includes(item.state)) return "已完成";
  return item.planVersion ? "待安排执行" : item.specVersion ? "待确认计划" : "待确认需求";
}

function employeeName(id) {
  return employeeLabel(id);
}

function shortId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const stripped = text.replace(/^(run_|work_|run_link_)/, "");
  return (stripped.split(/[-_]/)[0] || stripped).slice(0, 8);
}

function formatWorkTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `今天 ${hh}:${mm}`;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${hh}:${mm}`;
}

function runStateLabel(state) {
  return ({
    queued: "排队",
    running: "执行中",
    waiting: "等待中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  })[state] || "";
}

function workStateLabel(state) {
  return ({
    draft: "草稿",
    ready: "待派活",
    in_progress: "执行中",
    blocked: "阻塞",
    waiting_input: "等待输入",
    submitted: "待验收",
    waiting_approval: "待验收",
    verifying: "核验中",
    accepted: "已验收",
    completed: "已完成",
    rejected: "已驳回",
    cancelled: "已取消",
  })[state] || state || "草稿";
}

function linkedRuns(item) {
  if (item?.trace?.runs?.length) return item.trace.runs;
  return (item?.runIds || []).map((runId) => ({ runId }));
}

function latestLinkedRun(item) {
  const runs = linkedRuns(item);
  return runs[runs.length - 1] || null;
}

function workbenchRunAttrs(run, workItemId) {
  const attrs = [];
  if (run?.runId) attrs.push(`data-open-run="${escapeHtml(run.runId)}"`);
  if (run?.sessionId) attrs.push(`data-open-session="${escapeHtml(run.sessionId)}"`);
  if (run?.cwd) attrs.push(`data-session-cwd="${escapeHtml(run.cwd)}"`);
  if (workItemId) attrs.push(`data-work-item="${escapeHtml(workItemId)}"`);
  return attrs.join(" ");
}

function workbenchRunButton(run, workItemId) {
  if (!run?.runId) return "";
  return `<button ${workbenchRunAttrs(run, workItemId)}>在工作台看这次执行</button>`;
}

function workItemRunButton(item) {
  const run = latestLinkedRun(item);
  if (run?.runId) return workbenchRunButton(run, item.id);
  if (item.planVersion && (item.state === "ready" || item.state === "in_progress")) return `<button data-open-workbench>去工作台手动开跑</button>`;
  return "";
}

function canMarkDelivered(trace) {
  return trace?.specVersion != null && trace?.planVersion != null &&
    trace.runIds?.length > 0 && (trace.validationIds?.length > 0 || trace.validations?.length > 0);
}

const WORK_QUEUE_RANK = {
  cancelled: -1,
  draft: 0,
  rejected: 1,
  ready: 2,
  blocked: 3,
  waiting_input: 3,
  in_progress: 4,
  submitted: 5,
  waiting_approval: 5,
  verifying: 5,
  accepted: 6,
  completed: 6,
};

function compareWorkItems(left, right) {
  const rankDelta = (WORK_QUEUE_RANK[left.state] ?? 0) - (WORK_QUEUE_RANK[right.state] ?? 0);
  if (rankDelta) return rankDelta;
  return String(left.updatedAt || left.createdAt || "").localeCompare(String(right.updatedAt || right.createdAt || ""));
}

function workQueueItems(items, selectedId, showAll) {
  const usable = (items || []).filter((item) => item.state !== "cancelled");
  if (showAll) return usable;
  const bestByTitle = new Map();
  for (const item of usable) {
    const key = (item.title || "").trim() || item.id;
    const current = bestByTitle.get(key);
    if (!current || compareWorkItems(item, current) > 0) bestByTitle.set(key, item);
  }
  const kept = new Set([...bestByTitle.values()].map((item) => item.id));
  if (selectedId) {
    const selected = usable.find((item) => item.id === selectedId);
    if (selected) kept.add(selected.id);
  }
  return usable.filter((item) => kept.has(item.id));
}

function hiddenDuplicateCount(items, item) {
  const key = (item.title || "").trim();
  if (!key) return 0;
  return (items || []).filter((other) =>
    other.id !== item.id &&
    other.state !== "cancelled" &&
    (other.title || "").trim() === key
  ).length;
}

function workItemMeta(item) {
  const run = latestLinkedRun(item);
  const status = pipelineGate(item);
  const outcome = run?.state === "failed" ? "执行失败" : item.state === "blocked" && run?.state === "succeeded"
    ? (item.currentGate === "已驳回待修" ? "执行完后被驳回" : "执行完成，待处理阻塞") : "";
  return [...new Set([workStateLabel(item.state), status, outcome,
    formatWorkTime(run?.createdAt || item.updatedAt || item.createdAt),
  ].filter(Boolean))].join(" · ");
}

function failedValidationSummaries(item) {
  return (item?.trace?.validations || [])
    .filter((row) => row.status === "failed" && row.summary)
    .map((row) => row.summary);
}

function blockReasonText(item) {
  const problem = String(item?.problem || "").trim();
  const failed = failedValidationSummaries(item);
  const validation = failed.length ? `自检未过：${failed.join("；")}` : "";
  if (problem && validation && !problem.includes(validation) && !failed.some((row) => problem.includes(row))) {
    return `${problem}\n${validation}`;
  }
  return problem || (failed.length ? validation : "");
}

function workBlockView(item) {
  if (!item) return null;
  const gate = pipelineGate(item);
  const blocked = item.state === "blocked"
    || gate === "已驳回待修"
    || gate === "执行失败待修";
  if (!blocked && item.type !== "fix") return null;
  const reason = blockReasonText(item);
  const openFixTitle = item.openFix?.title || "";
  let next = "";
  if (openFixTitle) {
    next = `已开出修复单「${openFixTitle}」。去处理那张单，不要在这张上再派活或再点红灯。`;
  } else if (item.type === "fix") {
    next = reason
      ? "驳回点已写进规格/计划。看完原因后改规格或计划，保存并接受，再派活。"
      : "改规格或计划后保存并接受，再派活。";
  } else {
    next = `继续处理标题为「Fix: ${item.title}」的修复单。`;
  }
  return {
    gate,
    reason,
    next,
    openFixId: item.openFix?.id || "",
  };
}

function renderWorkBlockReason(item) {
  const card = $("#workBlockReason");
  if (!card) return;
  const view = workBlockView(item);
  card.classList.toggle("hidden", !view);
  if (!view) return;
  const gate = $("#workBlockGate");
  const text = $("#workBlockText");
  const next = $("#workBlockNext");
  if (gate) gate.textContent = view.gate;
  if (text) {
    text.textContent = view.reason || `没有写下具体原因，按当前门「${view.gate}」处理。`;
  }
  if (next) next.textContent = view.next;
  const btn = $("#workBlockFixBtn");
  if (btn) {
    btn.classList.toggle("hidden", !view.openFixId);
    if (view.openFixId) btn.setAttribute("data-select-work", view.openFixId);
    else btn.removeAttribute("data-select-work");
  }
}

function deliveryTraceHtml(item) {
  const trace = item.trace || {
    workItemId: item.id,
    specVersion: item.specVersion,
    planVersion: item.planVersion,
    runIds: item.runIds || [],
    runs: linkedRuns(item),
    artifactIds: [],
    validationIds: [],
  };
  const runs = linkedRuns({ ...item, trace });
  const latest = runs[runs.length - 1];
  const independentlyAccepted = ["accepted", "completed"].includes(item.state);
  const summary = [
    trace.specVersion != null ? `规格 v${trace.specVersion}` : "",
    trace.planVersion != null ? `计划 v${trace.planVersion}` : "",
    latest
      ? `${runs.length > 1 ? `第 ${runs.length} 次 · ` : ""}Run ${shortId(latest.runId)}${latest.createdAt ? ` · ${formatWorkTime(latest.createdAt)}` : ""}${runStateLabel(latest.state) ? ` · ${runStateLabel(latest.state)}` : ""}`
      : item.planVersion
        ? "计划已过，尚未开跑"
        : "",
    evidenceLabel(trace),
    selfCheckLabel(trace),
  ].filter(Boolean).join(" · ");
  return `${summary ? `<small class="delivery-trace">${escapeHtml(summary)}</small>` : ""}${canMarkDelivered(trace) && independentlyAccepted ? '<span class="gate">已交付</span>' : ""}`;
}

function selfCheckLabel(trace) {
  const validations = trace?.validations || [];
  const real = validations.filter((row) => row.validatorId && row.validatorId !== "company.self_check");
  if (real.some((row) => row.status === "failed")) return "自检 未过";
  if (real.some((row) => row.status === "passed")) return "自检 通过";
  if (validations.length || trace?.validationIds?.length) return "无测试证据";
  return "";
}

function evidenceLabel(trace) {
  const evidence = trace?.evidence || [];
  const commit = evidence.find((row) =>
    /commit|git/i.test(String(row.sourceKind || "")) || /^[0-9a-f]{7,40}$/i.test(String(row.sourceRef || "")));
  const parts = [];
  if (commit?.sourceRef) parts.push(`commit ${shortId(commit.sourceRef)}`);
  else if (commit?.claim) parts.push(commit.claim);
  if ((trace?.outputs || []).length) parts.push(`产物 ${trace.outputs.length}`);
  else if (evidence.length && !commit) parts.push(`证据 ${evidence.length}`);
  return parts.join(" · ");
}

function executionTraceListHtml(items, traces) {
  const rows = [];
  for (const item of items || []) {
    const runs = linkedRuns(item);
    runs.forEach((run, index) => {
      rows.push({ item, run, index, total: runs.length });
    });
  }
  rows.sort((left, right) => String(right.run.createdAt || "").localeCompare(String(left.run.createdAt || "")));
  const shown = new Set(rows.map((row) => row.run.runId).filter(Boolean));
  const extras = (traces || []).filter((trace) => {
    if (trace.runId && shown.has(trace.runId)) return false;
    if (["规格门通过", "计划门通过", "执行请求"].includes(trace.label)) return false;
    return Boolean(trace.label);
  });
  const runMarkup = rows.map((row) => {
    const ordinal = row.total > 1 ? `第 ${row.index + 1}/${row.total} 次` : "本次执行";
    const blockedAfterSuccess = row.item.state === "blocked" && row.run.state === "succeeded";
    const details = [
      ordinal,
      `Run ${shortId(row.run.runId)}`,
      runStateLabel(row.run.state),
      blockedAfterSuccess ? pipelineGate(row.item) : "",
      formatWorkTime(row.run.createdAt),
    ].filter(Boolean).join(" · ");
    return `<div class="list-row"><div><b>${escapeHtml(row.item.title || "未命名工作项")}</b>
      <small class="delivery-trace">${escapeHtml(details)}</small></div>
      ${workbenchRunButton(row.run, row.item.id)}</div>`;
  });
  const extraMarkup = extras.map((trace) => {
    const title = trace.result?.title || trace.label;
    const details = describeTrace(trace.label, trace.result || {}, trace.runId);
    return `<div class="list-row"><div><b>${escapeHtml(title)}</b><small>${escapeHtml(details)}</small></div>
      ${workbenchRunButton({ runId: trace.runId, sessionId: trace.sessionId, cwd: trace.cwd })}</div>`;
  });
  return [...runMarkup, ...extraMarkup].join("");
}

function renderOverview(dashboard = {}) {
  $("#metricWork").textContent = dashboard.inProgressWorkItems ?? state.workItems.filter((item) => ["in_progress", "waiting_approval", "submitted", "verifying"].includes(item.state)).length;
  $("#metricEmployees").textContent = dashboard.employees ?? state.employees.length;
  $("#metricApprovals").textContent = dashboard.pendingApprovals ?? state.approvals.length;
  if ($("#metricGoals")) {
    $("#metricGoals").textContent = dashboard.goals ?? state.goals.length;
  }
  if ($("#metricBlocked")) {
    $("#metricBlocked").textContent = dashboard.blockedWorkItems ??
      state.workItems.filter((item) => item.state === "blocked").length;
  }
  if ($("#metricBudget")) {
    const budget = dashboard.budget;
    $("#metricBudget").textContent = budget?.availableMinor != null
      ? String(budget.availableMinor)
      : "—";
  }
  const recentOutputs = state.workItems.flatMap((item) => (item.trace?.outputs || []).map((output) => ({
    ...output, workItemId: item.id, workTitle: item.title, workState: item.state,
  }))).sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 4);
  if ($("#recentOutputs")) $("#recentOutputs").innerHTML = deliveryUi().renderOutputList(recentOutputs) || '<p class="muted">还没有交付成果。完成的报告和文件会出现在这里。</p>';
  const decisions = dashboard.decisions || [];
  if ($("#decisionList")) {
    $("#decisionList").classList.toggle("empty", !decisions.length);
    $("#decisionList").innerHTML = decisions.length
      ? decisions.map((item) => {
          const live = state.workItems.find((row) => row.id === item.id) || item;
          const reason = item.state === "blocked" ? blockReasonText(live) : "";
          const meta = item.state === "blocked"
            ? (reason ? `阻塞 · ${reason}` : "阻塞待接管")
            : "待验收";
          return `<button type="button" class="list-row inbox-row" data-select-work="${escapeHtml(item.id)}">
          <div><b>${escapeHtml(item.title)}</b><small>${escapeHtml(meta)}</small></div>
        </button>`;
        }).join("")
      : "没有待决策";
  }
  const goals = dashboard.goalHealth || state.goals;
  if ($("#goalHealth")) {
    $("#goalHealth").classList.toggle("empty", !goals.length);
    $("#goalHealth").innerHTML = goals.length
      ? goals.map((goal) => `<div class="list-row"><div><b>${escapeHtml(goal.title)}</b>
          <small>${goal.openWorkItems ?? 0} 条未完成</small></div></div>`).join("")
      : "还没有目标";
  }
  const pipelines = listFrom(dashboard, ["pipelines", "workItems"]);
  const source = pipelines.length ? pipelines : state.workItems;
  const items = workQueueItems(source, state.selectedWorkItemId, false);
  $("#pipelineList").classList.toggle("empty", !items.length);
  $("#pipelineList").innerHTML = items.length
    ? items.map((item) => `<button type="button" class="list-row inbox-row" data-select-work="${escapeHtml(item.id)}">
        <div><b>${escapeHtml(item.title || "未命名工作项")}</b><small>${escapeHtml(workItemMeta(item))}</small></div>
        <span class="gate">${escapeHtml(pipelineGate(item))}</span>
      </button>`).join("")
    : "暂无工作项";
}

function fillGoalProjectSelects() {
  for (const formId of ["demandForm", "ceoForm", "projectForm", "projectWorkspaceForm"]) {
    const goalSelect = $(`#${formId} [name=goalId]`);
    const projectSelect = $(`#${formId} [name=projectId]`);
    if (goalSelect) {
      const current = goalSelect.value;
      const empty = formId === "projectForm" ? "先选目标" : "不挂目标";
      goalSelect.innerHTML = `<option value="">${empty}</option>${
        state.goals.map((goal) =>
          `<option value="${escapeHtml(goal.id)}">${escapeHtml(goal.title)}</option>`).join("")
      }`;
      if (current && state.goals.some((goal) => goal.id === current)) goalSelect.value = current;
    }
    if (projectSelect) {
      const current = projectSelect.value;
      const goalId = goalSelect?.value;
      const projects = state.projects.filter((project) => !goalId || project.goalId === goalId);
      const empty = formId === "projectWorkspaceForm" ? "先选项目" : "不挂项目";
      projectSelect.innerHTML = `<option value="">${empty}</option>${
        projects.map((project) =>
          `<option value="${escapeHtml(project.id)}">${escapeHtml(project.title)}</option>`).join("")
      }`;
      if (current && projects.some((project) => project.id === current)) projectSelect.value = current;
    }
  }
  const workspaceSelect = $("#projectWorkspaceForm [name=workspaceIds]");
  if (workspaceSelect) {
    const selected = new Set([...workspaceSelect.selectedOptions].map((option) => option.value));
    workspaceSelect.innerHTML = (state.onboard.workspaces || []).map((workspace) =>
      `<option value="${escapeHtml(workspace.id)}"${selected.has(workspace.id) ? " selected" : ""}>${escapeHtml(workspace.label || workspace.rootPath || workspace.id)}</option>`,
    ).join("");
  }
  const deliverySelect = $("#deliveryProjectSelect");
  if (deliverySelect) {
    deliverySelect.innerHTML = `<option value="">先选项目</option>${
      state.projects.map((project) =>
        `<option value="${escapeHtml(project.id)}">${escapeHtml(project.title || project.id)}</option>`).join("")
    }`;
    if (state.deliveryProjectId) deliverySelect.value = state.deliveryProjectId;
  }
}

function mergeEmployees(...groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const employee of group || []) {
      if (!employee?.id) continue;
      const previous = byId.get(employee.id) || {};
      byId.set(employee.id, {
        ...previous,
        ...employee,
        profile: employee.profile || previous.profile,
        workspaces: Array.isArray(employee.workspaces)
          ? employee.workspaces
          : previous.workspaces,
        memories: Array.isArray(employee.memories)
          ? employee.memories
          : previous.memories,
      });
    }
  }
  return [...byId.values()];
}

function renderOrganization(payload) {
  const departments = payload?.departments || [];
  const positions = payload?.positions || [];
  const employees = mergeEmployees(state.employees, payload?.employees);
  state.org = { departments, positions, employees };
  state.employees = employees;
  const departmentIds = new Set(departments.map((department) => department.id));
  const childrenByParent = new Map();
  const positionsByDepartment = new Map();
  const employeesByPosition = new Map();
  const placed = new Set();

  for (const department of departments) {
    const parentId = departmentIds.has(department.parentId) ? department.parentId : null;
    const children = childrenByParent.get(parentId) || [];
    children.push(department);
    childrenByParent.set(parentId, children);
  }
  for (const position of positions) {
    const departmentPositions = positionsByDepartment.get(position.departmentId) || [];
    departmentPositions.push(position);
    positionsByDepartment.set(position.departmentId, departmentPositions);
  }
  for (const employee of employees) {
    const positionEmployees = employeesByPosition.get(employee.positionId) || [];
    positionEmployees.push(employee);
    employeesByPosition.set(employee.positionId, positionEmployees);
    if (employee.positionId) placed.add(employee.id);
  }

  const visited = new Set();
  const renderEmployee = (employee) => {
    const talent = employee.profile?.talentRole || "未绑定人才";
    const brain = modelLabelOf(employee.profile?.modelProfileId);
    const workspaceLabel = (employee.workspaces || []).length
      ? employee.workspaces.map((grant) =>
        `${grant.isDefault || grant.mode === "write" ? "写" : "读"}:${workspaceLabelOf(grant.workspaceId)}`).join(" · ")
      : "未授权项目目录";
    const skills = formatSkillList(employee.profile?.skills, 3);
    const skillHint = skills ? ` · 技能 ${skills}` : " · 未绑定技能";
    const memoryHint = (employee.memories || []).length
      ? ` · ${(employee.memories || []).length} 条经验记录`
      : "";
    const selected = employee.id === state.selectedEmployeeId ? " selected" : "";
    const title = `${employeeLabel(employee)}${skills ? `｜${skills}` : ""}`;
    return `<button type="button" class="org-node${selected}" data-employee-id="${escapeHtml(employee.id)}" title="${escapeHtml(title)}">
    <span class="avatar">${escapeHtml((employee.displayName || employee.name || "?").slice(0, 1))}</span>
    <div><b>${escapeHtml(employee.displayName || employee.name || "未命名")}</b>
    <small>${escapeHtml(talent)} · ${escapeHtml(brain)}${escapeHtml(skillHint)}${(employee.workspaces || []).length ? ` · ${escapeHtml(workspaceLabel)}` : " · 未授权工作目录"}${escapeHtml(memoryHint)}</small></div>
  </button>`;
  };
  const renderVacant = (position) => {
    const selected = position.id === state.selectedPositionId ? " selected" : "";
    return `<button type="button" class="org-vacant${selected}" data-hire-position="${escapeHtml(position.id)}">空缺</button>`;
  };
  const renderDepartment = (department) => {
    if (visited.has(department.id)) return "";
    visited.add(department.id);
    const departmentPositions = positionsByDepartment.get(department.id) || [];
    const childDepartments = childrenByParent.get(department.id) || [];
    const headcount = departmentPositions.reduce(
      (sum, position) => sum + (employeesByPosition.get(position.id) || []).length,
      0,
    );
    return renderDepartmentSection(
      department.id,
      department.name || "未命名部门",
      `${headcount} 人`,
      `${departmentPositions.map((position) => {
        const seated = employeesByPosition.get(position.id) || [];
        return `<div class="org-position">
          <div class="org-position-head"><b>${escapeHtml(position.title || "未命名岗位")}</b></div>
          ${seated.length ? seated.map(renderEmployee).join("") : renderVacant(position)}
        </div>`;
      }).join("")}
        ${childDepartments.map(renderDepartment).join("")}`,
    );
  };

  const roots = childrenByParent.get(null) || [];
  const orphans = employees.filter((employee) => !placed.has(employee.id));
  const tree = [
    ...roots.map(renderDepartment),
    ...departments.filter((department) => !visited.has(department.id)).map(renderDepartment),
    orphans.length
      ? renderDepartmentSection(
        "__orphans__",
        "未分岗",
        `${orphans.length} 人`,
        orphans.map(renderEmployee).join(""),
      )
      : "",
  ].join("");
  const headcount = $("#orgHeadcount");
  if (headcount) headcount.textContent = employees.length ? `${employees.length} 人` : "暂无员工";
  $("#organizationTree").classList.toggle("empty", !departments.length && !employees.length);
  $("#organizationTree").innerHTML = tree || "暂无部门";
  renderOrgWorkspaceGrant(employees);
  renderOnboardFields();
}

function renderOrgWorkspaceGrant(employees) {
  const panel = $("#orgWorkspaceGrant");
  const select = $("#orgDefaultWorkspace");
  if (!panel || !select) return;
  const missing = (employees || []).filter((employee) =>
    !(employee.workspaces || []).some((grant) => grant.isDefault && grant.mode === "write"),
  ).length;
  const workspaces = state.onboard.workspaces || [];
  panel.classList.toggle("hidden", missing === 0 || workspaces.length === 0);
  const previous = select.value;
  select.innerHTML = workspaces.map((workspace) =>
    `<option value="${escapeHtml(workspace.id)}">${escapeHtml(workspace.label || workspace.rootPath || workspace.id)}</option>`,
  ).join("");
  if (previous && workspaces.some((workspace) => workspace.id === previous)) {
    select.value = previous;
  }
  const button = $("#grantWorkspaceBtn");
  if (button) button.textContent = missing ? `授权主区 · ${missing}` : "授权主区";
}

function renderDepartmentSection(id, name, count, body) {
  const open = state.collapsedDepartments.has(id) ? "" : " open";
  return `<details class="org-department"${open} data-department-id="${escapeHtml(id)}">
    <summary class="org-department-head"><span class="org-department-label"><b>${escapeHtml(name)}</b></span><small>${escapeHtml(count)}</small></summary>
    <div class="org-branch">${body}</div>
  </details>`;
}

function persistCollapsedDepartments() {
  sessionStorage.setItem(
    "forgeCompany.collapsedDepartments",
    JSON.stringify([...state.collapsedDepartments]),
  );
}

function workspaceLabelOf(workspaceId) {
  const workspace = (state.onboard.workspaces || []).find((item) => item.id === workspaceId);
  return workspace?.label || workspace?.rootPath || workspaceId;
}

function positionTitle(positionId) {
  if (!positionId) return "";
  const pools = [
    ...(state.positions || []),
    ...(state.org.positions || []),
    ...(state.onboard.positions || []),
  ];
  const title = pools.find((position) => position.id === positionId)?.title;
  return title && title !== positionId ? title : "";
}

const TALENT_CATEGORY_ZH = {
  academic: "学术研究",
  design: "设计",
  engineering: "工程",
  finance: "财务",
  "game-development": "游戏开发",
  gis: "地理空间",
  marketing: "市场营销",
  "paid-media": "付费媒体",
  product: "产品",
  "project-management": "项目管理",
  sales: "销售",
  security: "安全",
  "spatial-computing": "空间计算",
  specialized: "专业服务",
  strategy: "战略",
  support: "运营支持",
  testing: "测试",
  other: "其他",
};

const TALENT_CATEGORY_KEYS = [
  "game-development",
  "paid-media",
  "project-management",
  "spatial-computing",
  "academic",
  "design",
  "engineering",
  "finance",
  "gis",
  "marketing",
  "product",
  "sales",
  "security",
  "specialized",
  "strategy",
  "support",
  "testing",
];

const talentPickerState = {
  active: "",
  hire: { query: "", category: "", selectedId: "", fallbackLabel: "", employeeId: "" },
  bind: { query: "", category: "", selectedId: "", fallbackLabel: "", employeeId: "" },
};

function talentCategoryOf(talent) {
  if (talent && talent.category) return talent.category;
  const id = String((talent && talent.id) || "");
  for (let i = 0; i < TALENT_CATEGORY_KEYS.length; i += 1) {
    const key = TALENT_CATEGORY_KEYS[i];
    if (id === key || id.startsWith(`${key}-`)) return key;
  }
  return "other";
}

function talentCategoryLabel(category) {
  return TALENT_CATEGORY_ZH[category] || category || "其他";
}

function talentSearchText(talent) {
  return [
    talent && talent.id,
    talent && talent.role,
    talent && talent.category,
    talentCategoryLabel(talentCategoryOf(talent)),
    talent && talent.description,
    ...((talent && talent.suggestedSkills) || []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function filterTalents(talents, query, category) {
  const q = String(query || "").trim().toLowerCase();
  return (talents || []).filter((talent) => {
    if (category && talentCategoryOf(talent) !== category) return false;
    if (!q) return true;
    return talentSearchText(talent).includes(q);
  });
}

function talentOptionLabel(talent) {
  const skills = formatSkillList(talent.suggestedSkills);
  return skills ? `${talent.role || talent.id} · ${skills}` : (talent.role || talent.id);
}

function talentCurrentLabel(talents, selectedId, fallbackLabel) {
  if (!selectedId) return "";
  const found = (talents || []).find((talent) => talent.id === selectedId);
  if (found) return talentOptionLabel(found);
  return fallbackLabel || selectedId;
}

function withSelectedTalent(talents, selectedId, fallbackLabel) {
  const list = Array.isArray(talents) ? [...talents] : [];
  if (selectedId && !list.some((talent) => talent.id === selectedId)) {
    list.unshift({
      id: selectedId,
      role: fallbackLabel || selectedId,
      category: talentCategoryOf({ id: selectedId }),
      suggestedSkills: [],
    });
  }
  return list;
}

function setTalentPicker(pickerId, selectedId, fallbackLabel, options = {}) {
  const slot = talentPickerState[pickerId];
  if (!slot) return;
  if (options.resetFilter || (pickerId === "bind" && options.employeeId !== slot.employeeId)) {
    slot.query = "";
    slot.category = "";
  }
  if (options.employeeId !== undefined) slot.employeeId = options.employeeId || "";
  slot.selectedId = selectedId || "";
  slot.fallbackLabel = fallbackLabel || "";
  renderTalentPicker(pickerId);
}

function talentModalOpen() {
  const modal = $("#talentModal");
  return Boolean(modal && !modal.classList.contains("hidden") && talentPickerState.active);
}

function openTalentModal(pickerId) {
  if (!talentPickerState[pickerId]) return;
  closeWorkspaceModal();
  talentPickerState.active = pickerId;
  $("#talentModal")?.classList.remove("hidden");
  renderTalentPicker(pickerId);
  requestAnimationFrame(() => $("#talentModal .talent-search")?.focus());
}

function closeTalentModal() {
  $("#talentModal")?.classList.add("hidden");
  talentPickerState.active = "";
}

function renderTalentPicker(pickerId) {
  const field = document.querySelector(`[data-talent-picker="${pickerId}"]`);
  const slot = talentPickerState[pickerId];
  if (!field || !slot) return;
  const hidden = field.querySelector("[name=talentTemplateId]");
  const current = field.querySelector(".talent-current");
  const catalog = withSelectedTalent(
    state.onboard?.talents || [],
    slot.selectedId,
    slot.fallbackLabel,
  );
  if (hidden) hidden.value = slot.selectedId;
  const label = talentCurrentLabel(catalog, slot.selectedId, slot.fallbackLabel);
  if (current) current.textContent = label || "未选择人才包";
  const modal = $("#talentModal");
  if (!modal || talentPickerState.active !== pickerId || modal.classList.contains("hidden")) return;
  const search = modal.querySelector(".talent-search");
  const cats = modal.querySelector(".talent-cats");
  const results = modal.querySelector(".talent-results");
  const modalCurrent = $("#talentModalCurrent");
  if (modalCurrent) modalCurrent.textContent = label ? `已选：${label}` : "未选择人才包";
  if (search && document.activeElement !== search) search.value = slot.query;
  const categories = [...new Set(catalog.map(talentCategoryOf))].sort((a, b) =>
    talentCategoryLabel(a).localeCompare(talentCategoryLabel(b), "zh"),
  );
  if (cats) {
    cats.innerHTML = [
      `<button type="button" class="talent-cat${!slot.category ? " on" : ""}" data-talent-cat="">全部</button>`,
      ...categories.map((category) =>
        `<button type="button" class="talent-cat${slot.category === category ? " on" : ""}" data-talent-cat="${escapeHtml(category)}">${escapeHtml(talentCategoryLabel(category))}</button>`),
    ].join("");
  }
  const matched = filterTalents(catalog, slot.query, slot.category)
    .sort((a, b) => (a.role || a.id).localeCompare(b.role || b.id, "zh"));
  if (!results) return;
  if (!catalog.length) {
    results.innerHTML = `<p class="talent-empty">暂无人才包，先去工作台同步人才</p>`;
    return;
  }
  if (!matched.length) {
    results.innerHTML = `<p class="talent-empty">没有匹配「${escapeHtml(slot.query || talentCategoryLabel(slot.category))}」的人才包</p>`;
    return;
  }
  const grouped = new Map();
  for (const talent of matched) {
    const key = talentCategoryOf(talent);
    const list = grouped.get(key) || [];
    list.push(talent);
    grouped.set(key, list);
  }
  results.innerHTML = [...grouped.entries()].map(([category, list]) => `
    <p class="talent-group">${escapeHtml(talentCategoryLabel(category))} · ${list.length}</p>
    ${list.map((talent) => {
      const selected = talent.id === slot.selectedId ? " on" : "";
      const skills = formatSkillList(talent.suggestedSkills);
      const blurb = skills
        ? `技能 ${skills}`
        : (talent.description || talentCategoryLabel(talentCategoryOf(talent)));
      return `<button type="button" class="talent-option${selected}" data-talent-id="${escapeHtml(talent.id)}">
        <b>${escapeHtml(talent.role || talent.id)}</b>
        <small>${escapeHtml(blurb)}</small>
      </button>`;
    }).join("")}
  `).join("");
}

function fillTalentSelect(select, selectedId, fallbackLabel) {
  const picker = select?.closest("[data-talent-picker]");
  if (!picker) return;
  setTalentPicker(picker.dataset.talentPicker, selectedId, fallbackLabel, {
    employeeId: picker.dataset.talentPicker === "bind" ? state.selectedEmployeeId : "",
  });
}

function modelOptionLabel(model) {
  if (!model) return "公司默认模型";
  return model.name && model.name !== model.id
    ? `${model.id} · ${model.name}`
    : (model.name || model.id);
}

function modelLabelOf(modelProfileId) {
  if (!modelProfileId) return "公司默认模型";
  const found = (state.onboard?.models || []).find((model) =>
    model.id === modelProfileId || model.name === modelProfileId);
  return found ? modelOptionLabel(found) : modelProfileId;
}

function fillModelSelect(select, selectedId) {
  if (!select) return;
  const models = state.onboard?.models || [];
  select.innerHTML = [
    `<option value="">公司默认模型</option>`,
    ...models.map((model) =>
      `<option value="${escapeHtml(model.id)}">${escapeHtml(modelOptionLabel(model))}</option>`),
  ].join("");
  select.value = selectedId || "";
}

function renderOnboardFields() {
  const options = state.onboard || { positions: [], talents: [], workspaces: [] };
  const selected = state.employees.find((employee) => employee.id === state.selectedEmployeeId)
    || state.org.employees.find((employee) => employee.id === state.selectedEmployeeId);
  const hirePosition = $("#hireForm [name=positionId]");
  if (hirePosition) {
    const selectedPosition = state.selectedPositionId;
    hirePosition.innerHTML = options.positions.length
      ? options.positions.map((position) => {
          const occupied = position.occupied && position.id !== selectedPosition;
          return `<option value="${escapeHtml(position.id)}" ${position.id === selectedPosition ? "selected" : ""} ${occupied ? "disabled" : ""}>${escapeHtml(position.title)}${position.occupied ? "（已有人）" : "（空缺）"}</option>`;
        }).join("")
      : `<option value="">暂无岗位</option>`;
    if (selectedPosition) hirePosition.value = selectedPosition;
  }
  const hireSeat = $("#hireSeatLabel");
  if (hireSeat) hireSeat.textContent = state.selectedPositionId ? positionTitle(state.selectedPositionId) : "选择空缺岗位";
  const hirePositionField = $(".hire-position-field");
  if (hirePositionField) hirePositionField.classList.toggle("hidden", Boolean(state.selectedPositionId));
  const hireTitle = positionTitle(state.selectedPositionId || hirePosition?.value);
  const hireName = $("#hireForm [name=displayName]");
  if (hireName && !hireName.value) {
    hireName.placeholder = RESEARCH_ROLE_PATTERN.test(hireTitle) ? "例如：闻启" : "例如：乔麦";
  }
  // Always prefer the talent pack mapped to this seat title (岗位 → 人才包).
  fillTalentSelect(
    $("#hireForm [name=talentTemplateId]"),
    suggestedTalentId(hireTitle) || $("#hireForm [name=talentTemplateId]")?.value || "",
  );
  fillTalentSelect(
    $("#bindForm [name=talentTemplateId]"),
    selected?.profile?.talentTemplateId,
    selected ? employeeTalentLabel(selected) : "",
  );
  fillModelSelect(
    $("#hireForm [name=modelProfileId]"),
    $("#hireForm [name=modelProfileId]")?.value,
  );
  fillModelSelect(
    $("#bindForm [name=modelProfileId]"),
    selected?.profile?.modelProfileId,
  );
  const bindEmployee = $("#bindForm [name=employeeId]");
  if (bindEmployee) bindEmployee.value = selected?.id || "";
  const bindName = $("#bindEmployeeName");
  if (bindName) bindName.textContent = selected?.displayName || selected?.name || "员工";
  const bindMeta = $("#bindEmployeeMeta");
  if (bindMeta) {
    bindMeta.textContent = selected
      ? `L${selected.autonomyLevel ?? 2} · ${positionTitle(selected.positionId) || "未分岗"}`
      : "权限";
  }
  const identity = $("#bindIdentity");
  if (identity) {
    identity.innerHTML = selected
      ? `<span class="avatar">${escapeHtml((selected.displayName || "?").slice(0, 1))}</span>
         <div><b>${escapeHtml(employeeLabel(selected))}</b>
         <small>${escapeHtml(selected.profile?.talentRole || "未绑定人才")} · ${escapeHtml(modelLabelOf(selected.profile?.modelProfileId))}</small></div>`
      : "";
  }
  const boundSkills = $("#bindBoundSkills");
  if (boundSkills) boundSkills.innerHTML = selected ? employeeBoundSkillsHtml(selected) : "";
  const kit = $("#bindKit");
  if (kit) kit.innerHTML = selected ? employeeKitHtml(selected) : "";
  renderWorkspacePicker("hireWorkspaces");
  renderWorkspacePicker("bindWorkspaces", selected?.workspaces || []);
  syncInspector({ silent: true });
}

const WORKSPACE_PAGE_SIZE = 8;
const workspacePickerState = {
  active: "",
  hire: { query: "", scope: "", page: 1, grants: new Map(), defaultId: "", employeeId: "" },
  bind: { query: "", scope: "", page: 1, grants: new Map(), defaultId: "", employeeId: "" },
};

function workspacePickerId(containerId) {
  return containerId === "hireWorkspaces" ? "hire" : "bind";
}

function workspaceName(path) {
  const parts = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function workspaceTitle(workspace) {
  return workspace?.label || workspaceName(workspace?.rootPath || workspace?.id || "");
}

function workspaceSearchText(workspace) {
  return [
    workspace && workspace.id,
    workspace && workspace.label,
    workspace && workspace.rootPath,
    workspaceName(workspace && (workspace.rootPath || workspace.id)),
  ].filter(Boolean).join(" ").toLowerCase();
}

function filterWorkspaces(workspaces, query, scope, grants, defaultId) {
  const q = String(query || "").trim().toLowerCase();
  const granted = new Set(
    Array.isArray(grants)
      ? grants
      : grants && typeof grants.keys === "function"
        ? [...grants.keys()]
        : [],
  );
  return (workspaces || []).filter((workspace) => {
    if (scope === "granted" && !granted.has(workspace.id)) return false;
    if (scope === "default" && workspace.id !== defaultId) return false;
    if (!q) return true;
    return workspaceSearchText(workspace).includes(q);
  });
}

function pageWorkspaces(items, page, pageSize) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.max(1, Number(pageSize) || 8);
  const count = list.length;
  const total = Math.max(1, Math.ceil(count / size) || 1);
  const current = Math.min(Math.max(1, Number(page) || 1), total);
  const start = (current - 1) * size;
  return { items: list.slice(start, start + size), page: current, total, count };
}

function applyWorkspaceGrants(slot, grants) {
  slot.grants = new Map();
  slot.defaultId = "";
  for (const grant of grants || []) {
    const mode = grant.mode === "write" || grant.isDefault ? "write" : grant.mode === "read" ? "read" : "";
    if (!mode) continue;
    slot.grants.set(grant.workspaceId, {
      mode,
      env: grant.env === "staging" || grant.env === "prod" ? grant.env : "dev",
    });
    if (grant.isDefault) slot.defaultId = grant.workspaceId;
  }
}

function resetWorkspacePicker(pickerId) {
  const slot = workspacePickerState[pickerId];
  if (!slot) return;
  slot.query = "";
  slot.scope = "";
  slot.page = 1;
  slot.employeeId = "";
  applyWorkspaceGrants(slot, []);
  renderWorkspacePicker(pickerId === "hire" ? "hireWorkspaces" : "bindWorkspaces");
}

function workspaceModalOpen() {
  const modal = $("#workspaceModal");
  return Boolean(modal && !modal.classList.contains("hidden") && workspacePickerState.active);
}

function openWorkspaceModal(pickerId) {
  if (!workspacePickerState[pickerId]) return;
  closeTalentModal();
  workspacePickerState.active = pickerId;
  $("#workspaceModal")?.classList.remove("hidden");
  renderWorkspaceModal();
  requestAnimationFrame(() => $("#workspaceModal .workspace-search")?.focus());
}

function closeWorkspaceModal() {
  $("#workspaceModal")?.classList.add("hidden");
  workspacePickerState.active = "";
}

function workspaceGrantSummary(slot) {
  const count = slot.grants.size;
  if (!count) return "未授权项目目录";
  const defaultName = listedWorkspace(slot.defaultId);
  if (defaultName) return `已授权 ${count} 个 · 主区 ${workspaceTitle(defaultName)}`;
  return `已授权 ${count} 个`;
}

function listedWorkspace(workspaceId) {
  return (state.onboard.workspaces || []).find((item) =>
    item.id === workspaceId || item.rootPath === workspaceId);
}

function renderWorkspacePicker(containerId, grants) {
  const pickerId = workspacePickerId(containerId);
  const slot = workspacePickerState[pickerId];
  const box = document.getElementById(containerId);
  if (!slot || !box) return;
  const employeeId = pickerId === "bind" ? state.selectedEmployeeId : "";
  const employeeChanged = pickerId === "bind" && employeeId !== slot.employeeId;
  if (employeeChanged) {
    slot.query = "";
    slot.scope = "";
    slot.page = 1;
    slot.employeeId = employeeId;
    applyWorkspaceGrants(slot, grants || []);
  } else if (pickerId === "bind" && !workspaceModalOpen()) {
    applyWorkspaceGrants(slot, grants || []);
  } else if (pickerId === "hire" && Array.isArray(grants)) {
    applyWorkspaceGrants(slot, grants);
  }
  const workspaces = state.onboard.workspaces || [];
  const granted = [...slot.grants.entries()]
    .map(([workspaceId, grant]) => {
      const workspace = listedWorkspace(workspaceId);
      return workspace
        ? { workspace, grant, isDefault: workspaceId === slot.defaultId || workspace.id === slot.defaultId }
        : null;
    })
    .filter(Boolean);
  const current = box.closest(".workspace-picker")?.querySelector(".workspace-open-current");
  const summary = workspaceGrantSummary(slot);
  if (current) current.textContent = summary;
  if (!workspaces.length) {
    box.innerHTML = `<p class="hint">工作台还没有项目目录。先在工作台打开一个项目。</p>`;
  } else if (!granted.length) {
    box.innerHTML = `<p class="hint">还没有授权目录。点下方「选择」搜索项目并指定主区。</p>`;
  } else {
    box.innerHTML = granted.map(({ workspace, grant, isDefault }) => {
      const name = workspaceTitle(workspace);
      const path = workspace.rootPath || "";
      return `<div class="workspace-chip">
        <div>
          <b>${escapeHtml(name)}</b>
          ${path ? `<small>${escapeHtml(path)}</small>` : ""}
        </div>
        <span>${isDefault ? "可写 · 主区" : grant.mode === "read" ? "只读" : "可写"}${workspaceEnvLabel(grant.env)}</span>
      </div>`;
    }).join("");
  }
  if (workspacePickerState.active === pickerId) renderWorkspaceModal();
}

function renderWorkspaceModal() {
  const modal = $("#workspaceModal");
  const pickerId = workspacePickerState.active;
  const slot = workspacePickerState[pickerId];
  if (!modal || !slot || modal.classList.contains("hidden")) return;
  const workspaces = state.onboard.workspaces || [];
  const search = modal.querySelector(".workspace-search");
  const cats = modal.querySelector(".workspace-cats");
  const results = modal.querySelector(".workspace-results");
  const pager = modal.querySelector(".workspace-pager");
  const current = $("#workspaceModalCurrent");
  if (current) current.textContent = workspaceGrantSummary(slot);
  if (search && document.activeElement !== search) search.value = slot.query;
  if (cats) {
    cats.innerHTML = [
      ["", "全部"],
      ["granted", "已授权"],
      ["default", "主区"],
    ].map(([scope, label]) =>
      `<button type="button" class="talent-cat${slot.scope === scope ? " on" : ""}" data-workspace-scope="${scope}">${label}</button>`,
    ).join("");
  }
  if (!results) return;
  if (!workspaces.length) {
    results.innerHTML = `<p class="talent-empty">工作台还没有项目目录</p>`;
    if (pager) pager.innerHTML = "";
    return;
  }
  const matched = filterWorkspaces(workspaces, slot.query, slot.scope, slot.grants, slot.defaultId)
    .sort((a, b) => workspaceTitle(a).localeCompare(workspaceTitle(b), "zh"));
  const paged = pageWorkspaces(matched, slot.page, WORKSPACE_PAGE_SIZE);
  slot.page = paged.page;
  if (!matched.length) {
    results.innerHTML = `<p class="talent-empty">没有匹配「${escapeHtml(slot.query || (slot.scope === "granted" ? "已授权" : "主区"))}」的项目</p>`;
  } else {
    results.innerHTML = paged.items.map((workspace) => {
      const grant = slot.grants.get(workspace.id);
      const mode = workspace.id === slot.defaultId ? "write" : grant?.mode || "";
      const isDefault = workspace.id === slot.defaultId;
      const path = workspace.rootPath || "";
      return `<div class="workspace-row">
        <div>
          <b>${escapeHtml(workspaceTitle(workspace))}</b>
          ${path ? `<small>${escapeHtml(path)}</small>` : ""}
        </div>
        <div class="workspace-actions">
          <select class="ws-mode" data-workspace-id="${escapeHtml(workspace.id)}">
            <option value="" ${mode === "" ? "selected" : ""}>不授权</option>
            <option value="read" ${mode === "read" ? "selected" : ""}>只读</option>
            <option value="write" ${mode === "write" ? "selected" : ""}>可写</option>
          </select>
          <label class="ws-opt"><input type="radio" name="workspace-default" value="${escapeHtml(workspace.id)}" ${isDefault ? "checked" : ""} />主区</label>
          <select class="ws-env" data-workspace-id="${escapeHtml(workspace.id)}" ${mode ? "" : "disabled"}>
            <option value="dev" ${grant?.env === "dev" || !grant?.env ? "selected" : ""}>开发</option>
            <option value="staging" ${grant?.env === "staging" ? "selected" : ""}>预发</option>
            <option value="prod" ${grant?.env === "prod" ? "selected" : ""}>生产</option>
          </select>
        </div>
      </div>`;
    }).join("");
  }
  if (pager) {
    pager.innerHTML = `
      <button type="button" data-ws-page="-1" ${paged.page <= 1 ? "disabled" : ""}>上一页</button>
      <span>${paged.count ? `${paged.page} / ${paged.total}` : "0 / 0"} · ${paged.count} 个</span>
      <button type="button" data-ws-page="1" ${paged.page >= paged.total ? "disabled" : ""}>下一页</button>`;
  }
}

function workspaceIdOf(element) {
  return element.getAttribute("data-workspace-id") || element.dataset.workspaceId || "";
}

function workspaceEnvLabel(env) {
  if (env === "prod") return " · 生产";
  if (env === "staging") return " · 预发";
  return "";
}

function setWorkspaceGrant(workspaceId, mode) {
  const slot = workspacePickerState[workspacePickerState.active];
  if (!slot || !workspaceId) return;
  const prev = slot.grants.get(workspaceId);
  if (!mode) {
    slot.grants.delete(workspaceId);
    if (slot.defaultId === workspaceId) slot.defaultId = "";
  } else {
    slot.grants.set(workspaceId, {
      mode,
      env: prev?.env === "staging" || prev?.env === "prod" ? prev.env : "dev",
    });
    if (mode !== "write" && slot.defaultId === workspaceId) slot.defaultId = "";
  }
  renderWorkspacePicker(workspacePickerState.active === "hire" ? "hireWorkspaces" : "bindWorkspaces");
}

function setWorkspaceEnv(workspaceId, env) {
  const slot = workspacePickerState[workspacePickerState.active];
  if (!slot || !workspaceId) return;
  const next = env === "staging" || env === "prod" ? env : "dev";
  const prev = slot.grants.get(workspaceId);
  slot.grants.set(workspaceId, {
    mode: prev?.mode || "write",
    env: next,
  });
  renderWorkspacePicker(workspacePickerState.active === "hire" ? "hireWorkspaces" : "bindWorkspaces");
}

function setWorkspaceDefault(workspaceId) {
  const slot = workspacePickerState[workspacePickerState.active];
  if (!slot || !workspaceId) return;
  const prev = slot.grants.get(workspaceId);
  slot.defaultId = workspaceId;
  slot.grants.set(workspaceId, {
    mode: "write",
    env: prev?.env === "staging" || prev?.env === "prod" ? prev.env : "dev",
  });
  renderWorkspacePicker(workspacePickerState.active === "hire" ? "hireWorkspaces" : "bindWorkspaces");
}

function workspaceGrantsFrom(containerId) {
  const slot = workspacePickerState[workspacePickerId(containerId)];
  if (!slot) return [];
  const known = new Set((state.onboard.workspaces || []).map((item) => item.id));
  const grants = [];
  const seen = new Set();
  for (const [workspaceId, grant] of slot.grants) {
    if (!workspaceId || seen.has(workspaceId)) continue;
    if (known.size && !known.has(workspaceId)) continue;
    seen.add(workspaceId);
    let mode = grant.mode;
    if (workspaceId === slot.defaultId) mode = "write";
    if (mode !== "read" && mode !== "write") continue;
    grants.push({
      workspaceId,
      mode,
      isDefault: workspaceId === slot.defaultId,
      ...(grant.env && grant.env !== "dev" ? { env: grant.env } : {}),
    });
  }
  if (slot.defaultId && !seen.has(slot.defaultId) && (!known.size || known.has(slot.defaultId))) {
    grants.push({ workspaceId: slot.defaultId, mode: "write", isDefault: true });
  }
  return grants;
}

function showBindError(message) {
  const el = $("#bindError");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("hidden", !message);
}

function showStaffTab(name, options = {}) {
  syncInspector({ ...options, tab: name });
}

function syncInspector(options = {}) {
  const requested = options.tab || state.staffTab;
  const mode = state.selectedEmployeeId
    ? "bind"
    : state.selectedPositionId || requested === "hire"
      ? "hire"
      : "idle";
  state.staffTab = mode;
  const idle = $("#orgIdle");
  if (idle) idle.classList.toggle("hidden", mode !== "idle");
  $$("[data-staff-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.staffPanel !== mode);
  });
}

function canApprove(actorId, assigneeId) {
  const normalizedActorId = String(actorId || "").trim();
  return Boolean(normalizedActorId && normalizedActorId !== String(assigneeId || "").trim());
}

function approvalPreviewHtml(preview) {
  if (!preview?.summary) {
    return `<p class="review-preview pending">尚无预审结论。请先查看执行成果，再做验收决定。</p>`;
  }
  const verdict = preview.recommendation === "approved"
    ? "建议通过"
    : preview.recommendation === "rejected"
      ? "建议驳回"
      : "预审未完成";
  const findings = (preview.findings || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  return `<div class="review-preview ${preview.recommendation || "pending"}">
    <b>${escapeHtml(preview.reviewerName || "审批人")} · ${escapeHtml(verdict)}</b>
    <small>预审对照执行成果，不是最终验收。${escapeHtml(preview.talentRole ? `人才包 ${preview.talentRole} · ` : "")}${escapeHtml(preview.summary)}</small>
    ${findings ? `<ul>${findings}</ul>` : ""}
  </div>`;
}

function renderApprovals() {
  const actorSelect = $("#approvalActorId");
  if (!actorSelect.value.trim()) {
    const reviewer = state.approvals.find((item) => item.preview?.reviewerId)?.preview?.reviewerId;
    if (reviewer) actorSelect.value = reviewer;
  }
  const actorId = actorSelect.value.trim();
  $("#approvalList").classList.toggle("empty", !state.approvals.length);
  $("#approvalList").innerHTML = state.approvals.length
    ? state.approvals.map((item) => {
        const approvalAllowed = canApprove(actorId, item.assigneeId);
        const disabledReason = actorId ? "不能批准自己的提交" : "请选择审批人";
        const preview = item.preview;

        return `<article class="approval-row" data-work-item="${escapeHtml(item.workItemId || item.id)}" data-assignee="${escapeHtml(item.assigneeId || "")}">
          <div><b>${escapeHtml(item.title || "未命名工作项")}</b>
          <small>执行人：${escapeHtml(employeeLabel(item.assigneeId))} · ${escapeHtml(workStateLabel(item.state || "waiting_approval"))}</small>
          ${approvalPreviewHtml(preview)}<div class="approval-outputs">${workOutputsHtml(state.workItems.find((row) => row.id === (item.workItemId || item.id)))}</div></div>
          <input data-reason placeholder="驳回后会开修复单，并回到工作中心继续" value="${escapeHtml(preview?.summary || "")}" />
          <button data-decision="approved" ${approvalAllowed ? "" : `disabled title="${disabledReason}"`}>确认通过</button>
          <button class="danger" data-decision="rejected">驳回并开修复单</button>
        </article>`;
      }).join("")
    : "暂无待审批。执行完成后，可在这里查看成果并验收。<button type=\"button\" class=\"ghost\" data-nav=\"work\">去工作中心</button>";
  const history = $("#approvalHistory");
  if (!history) return;
  history.classList.toggle("empty", !state.decisions.length);
  history.innerHTML = state.decisions.length
    ? state.decisions.map((item) => {
        const label = item.decision === "approved" ? "已通过" : "已驳回";
        return `<div class="list-row"><div><b>${escapeHtml(item.title || "未命名工作项")}</b>
          <small>${escapeHtml(label)}${item.reason ? ` · ${escapeHtml(item.reason)}` : ""}${item.createdAt ? ` · ${escapeHtml(formatWorkTime(item.createdAt))}` : ""}</small></div>
          <button type="button" data-select-work="${escapeHtml(item.workItemId || "")}">查看工作项</button></div>`;
      }).join("")
    : "还没有审批记录。";
}

function addTrace(label, result) {
  const runId = result?.runId || (result?.id?.startsWith?.("run_") ? result.id : "");
  state.traces.unshift({ label, result, runId });
  renderWorkCenter();
}

function describeTrace(label, value, runId) {
  if (label === "已派活") {
    return `已指定执行人 ${employeeLabel(value.assigneeId)}，工作项变为 ${value.state || "ready"}。这只是派工，还没有开始写代码或产出文件。`;
  }
  if (label === "执行请求") {
    return runId
      ? `已创建工作台 Run ${runId}。`
      : "计划门已通过，只预占了执行位，没有创建工作台 Run。所以工作台不会动，也不会有交付物。";
  }
  const details = [
    value.title && `「${value.title}」`,
    value.version != null && `v${value.version}`,
    runId && `Run ${runId}`,
  ].filter(Boolean);
  return details.join(" · ") || JSON.stringify(value);
}

function draftSpecFromDemand(item) {
  return [
    `# ${item.title || item.id}`,
    "",
    "## 问题",
    item.problem || "",
    "",
    "## 验收标准",
    item.expectedOutcome || "",
  ].join("\n");
}

function draftPlanFromDemand(item) {
  if (isResearchWork(item)) {
    return [
      `# ${item.title || item.id} 调研计划`, "", "## 调研问题", item.problem || "", "", "## 步骤",
      "1. 收集证据，记录信息来源、时间与适用范围。",
      "2. 区分已知结论与待验证问题，评估可行性与风险。",
      `3. 提交调研报告与下一步建议，对照预期结果核验：${item.expectedOutcome || ""}`,
    ].join("\n");
  }
  return [
    `# ${item.title || item.id} 实施计划`,
    "",
    "## 依据",
    item.problem || "",
    "",
    "## 步骤",
    "1. 按规格实现最小改动。",
    `2. 对照验收标准自验：${item.expectedOutcome || ""}`,
    "3. 提交结果并等待独立验收。",
  ].join("\n");
}

const PRODUCT_ROLE_PATTERN = /产品|规格|需求|PM/i;
const RESEARCH_ROLE_PATTERN = /市场|调研|研究|情报/i;
const MARKET_RESEARCHER_TALENT_ID = "product-trend-researcher";

/** Fallback when onboard.positions lack talentTemplateId (older daemon). */
const SEAT_TALENT_BY_TITLE = {
  "研发负责人": "engineering-software-architect",
  "执行工程师": "engineering-senior-developer",
  "质量负责人": "engineering-code-reviewer",
  "产品助理": "product-behavioral-nudge-engine",
  "市场调查员": MARKET_RESEARCHER_TALENT_ID,
  "设计师": "design-ui-designer",
  "增长运营": "marketing-growth-hacker",
  "客户支持": "support-support-responder",
  "财务合规": "support-legal-compliance-checker",
};

function selectedWorkItem() {
  return state.workItems.find((item) => item.id === state.selectedWorkItemId);
}

function isResearchWork(item) {
  if (!item) return false;
  if (item.type === "research") return true;
  if (item.type === "implementation" || item.type === "fix") return false;
  return /调研|市场|可行|竞品|情报/.test(`${item.title || ""} ${item.problem || ""}`);
}

function employeeByRole(pattern) {
  return state.employees.find((employee) =>
    pattern.test(positionTitle(employee.positionId)));
}

function suggestedTalentId(title) {
  const needle = String(title || "").trim();
  if (!needle) return "";
  const fromOnboard = (state.onboard?.positions || []).find((position) => position.title === needle);
  if (fromOnboard?.talentTemplateId) return fromOnboard.talentTemplateId;
  if (SEAT_TALENT_BY_TITLE[needle]) return SEAT_TALENT_BY_TITLE[needle];
  return RESEARCH_ROLE_PATTERN.test(needle) ? MARKET_RESEARCHER_TALENT_ID : "";
}

function pickDefaultDrafterId(item) {
  const stored = sessionStorage.getItem(`forgeCompany.drafterId.${item.id}`);
  if (stored !== null) return stored;
  if (isResearchWork(item)) {
    const researcher = employeeByRole(RESEARCH_ROLE_PATTERN);
    if (researcher) return researcher.id;
  }
  const product = employeeByRole(PRODUCT_ROLE_PATTERN);
  if (product) return product.id;
  if (item.ownerId && state.employees.some((employee) => employee.id === item.ownerId)) {
    return item.ownerId;
  }
  return "";
}

function pickDefaultAssigneeId(item) {
  if (item?.assigneeId) return item.assigneeId;
  if (isResearchWork(item)) {
    const researcher = employeeByRole(RESEARCH_ROLE_PATTERN);
    if (researcher) return researcher.id;
    const product = employeeByRole(PRODUCT_ROLE_PATTERN);
    if (product) return product.id;
  }
  return state.employees.find(hasDefaultWriteWorkspace)?.id || "";
}

function renderDrafterOptions(selectedId) {
  const select = $("#gateForm [name=drafterId]");
  if (!select) return;
  select.innerHTML = [
    `<option value="">模型代写</option>`,
    ...state.employees.map((employee) =>
      `<option value="${escapeHtml(employee.id)}">${escapeHtml(employeeLabel(employee))}</option>`,
    ),
  ].join("");
  select.value = selectedId ?? "";
}

let draftInFlight = false;

function draftModelLabel(employee) {
  const modelId = employee?.profile?.modelProfileId;
  return modelId ? modelLabelOf(modelId) : "公司默认模型";
}

async function draftArtifacts() {
  const workItemId = $("#gateForm [name=workItemId]").value.trim();
  if (!workItemId) return toast("先选中一条工作项", true);
  if (draftInFlight) return toast("上一轮还在调用模型，先等它结束。大约半分钟。");
  const item = state.workItems.find((entry) => entry.id === workItemId);
  if (item?.specVersion != null && item?.planVersion != null) {
    return toast("规格和计划已接受，不再自动重写");
  }
  const draftKey = workDraftKey(workItemId, item?.companyId || state.companyId);
  const draftBeforeRequest = JSON.stringify(workDrafts.get(draftKey));
  const drafterId = $("#gateForm [name=drafterId]").value;
  const actorId = $("#gateForm [name=actorId]").value.trim();
  const drafter = employeeOf(drafterId);
  const waiting = drafter
    ? `正在调用「${employeeLabel(drafter)}」的${draftModelLabel(drafter)}，大约 30–90 秒。下面先显示占位稿，不是失败。`
    : "正在用公司默认模型起草，大约 30–90 秒。下面先显示占位稿，不是失败。";
  const hint = $("#workInboxHint");
  const button = $("#draftArtifactsBtn");
  sessionStorage.setItem(`forgeCompany.drafterId.${workItemId}`, drafterId);
  draftInFlight = true;
  if (hint) hint.textContent = waiting;
  if (button) {
    button.disabled = true;
    button.textContent = "正在调用模型…";
  }
  try {
    const result = await action("起草规格与计划", () => invoke(METHODS.draftArtifacts, {
      workItemId,
      drafterId: drafterId || undefined,
      actorId: actorId || undefined,
    }));
    const draft = { spec: result?.spec || item?.specDraft || "", plan: result?.plan || item?.planDraft || "" };
    if (JSON.stringify(workDrafts.get(draftKey)) !== draftBeforeRequest) {
      toast("起草已完成；你在等待期间修改了草稿，已保留你的编辑。");
      return result;
    }
    const saved = workDrafts.set(draftKey, draft);
    if (state.selectedWorkItemId === workItemId) {
      $("#gateForm [name=spec]").value = draft.spec;
      $("#gateForm [name=plan]").value = draft.plan;
      draftNotice($("#gateForm"), saved ? "草稿已保存到本机" : "本机保存失败，草稿仅保留在当前页面");
    }
    const sourceLabel = result?.source === "employee"
      ? (result.talentRole
        ? `已按所选员工人才包起草（${result.talentRole}）`
        : "已按所选员工人才包起草")
      : result?.source === "model"
        ? "已用模型代写"
        : result?.error
          ? `模型起草失败（${result.error}），已按需求模板起草`
          : "模型不可用，已按需求模板起草";
    toast(sourceLabel, result?.source === "template");
    return result;
  } finally {
    draftInFlight = false;
    if (button) {
      button.disabled = false;
      button.textContent = "按人才包起草";
    }
    if (hint) hint.textContent = nextStepHint(selectedWorkItem());
  }
}

function nextStepHint(item) {
  if (!item) return "选择左侧任务，查看成果或继续处理。";
  const title = item.title || "未命名任务";
  if (["accepted", "completed"].includes(item.state)) return `「${title}」已完成，可在下方查看成果。`;
  if (["submitted", "waiting_approval", "verifying"].includes(item.state)) return `「${title}」等待验收。先查看成果，再到审批页确认。`;
  if (item.state === "cancelled") return `「${title}」已取消，已保存的记录仍可查看。`;
  if (item.currentGate === "等待输入" || latestLinkedRun(item)?.state === "waiting") return `「${title}」需要补充输入，请在工作台处理后刷新。`;
  if (item.openFix?.id) return `「${title}」${blockReasonText(item) ? `：${blockReasonText(item)}。` : ""}已有修复单「${item.openFix.title}」，请继续处理修复任务。`;
  if (item.state === "blocked" || item.state === "rejected") return `「${title}」需要处理：${blockReasonText(item) || "请查看执行记录中的失败原因"}。`;
  if (item.type === "fix" && (item.specVersion == null || item.planVersion == null)) return `修复任务已带入原文和驳回点，请确认需求与计划后安排执行。`;
  if (item.specVersion == null || item.planVersion == null) return `先确认「${title}」的需求与计划。可以自动起草，也可以直接编辑。`;
  if (item.state === "in_progress") return `「${title}」正在执行，成果生成后会显示在下方。`;
  return `「${title}」已准备好，请选择执行人并安排执行。`;
}

function selectWorkItem(item) {
  if (!item?.id) return;
  state.selectedWorkItemId = item.id;
  sessionStorage.setItem("forgeCompany.selectedWorkItemId", item.id);
  setSelectedWorkTitle(item);
  const ownerId = item.ownerId || "";
  $("#gateForm [name=workItemId]").value = item.id;
  fillEmployeeSelect($("#gateForm [name=actorId]"), ownerId);
  renderDrafterOptions(pickDefaultDrafterId(item));
  const localDraft = workDrafts.get(workDraftKey(item.id, item.companyId || state.companyId));
  $("#gateForm .draft-notice")?.remove();
  if (localDraft) draftNotice($("#gateForm"), "已恢复本机未提交草稿；提交前请核对最新需求与计划。");
  $("#gateForm [name=spec]").value = localDraft?.spec ?? (item.specDraft || draftSpecFromDemand(item));
  $("#gateForm [name=plan]").value = localDraft?.plan ?? (item.planDraft || draftPlanFromDemand(item));
  $("#dispatchForm [name=workItemId]").value = item.id;
  renderDispatchAssignees(item);
  $("#fixForm [name=workItemId]").value = item.id;
  fillEmployeeSelect($("#fixForm [name=ownerId]"), ownerId);
  const halt = $("#fixForm")?.closest("article");
  if (halt) {
    halt.classList.toggle("hidden", Boolean(item.openFix) || item.type === "fix");
  }
  const dispatchSubmit = $("#dispatchForm button[type=submit]");
  if (dispatchSubmit) {
    dispatchSubmit.disabled = Boolean(item.openFix) || item.state === "blocked" || item.state === "rejected";
  }
  const hint = $("#workInboxHint");
  if (hint) hint.textContent = nextStepHint(item);
  renderWorkBlockReason(item);
  applyWorkStage(item, { scroll: true });
  renderWorkInbox();
}

function renderWorkInbox() {
  const inbox = $("#workInbox");
  if (!inbox) return;
  const showAll = Boolean($("#showAllWorkItems")?.checked);
  const items = workQueueItems(state.workItems, state.selectedWorkItemId, showAll);
  inbox.classList.toggle("empty", !items.length);
  inbox.innerHTML = items.length
    ? items.map((item) => {
        const selected = item.id === state.selectedWorkItemId ? " selected" : "";
        const hidden = showAll ? 0 : hiddenDuplicateCount(state.workItems, item);
        return `<button type="button" class="list-row inbox-row${selected}" data-select-work="${escapeHtml(item.id)}">
          <div><b>${escapeHtml(item.title || "未命名工作项")}</b>
          <small>${escapeHtml(workItemMeta(item))}</small>
          ${hidden ? `<small class="dup-note">另有 ${hidden} 条同题未列出</small>` : ""}</div>
          <span class="gate">${item.id === state.selectedWorkItemId ? "已选中" : "继续处理"}</span>
        </button>`;
      }).join("")
    : "暂无工作项。用左侧 CEO 登记，或在下方新建一条需求。";
  const selected = state.workItems.find((item) => item.id === state.selectedWorkItemId);
  const hint = $("#workInboxHint");
  if (hint) hint.textContent = nextStepHint(selected);
  renderWorkBlockReason(selected);
  renderSelectedResults(selected);
  applyWorkStage(selected);
}

function workFocusStage(item) {
  if (!item) return "";
  if (["accepted", "completed", "cancelled"].includes(item.state)) return "done";
  if (["submitted", "waiting_approval", "verifying"].includes(item.state)) return "approval";
  if (item.openFix?.id) return "trace";
  if (item.state === "blocked") return item.type === "fix" ? "gate" : "halt";
  if (item.specVersion == null || item.planVersion == null) return "gate";
  if (["submitted", "waiting_approval", "verifying"].includes(item.state)) return "approval";
  if (["accepted", "completed"].includes(item.state)) return "done";
  if (["in_progress"].includes(item.state) || ["running", "waiting"].includes(latestLinkedRun(item)?.state)) {
    return "trace";
  }
  return "dispatch";
}

function applyWorkStage(item, options = {}) {
  const focus = workFocusStage(item);
  const nodes = {
    gate: $("#gateStage"),
    dispatch: $("#dispatchStage"),
    halt: $("#fixStage"),
    trace: $("#traceStage"),
  };
  Object.entries(nodes).forEach(([key, node]) => {
    if (!node) return;
    const visible = key === "gate" ? focus === "gate"
      : key === "dispatch" ? focus === "dispatch"
      : key === "halt" ? focus === "halt" || focus === "trace" && item?.state === "in_progress" && !item?.openFix
      : Boolean(item);
    node.classList.toggle("hidden", !visible);
    node.classList.toggle("is-current", key === focus || (focus === "approval" && key === "trace") || (focus === "done" && key === "trace"));
  });
  const strip = $("#workLoopSteps");
  if (strip) {
    const steps = [
      { id: "gate", label: "规格/计划" },
      { id: "dispatch", label: "派活" },
      { id: "trace", label: "执行" },
      { id: "approval", label: "验收" },
    ];
    strip.innerHTML = item
      ? steps.map((step) => {
          const on = step.id === focus || (focus === "done" && step.id === "approval");
          return `<li class="${on ? "on" : ""}">${step.label}</li>`;
        }).join("")
      : "";
  }
  const goApproval = $("#workGoApprovalBtn");
  if (goApproval) goApproval.classList.toggle("hidden", focus !== "approval");
  const current = nodes[focus] || (focus === "approval" || focus === "done" ? nodes.trace : null);
  if (options.scroll && current?.scrollIntoView && item) {
    current.scrollIntoView({ block: "nearest" });
  }
}

function renderWorkCenter() {
  renderWorkInbox();
}

async function loadData() {
  const version = ++loadVersion;
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
  const [companyResult, dashboardResult, workResult, employeeResult, approvalResult, orgResult, onboardResult, goalsResult, projectsResult] = await Promise.allSettled([
    invoke(METHODS.company, params),
    invoke(METHODS.dashboard, params),
    invoke(METHODS.workItems, params),
    invoke(METHODS.employees, params),
    invoke(METHODS.approvals, params),
    invoke(METHODS.organization, params),
    invoke(METHODS.onboardOptions, params),
    invoke(METHODS.goals, params),
    invoke(METHODS.projects, params),
  ]);
  if (version !== loadVersion) return;
  if (companyResult.status === "fulfilled") {
    state.companyName = companyResult.value?.name || state.companyName;
    if (state.companyName) localStorage.setItem("forgeCompany.companyName", state.companyName);
    $("#companyLabel").textContent = state.companyName || state.companyId;
  }
  if (employeeResult.status === "fulfilled") {
    state.employees = mergeEmployees(
      state.employees,
      listFrom(employeeResult.value, ["employees", "items"]),
    );
  }
  const orgPayload = orgResult.status === "fulfilled" ? orgResult.value : state.org;
  if (orgResult.status === "fulfilled") {
    state.positions = orgPayload?.positions || [];
  }
  if (workResult.status === "fulfilled") {
    state.workItems = listFrom(workResult.value, ["workItems", "items"]);
    if (state.selectedWorkItemId) {
      const selected = state.workItems.find((item) => item.id === state.selectedWorkItemId);
      if (selected) selectWorkItem(selected);
    }
  }
  if (approvalResult.status === "fulfilled") {
    state.approvals = listFrom(approvalResult.value, ["pending", "approvals", "items"]);
    state.decisions = listFrom(approvalResult.value, ["decisions"]);
    const missing = state.approvals.filter((item) => !item.preview?.summary);
    if (missing.length) {
      await Promise.allSettled(
        missing.map((item) => invoke(METHODS.previewApproval, { workItemId: item.id })),
      );
      try {
        const refreshed = await invoke(METHODS.approvals, params);
        if (version !== loadVersion) return;
        state.approvals = listFrom(refreshed, ["pending", "approvals", "items"]);
        state.decisions = listFrom(refreshed, ["decisions"]);
      } catch {}
    }
    const reviewerId = state.approvals.find((item) => item.preview?.reviewerId)?.preview?.reviewerId;
    if (reviewerId && !$("#approvalActorId").value.trim()) {
      $("#approvalActorId").value = reviewerId;
    }
  }
  if (version !== loadVersion) return;
  if (onboardResult.status === "fulfilled") {
    state.onboard = {
      positions: onboardResult.value?.positions || [],
      talents: onboardResult.value?.talents || [],
      models: onboardResult.value?.models || [],
      workspaces: onboardResult.value?.workspaces || [],
    };
  }
  if (goalsResult.status === "fulfilled") {
    state.goals = listFrom(goalsResult.value, ["goals", "items"]);
    if (!state.goals.length && Array.isArray(goalsResult.value)) state.goals = goalsResult.value;
  }
  if (projectsResult.status === "fulfilled") {
    state.projects = listFrom(projectsResult.value, ["projects", "items"]);
    if (!state.projects.length && Array.isArray(projectsResult.value)) {
      state.projects = projectsResult.value;
    }
  }
  if ((!deliverySelectionInitialized && !state.deliveryProjectId) || (state.deliveryProjectId && !state.projects.some((project) => project.id === state.deliveryProjectId))) {
    state.deliveryProjectId = state.projects[0]?.id || "";
    if (state.deliveryProjectId) sessionStorage.setItem("forgeCompany.deliveryProjectId", state.deliveryProjectId);
  }
  deliverySelectionInitialized = true;
  state.deliveryGatesError = false;
  if (!state.deliveryProjectId) { state.deliveryGates = {}; state.deliveryGateSnapshots = {}; }
  if (state.deliveryProjectId) {
    const projectId = state.deliveryProjectId;
    const kinds = ["research", "scope", "technical", "release"];
    const latest = await Promise.allSettled(
      kinds.map(async (gate) => {
        const params = { companyId: state.companyId, projectId, gate };
        const [decision, snapshot] = await Promise.all([
          invoke(METHODS.deliveryGateLatest, params), invoke(METHODS.deliveryGateSnapshot, params),
        ]);
        if (!Array.isArray(snapshot?.inputVersionRefs) || typeof snapshot?.ready !== "boolean") throw new Error("invalid decision snapshot");
        return { decision, snapshot };
      }),
    );
    if (version !== loadVersion || projectId !== state.deliveryProjectId) return;
    state.deliveryGatesError = latest.some((result) => result.status === "rejected");
    state.deliveryGates = Object.fromEntries(
      kinds.map((gate, index) => [
        gate,
        latest[index].status === "fulfilled" ? latest[index].value.decision : null,
      ]),
    );
    state.deliveryGateSnapshots = Object.fromEntries(kinds.map((gate, index) => [gate,
      latest[index].status === "fulfilled" ? latest[index].value.snapshot : null,
    ]));
  }
  state.researchWorkflow = null;
  if (state.deliveryProjectId) {
    const projectId = state.deliveryProjectId;
    const briefId = deliveryModel().researchItems[0]?.researchBriefId || "";
    try {
      const status = await invoke(METHODS.researchWorkflowStatus, {
        companyId: state.companyId,
        projectId,
        ...(briefId ? { briefId } : {}),
      });
      // Never paint another idea's synthesis under the current idea card.
      if (
        version === loadVersion
        && projectId === state.deliveryProjectId
        && (!briefId || !status?.briefId || status.briefId === briefId)
      ) {
        state.researchWorkflow = status || null;
      }
    } catch {
      state.researchWorkflow = null;
    }
  }
  try {
    const capabilities = await invoke(METHODS.workflowCapabilities, {});
    if (version !== loadVersion) return;
    state.workflowCapabilities = Array.isArray(capabilities) ? capabilities : [];
  } catch {
    state.workflowCapabilities = [];
  }
  fillGoalProjectSelects();
  renderOverview(dashboardResult.status === "fulfilled" ? dashboardResult.value : {});
  renderWorkCenter();
  renderOrganization({
    departments: orgPayload?.departments || [],
    positions: orgPayload?.positions || [],
    employees: mergeEmployees(state.employees, orgPayload?.employees),
  });
  renderPersonSelects(
    state.workItems.find((item) => item.id === state.selectedWorkItemId),
  );
  renderApprovals();
  renderDelivery();
  const failures = [companyResult, dashboardResult, workResult, employeeResult, approvalResult, orgResult, onboardResult, goalsResult, projectsResult]
    .filter((result) => result.status === "rejected");
  const unavailable = failures.length + Number(state.deliveryGatesError);
  $("#globalStatus").textContent = unavailable ? `部分数据不可用 (${unavailable})，请重试刷新` : "已同步";
}

function deliveryUi() {
  return window.ForgeDeliveryUi;
}

function deliveryOwner() {
  const research = deliveryModel().researchItems[0];
  return employeeOf(research?.ownerId) || state.employees[0] || {};
}

function deliveryModel() {
  return deliveryUi().buildResultsModel(state.workItems, state.deliveryProjectId);
}

function deliveryDraftKey(formId, projectId = state.deliveryProjectId) {
  return JSON.stringify([state.companyId, projectId, formId]);
}

function rememberFormDraft(event) {
  const form = event.target.closest("form");
  if (!form) return;
  if (form.id === "gateForm") {
    const values = formValues(form);
    if (values.workItemId) {
      const saved = workDrafts.set(workDraftKey(values.workItemId), { spec: form.elements.spec.value, plan: form.elements.plan.value });
      draftNotice(form, saved ? "草稿已保存到本机" : "本机保存失败，草稿仅保留在当前页面");
    }
  }
  if (["deliveryIntakeForm", "deliveryGateForm"].includes(form.id)) {
    const saved = deliveryDrafts.set(deliveryDraftKey(form.id), formValues(form));
    draftNotice(form, saved ? "草稿已保存到本机" : "本机保存失败，草稿仅保留在当前页面");
  }
}

function restoreDeliveryDrafts() {
  for (const id of ["deliveryIntakeForm", "deliveryGateForm"]) {
    const form = document.getElementById(id);
    const draft = deliveryDrafts.get(deliveryDraftKey(id));
    if (!form || !draft) continue;
    for (const [name, value] of Object.entries(draft)) {
      if (form.elements.namedItem(name) && !["actorId", "projectId"].includes(name)) form.elements.namedItem(name).value = value;
    }
    draftNotice(form, "已恢复本机未提交草稿");
    if (form.closest("details")) form.closest("details").open = true;
  }
}

function renderDelivery() {
  const ui = deliveryUi();
  if (!ui) return;
  const model = deliveryModel();
  const hasDevelopment = model.items.some((item) => item.type === "implementation" || item.type === "fix");
  const owner = deliveryOwner();
  const researchDecision = state.deliveryGates.research;
  const superseded = Boolean(model.researchItems[0]?.createdAt && researchDecision?.decidedAt && model.researchItems[0].createdAt > researchDecision.decidedAt);
  const stopped = state.deliveryGateSnapshots.research?.projectState === "completed" && !superseded && researchDecision?.outcome === "stopped";
  const workflowHasResults = Boolean(state.researchWorkflow?.synthesisRecommendation || state.researchWorkflow?.claims?.length);
  const hasDeliveryResults = model.hasResults || workflowHasResults || state.deliveryGateSnapshots.research?.ready === true;
  const hint = $("#deliveryNextHint");
  if (hint) hint.textContent = !state.deliveryProjectId ? "选择项目，查看它的调研结论、报告和交付进度。"
    : stopped ? "调研已归档。结论、报告与决策记录保留在当前项目中。"
    : hasDeliveryResults ? "调研成果已到达。先阅读报告，再决定下一步。"
    : "调研结果生成后会显示在这里；需求原文保留在下方的需求背景中。";
  $$("#deliveryLoopSteps [data-loop]").forEach((step) => {
    step.classList.toggle("on", step.dataset.loop === "research");
  });
  $("#deliveryResearchHost").innerHTML = ui.renderResearchPage({ ...model, workflow: state.researchWorkflow });
  $("#deliveryArtifactsHost").innerHTML = ui.renderArtifactsPanel({ ...model, workflow: state.researchWorkflow });
  $("#deliveryIntakeHost").innerHTML = ui.renderIntakePage({
    isNew: !model.items.length,
    existing: model.researchItems[0],
    keepOpen: Boolean(state.deliveryIntakeKeepOpen),
    archived: state.deliveryGateSnapshots.research?.projectState === "completed",
  });
  const researchCapability = state.workflowCapabilities.find((entry) => entry.workflowId === RESEARCH_WORKFLOW_ID);
  const feasibilityHost = $("#deliveryFeasibilityHost");
  if (feasibilityHost) {
    const latestIdea = model.researchItems[0];
    feasibilityHost.innerHTML = state.deliveryProjectId && !stopped ? ui.renderFeasibilityStart({
      runnable: researchCapability?.runnable === true,
      projectId: state.deliveryProjectId,
      briefId: latestIdea?.researchBriefId || "",
      pending: state.feasibilityPending,
      nextAction: researchDecision?.outcome === "approved" && !superseded ? researchDecision.nextAction : "",
      workflow: state.researchWorkflow,
      idea: latestIdea ? {
        problem: latestIdea.problem || latestIdea.title || "",
        expectedOutcome: latestIdea.expectedOutcome || "",
      } : null,
    }) : "";
  }
  $("#deliveryGateHost").innerHTML = ui.renderStageGatePanel({
    loadError: state.deliveryGatesError,
    snapshots: state.deliveryGateSnapshots,
    pending: state.deliveryDecisionPending,
    researchCreatedAt: model.researchItems[0]?.createdAt,
    followupId: model.researchItems.find((item) => item.title?.startsWith("补充调研：") && !["accepted", "completed", "cancelled"].includes(item.state))?.id,
    workflow: state.researchWorkflow,
    projectId: state.deliveryProjectId, actorId: owner.id || "", hasResults: hasDeliveryResults, hasDevelopment,
    developmentId: model.items.find((item) => ["implementation", "fix"].includes(item.type))?.id,
    readyChecks: [
      model.items.some((item) => item.type === "implementation" && item.specVersion != null) ? "scope" : "",
      model.items.some((item) => item.type === "implementation" && item.planVersion != null) ? "technical" : "",
    ],
    gates: ["research", "scope", "technical", "release"].map((kind) => ({ kind, latest: state.deliveryGates[kind] })),
  });
  $("#deliveryReleaseHost").innerHTML = ui.renderReleasePanel({ hasDevelopment });
  restoreDeliveryDrafts();
}

function workOutputsHtml(item) {
  if (!item) return "";
  const outputs = (item.trace?.outputs || []).map((output) => ({ ...output, workItemId: item.id, workTitle: item.title, workState: item.state }));
  return `<div class="card-title"><h3>执行成果</h3><span>${outputs.length} 份</span></div>${deliveryUi().renderOutputList(outputs) || '<p class="muted">尚无产物。执行报告和文件生成后可在这里查看。</p>'}`;
}

function renderSelectedResults(item) {
  const host = $("#workOutputsHost");
  if (host) {
    host.classList.toggle("hidden", !item || !(item.trace?.outputs || []).length && ["draft", "ready"].includes(item.state));
    host.innerHTML = workOutputsHtml(item);
  }
  const html = item ? executionTraceListHtml([item], []) : "";
  const workflow = state.researchWorkflow;
  const sameProject = Boolean(
    workflow?.workflowRunId
      && state.deliveryProjectId
      && (!item?.projectId || item.projectId === state.deliveryProjectId),
  );
  const workflowHint = !html && sameProject
    ? workflow.synthesisRecommendation
      ? `<p class="hint">可行性评估已在交付页完成汇总（${escapeHtml(workflow.synthesisSummary || workflow.synthesisRecommendation)}）。工作中心不会出现旧式「执行记录」——请到<strong>交付</strong>查看调研成果并做下一步决策。</p><button type="button" class="ghost" data-nav="delivery">去交付页</button>`
      : workflow.runState === "running" || workflow.runState === "waiting"
        ? `<p class="hint">该想法正通过「评估想法可行性」并行调研（工作台只读会话）。过程不写入本页执行记录；完成后请到<strong>交付</strong>查看结论。</p><button type="button" class="ghost" data-nav="delivery">去交付页</button>`
        : workflow.runState === "failed"
          ? `<p class="hint">可行性评估未产出执行记录到此页。失败原因见<strong>交付</strong>页，可在那里重试评估。</p><button type="button" class="ghost" data-nav="delivery">去交付页</button>`
          : ""
    : "";
  $("#traceList").classList.toggle("empty", !html && !workflowHint);
  $("#traceList").innerHTML = html || workflowHint || "当前任务还没有执行记录。";
}

let outputReadVersion = 0;
let outputOpener = null;
async function openOutput(workItemId, outputId) {
  const item = state.workItems.find((row) => row.id === workItemId);
  const output = item?.trace?.outputs?.find((row) => row.id === outputId);
  if (!output) return toast("产物已更新，请刷新后重试", true);
  const version = ++outputReadVersion;
  const dialog = $("#outputDialog");
  outputOpener = document.activeElement;
  $("#outputTitle").textContent = item.title || "交付产物";
  $("#outputMeta").textContent = `${workStateLabel(item.state)} · ${output.mediaType || "执行报告"}`;
  $("#outputBody").textContent = "正在读取内容…";
  const run = linkedRuns(item).find((row) => row.runId === output.runId) || { runId: output.runId, sessionId: output.sessionId };
  $("#outputRunLink").innerHTML = workbenchRunButton(run, item.id);
  if (!dialog.open) dialog.showModal();
  try {
    const result = output.content !== undefined ? output : await invoke(METHODS.readOutput, { companyId: state.companyId, workItemId, outputId });
    if (version !== outputReadVersion || !dialog.open) return;
    if (result.content !== undefined) {
      const preview = window.ForgeMarkdownPreview;
      if (preview?.mountMarkdown) {
        preview.mountMarkdown($("#outputBody"), result.content || "报告正文为空。");
      } else {
        $("#outputBody").innerHTML = deliveryUi().renderDocument(result.content || "报告正文为空。");
      }
    } else {
      $("#outputBody").innerHTML = `<p class="muted">${escapeHtml(result.reason || "没有可预览正文，请打开工作台查看。")}</p>`;
    }
  } catch (error) {
    if (version === outputReadVersion && dialog.open) $("#outputBody").textContent = `读取失败：${errorMessage(error)}。可在工作台查看，或关闭后重试。`;
  }
}

function fileBaseName(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || path || "文件";
}

function isMarkdownPath(path) {
  return /\.(md|markdown)$/i.test(path || "");
}

function mountOutputContent(content, path) {
  const preview = window.ForgeMarkdownPreview;
  if (isMarkdownPath(path) && preview?.mountMarkdown) {
    preview.mountMarkdown($("#outputBody"), content || "文件为空。");
    return;
  }
  if (isMarkdownPath(path)) {
    $("#outputBody").innerHTML = deliveryUi().renderDocument(content || "文件为空。");
    return;
  }
  $("#outputBody").innerHTML = `<pre class="file-source">${escapeHtml(content || "文件为空。")}</pre>`;
}

async function openWorkspaceFile(workItemId, path) {
  const item = state.workItems.find((row) => row.id === workItemId);
  const file = item?.trace?.workspaceFiles?.find((row) => row.path === path);
  if (!item || !file) return toast("文件列表已更新，请刷新后重试", true);
  const version = ++outputReadVersion;
  const dialog = $("#outputDialog");
  outputOpener = document.activeElement;
  $("#outputTitle").textContent = fileBaseName(file.path);
  $("#outputMeta").textContent = `${file.path} · 工作区底稿`;
  $("#outputBody").textContent = "正在读取内容…";
  const run = linkedRuns(item).find((row) => row.runId === file.runId) || { runId: file.runId };
  $("#outputRunLink").innerHTML = workbenchRunButton(run, item.id);
  if (!dialog.open) dialog.showModal();
  try {
    const result = await invoke(METHODS.readWorkspaceFile, {
      companyId: state.companyId,
      workItemId,
      path: file.path,
    });
    if (version !== outputReadVersion || !dialog.open) return;
    if (result.previewable && result.content !== undefined) {
      mountOutputContent(result.content, file.path);
    } else {
      $("#outputBody").innerHTML = `<p class="muted">${escapeHtml(result.reason || "没有可预览正文，请打开工作台查看。")}</p>`;
    }
  } catch (error) {
    if (version === outputReadVersion && dialog.open) {
      $("#outputBody").textContent = `读取失败：${errorMessage(error)}。可在工作台查看，或关闭后重试。`;
    }
  }
}

function showPage(name) {
  const titles = {
    overview: "总览",
    organization: "组织",
    work: "工作中心",
    delivery: "交付成果",
    approvals: "审批",
  };
  $$("[data-page]").forEach((page) => page.classList.toggle("hidden", page.dataset.page !== name));
  $$(".rail [data-nav]").forEach((button) => button.classList.toggle("on", button.dataset.nav === name));
  const eyebrow = $("#pageEyebrow");
  if (eyebrow) eyebrow.textContent = titles[name] || "经营台";
}

$("#refreshBtn")?.addEventListener("click", () => void loadData());
$("#ensureCrewBtn")?.addEventListener("click", async () => {
  if (!state.companyId) return toast("还没有公司", true);
  const workspaceId = $("#orgDefaultWorkspace")?.value || undefined;
  try {
    const tree = await action("补齐编制", () => invoke(METHODS.ensureCrew, {
      companyId: state.companyId,
      ...(workspaceId ? { workspaceId } : {}),
    }));
    renderOrganization(tree);
    await loadData();
  } catch {}
});
$("#grantWorkspaceBtn")?.addEventListener("click", async () => {
  if (!state.companyId) return toast("还没有公司", true);
  const workspaceId = $("#orgDefaultWorkspace")?.value;
  if (!workspaceId) return toast("先选一个项目目录", true);
  try {
    const result = await action("授权主区", () => invoke(METHODS.grantDefaultWorkspace, {
      companyId: state.companyId,
      workspaceId,
    }));
    if (result?.tree) renderOrganization(result.tree);
    else await loadData();
    toast(result?.updated ? `已给 ${result.updated} 人授权主区` : "大家都有主区了");
  } catch {}
});
$$(".refresh").forEach((button) => {
  if (button.id === "refreshBtn") return;
  button.addEventListener("click", () => void loadData());
});
document.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.classList.contains("org-department")) {
    return;
  }
  const id = details.dataset.departmentId;
  if (!id) return;
  if (details.open) state.collapsedDepartments.delete(id);
  else state.collapsedDepartments.add(id);
  persistCollapsedDepartments();
}, true);
document.addEventListener("click", (event) => {
  const navBtn = event.target.closest("[data-nav]");
  if (navBtn) {
    showPage(navBtn.dataset.nav);
    return;
  }
  const loopStep = event.target.closest("#deliveryLoopSteps [data-loop]");
  if (loopStep) {
    const target = {
      intake: "#deliveryIntake",
      research: "#deliveryResearch",
      artifacts: "#deliveryArtifacts",
      gates: "#deliveryGates",
      release: "#deliveryRelease",
    }[loopStep.dataset.loop];
    $(target)?.scrollIntoView({ block: "start" });
    return;
  }
  const hireSeat = event.target.closest("[data-hire-position]");
  if (hireSeat) {
    state.selectedPositionId = hireSeat.dataset.hirePosition;
    state.selectedEmployeeId = "";
    showStaffTab("hire");
    renderOnboardFields();
    $("#hireForm [name=displayName]")?.focus();
    return;
  }
  const employeeNode = event.target.closest("[data-employee-id]");
  if (employeeNode) {
    state.selectedEmployeeId = employeeNode.dataset.employeeId;
    state.selectedPositionId = "";
    showStaffTab("bind");
    renderOrganization(state.org);
    return;
  }
  const workRow = event.target.closest("[data-select-work]");
  if (!workRow) return;
  const item = state.workItems.find((entry) => entry.id === workRow.dataset.selectWork);
  if (!item) return;
  showPage("work");
  selectWorkItem(item);
});
document.addEventListener("change", (event) => {
  const modeSelect = event.target.closest("#workspaceModal select.ws-mode");
  if (modeSelect) {
    setWorkspaceGrant(workspaceIdOf(modeSelect), modeSelect.value);
    return;
  }
  const envSelect = event.target.closest("#workspaceModal select.ws-env");
  if (envSelect) {
    setWorkspaceEnv(workspaceIdOf(envSelect), envSelect.value);
    return;
  }
  const radio = event.target.closest("#workspaceModal input[type=radio]");
  if (radio) setWorkspaceDefault(radio.value);
  if (event.target.closest("[name=goalId]")) fillGoalProjectSelects();
  if (event.target.id === "deliveryProjectSelect") {
    state.deliveryProjectId = event.target.value;
    state.deliveryGates = {};
    state.deliveryGatesError = true;
    renderDelivery();
    sessionStorage.setItem("forgeCompany.deliveryProjectId", state.deliveryProjectId);
    void loadData();
  }
});
document.addEventListener("input", (event) => {
  const talentSearch = event.target.closest(".talent-search");
  if (talentSearch) {
    const pickerId = talentPickerState.active;
    const slot = talentPickerState[pickerId];
    if (!slot) return;
    slot.query = talentSearch.value;
    renderTalentPicker(pickerId);
    return;
  }
  const workspaceSearch = event.target.closest(".workspace-search");
  if (!workspaceSearch) return;
  const pickerId = workspacePickerState.active;
  const slot = workspacePickerState[pickerId];
  if (!slot) return;
  slot.query = workspaceSearch.value;
  slot.page = 1;
  renderWorkspaceModal();
});
document.addEventListener("click", (event) => {
  const openTalent = event.target.closest(".talent-open");
  if (openTalent) {
    const picker = openTalent.closest("[data-talent-picker]");
    if (picker?.dataset.talentPicker) openTalentModal(picker.dataset.talentPicker);
    return;
  }
  const openWorkspace = event.target.closest(".workspace-open");
  if (openWorkspace) {
    const picker = openWorkspace.closest("[data-workspace-picker]");
    if (picker?.dataset.workspacePicker) openWorkspaceModal(picker.dataset.workspacePicker);
    return;
  }
  const workspaceScope = event.target.closest("[data-workspace-scope]");
  if (workspaceScope && workspaceModalOpen()) {
    const slot = workspacePickerState[workspacePickerState.active];
    if (!slot) return;
    slot.scope = workspaceScope.getAttribute("data-workspace-scope") || "";
    slot.page = 1;
    renderWorkspaceModal();
    return;
  }
  const pageBtn = event.target.closest("[data-ws-page]");
  if (pageBtn && workspaceModalOpen() && !pageBtn.disabled) {
    const slot = workspacePickerState[workspacePickerState.active];
    if (!slot) return;
    slot.page += Number(pageBtn.getAttribute("data-ws-page") || 0);
    renderWorkspaceModal();
    return;
  }
  const pickerId = talentPickerState.active;
  const slot = talentPickerState[pickerId];
  if (!slot) return;
  const cat = event.target.closest(".talent-cat");
  if (cat) {
    slot.category = cat.dataset.talentCat || "";
    renderTalentPicker(pickerId);
    return;
  }
  const option = event.target.closest(".talent-option");
  if (!option) return;
  slot.selectedId = option.getAttribute("data-talent-id") || option.dataset.talentId || "";
  renderTalentPicker(pickerId);
  closeTalentModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && workspaceModalOpen()) {
    event.preventDefault();
    const slot = workspacePickerState[workspacePickerState.active];
    if (slot?.query && event.target.closest(".workspace-search")) {
      slot.query = "";
      event.target.value = "";
      slot.page = 1;
      renderWorkspaceModal();
      return;
    }
    closeWorkspaceModal();
    return;
  }
  if (event.key === "Escape" && talentModalOpen()) {
    event.preventDefault();
    const slot = talentPickerState[talentPickerState.active];
    if (slot?.query && event.target.closest(".talent-search")) {
      slot.query = "";
      event.target.value = "";
      renderTalentPicker(talentPickerState.active);
      return;
    }
    closeTalentModal();
    return;
  }
  if (event.key !== "Enter") return;
  if (event.target.closest(".talent-search") || event.target.closest(".workspace-search")) {
    event.preventDefault();
  }
});

$("#createCompanyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
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
  const form = event.currentTarget;
  const values = formValues(form);
  const talentTemplateId = talentPickerState.hire.selectedId || values.talentTemplateId;
  if (!talentTemplateId) return toast("先选择人才包", true);
  try {
    const hired = await action("入职", () => invoke(METHODS.onboard, {
      companyId: state.companyId,
      displayName: values.displayName,
      positionId: values.positionId,
      talentTemplateId,
      modelProfileId: values.modelProfileId || undefined,
      workspaces: workspaceGrantsFrom("hireWorkspaces"),
    }));
    state.selectedEmployeeId = hired?.id || "";
    state.selectedPositionId = "";
    form.reset();
    setTalentPicker("hire", "", "", { resetFilter: true });
    resetWorkspacePicker("hire");
    await loadData();
    if (state.selectedEmployeeId) showStaffTab("bind");
  } catch {}
});

$("#bindForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  const talentTemplateId = talentPickerState.bind.selectedId || values.talentTemplateId;
  const employeeId = values.employeeId || state.selectedEmployeeId;
  showBindError("");
  if (!employeeId || !talentTemplateId) {
    const message = "先选择员工和人才包";
    showBindError(message);
    return toast(message, true);
  }
  try {
    await action("保存权限", () => invoke(METHODS.bindEmployee, {
      companyId: state.companyId,
      employeeId,
      talentTemplateId,
      modelProfileId: values.modelProfileId || undefined,
      workspaces: workspaceGrantsFrom("bindWorkspaces"),
    }));
    state.selectedEmployeeId = employeeId;
    await loadData();
    showStaffTab("bind");
  } catch (error) {
    showBindError(errorMessage(error));
  }
});

async function createDemand(values, source) {
  if (!state.companyId) {
    toast("还没有公司，请先创建公司", true);
    throw new Error("no company");
  }
  const result = await action(source, () => invoke(METHODS.createWorkItem, {
    companyId: state.companyId,
    type: "intent",
    title: values.title,
    problem: values.problem,
    expectedOutcome: values.expectedOutcome,
    ownerId: values.ownerId,
    goalId: values.goalId || undefined,
    projectId: values.projectId || undefined,
  }));
  addTrace(source, result);
  await loadData();
  return result;
}

$("#demandForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await createDemand(formValues(event.currentTarget), "登记需求");
    if (result?.id) {
      selectWorkItem(state.workItems.find((item) => item.id === result.id) || result);
      await draftArtifacts();
    }
  } catch {}
});

$("#gateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  const submittedDraftKey = workDraftKey(values.workItemId);
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
    clearSubmittedDraft(workDrafts, submittedDraftKey, { spec: values.spec, plan: values.plan });
    addTrace("规格门通过", acceptedSpec);
    addTrace("计划门通过", acceptedPlan);
    $("#dispatchForm [name=workItemId]").value = values.workItemId;
    $("#dispatchForm [name=actorId]").value = values.actorId;
    await loadData();
  } catch {}
});

$("#dispatchForm [name=assigneeId]")?.addEventListener("change", updateDispatchWorkspaceHint);
$("#dispatchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  const assignee = state.employees.find((employee) => employee.id === values.assigneeId);
  if (!hasDefaultWriteWorkspace(assignee)) {
    return toast(
      `${assignee?.displayName || "执行人"}没有主写目录。请到组织页给这位员工授权一个可写主区。`,
      true,
    );
  }
  try {
    const dispatched = await action("派活", () => invoke(METHODS.dispatch, values));
    const run = await action("请求执行", () => invoke(METHODS.requestRun, { workItemId: values.workItemId }));
    addTrace("已派活", dispatched);
    addTrace("执行请求", run);
    $("#fixForm [name=workItemId]").value = values.workItemId;
    toast(
      run?.runId
        ? "已派活并开始执行，可到工作台看过程。"
        : "已派活，但还没有真正开跑。当前不会自动执行，所以看不到过程和交付物。",
      !run?.runId,
    );
    await loadData();
  } catch {}
});

$("#fixForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await action("暂停并派修复", () => invoke(METHODS.pauseForFix, formValues(event.currentTarget)));
    addTrace("红灯修复", result);
    await loadData();
    const fix = state.workItems.find((item) => item.id === result?.id) || result;
    if (fix?.id) {
      showPage("work");
      selectWorkItem(fix);
      toast(`已打开修复单「${fix.title || "Fix"}」。过规格/计划后再派活。`);
    }
  } catch {}
});

$("#approvalActorId").addEventListener("change", renderApprovals);
$("#approvalList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-decision]");
  if (!button) return;
  const row = button.closest("[data-work-item]");
  const actorId = $("#approvalActorId").value.trim();
  const reason = row.querySelector("[data-reason]").value.trim();
  if (button.dataset.decision === "approved" && !canApprove(actorId, row.dataset.assignee)) {
    return toast(actorId ? "不能批准自己的提交" : "请选择审批人", true);
  }
  if (button.dataset.decision === "rejected" && !reason) return toast("驳回必须填写理由", true);
  try {
    const result = await action(button.dataset.decision === "approved" ? "审批通过" : "审批驳回", () =>
      invoke(METHODS.decideApproval, {
        workItemId: row.dataset.workItem,
        actorId,
        decision: button.dataset.decision,
        reason,
      }));
    await loadData();
    if (result?.fixWorkItem?.id) {
      const fix = state.workItems.find((item) => item.id === result.fixWorkItem.id) || result.fixWorkItem;
      showPage("work");
      selectWorkItem(fix);
      toast(`已驳回。已开修复单「${result.fixWorkItem.title}」，下一步：过规格/计划再派活。`);
    } else if (button.dataset.decision === "approved") {
      const closed = state.workItems.find((item) => item.id === row.dataset.workItem);
      showPage("work");
      if (closed) selectWorkItem(closed);
      toast("已通过，工作项已验收关闭。");
    }
  } catch {}
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-takeover-run]");
  if (!button || !button.dataset.takeoverRun) return;
  const ui = deliveryUi();
  if (!ui) return;
  ui.openWorkbenchTakeover(window.forgeCompany.openWorkbench.bind(window.forgeCompany), {
    runId: button.dataset.takeoverRun,
    stepId: button.dataset.takeoverStep,
    workItemId: button.dataset.workItem,
    sessionId: button.dataset.session || undefined,
    cwd: button.dataset.cwd || undefined,
  });
});

document.addEventListener("submit", async (event) => {
  if (event.target?.id !== "deliveryIntakeForm") return;
  event.preventDefault();
  const values = formValues(event.target);
  const submittedDraftKey = deliveryDraftKey("deliveryIntakeForm");
  const ownerId = deliveryOwner().id;
  if (!ownerId) return toast("先入职一位员工再登记调研", true);
  if (!state.deliveryProjectId) return toast("先选一个交付项目", true);
  const constraints = String(values.constraints || "")
    .split(/[,，;；\n]/).map((entry) => entry.trim()).filter(Boolean);
  try {
    const result = await action("登记调研需求", () => invoke(METHODS.createWorkItem, {
      companyId: state.companyId,
      type: "research",
      title: values.problem.slice(0, 40) || "调研需求",
      problem: values.problem,
      targetUser: values.targetUser,
      constraints,
      expectedOutcome: values.expectedOutcome,
      ownerId,
      projectId: state.deliveryProjectId || undefined,
    }));
    clearSubmittedDraft(deliveryDrafts, submittedDraftKey, values);
    addTrace("调研 Intake", result);
    state.deliveryIntakeKeepOpen = true;
    await loadData();
    showPage("delivery");
    toast("已登记想法。上方「评估想法」会显示原文，可直接评估可行性。");
  } catch {}
});

const decisionRequestIds = new Map();
const feasibilityRequestKeys = new Map();

$("#deliveryFeasibilityHost")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-start-feasibility]");
  if (!button || button.disabled || state.feasibilityPending) return;
  const projectId = button.dataset.projectId || state.deliveryProjectId;
  const briefId = button.dataset.briefId;
  if (!projectId || !briefId) return toast("先登记调研需求并确认调研简报", true);
  const companyId = state.companyId;
  // One stable key per company/project/brief so a retry attaches to the same run.
  const requestKey = JSON.stringify([companyId, projectId, briefId]);
  if (!feasibilityRequestKeys.has(requestKey)) feasibilityRequestKeys.set(requestKey, `idea_${crypto.randomUUID()}`);
  state.feasibilityPending = true;
  renderDelivery();
  try {
    await action("评估想法可行性", () => invoke(METHODS.startWorkflow, {
      companyId, projectId, briefId,
      workflowId: RESEARCH_WORKFLOW_ID,
      idempotencyKey: feasibilityRequestKeys.get(requestKey),
    }));
    feasibilityRequestKeys.delete(requestKey);
    await loadData();
    const status = state.researchWorkflow;
    if (status?.runState === "failed") {
      toast(`评估已启动但失败：${status.failureReason || "未知错误"}。可重试。`, true);
    } else if (status?.workflowRunId) {
      toast("已开始评估。工作台会出现只读调研会话；完成后在「下一步」决定是否进入需求设计。");
    } else {
      toast("已开始评估。若工作台暂无会话，稍后刷新交付页查看进度。");
    }
  } catch {}
  finally {
    state.feasibilityPending = false;
    renderDelivery();
  }
});

$("#deliveryGateHost")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-gate-outcome]");
  const card = event.target.closest("[data-gate]");
  if (!button || !card) return;
  const form = $("#deliveryGateForm");
  const values = form ? formValues(form) : {};
  const actorId = values.actorId || deliveryOwner().id;
  if (!state.deliveryProjectId || !actorId) return toast("先有项目和决策人", true);
  if (!values.rationale?.trim()) return toast("请填写决策说明", true);
  if (button.disabled || state.deliveryDecisionPending) return;
  const snapshot = state.deliveryGateSnapshots[card.dataset.gate];
  if (!snapshot?.ready || state.deliveryGatesError) return toast("当前状态尚不能提交，请刷新后核对。", true);
  const projectId = state.deliveryProjectId;
  const companyId = state.companyId;
  const gate = card.dataset.gate;
  const outcome = button.dataset.gateOutcome;
  const requestKey = JSON.stringify([companyId, projectId, gate, outcome, actorId, snapshot.inputVersionRefs, values.rationale, values.impact || ""]);
  if (!decisionRequestIds.has(requestKey)) decisionRequestIds.set(requestKey, `gate_${crypto.randomUUID()}`);
  state.deliveryDecisionPending = true;
  $$("#deliveryGateHost [data-gate-outcome]").forEach((control) => { control.disabled = true; });
  try {
    const decisionDraftKey = deliveryDraftKey("deliveryGateForm");
    await action("保存下一步决定", () => invoke(METHODS.deliveryGateDecide, {
      id: decisionRequestIds.get(requestKey),
      companyId, projectId, gate, outcome,
      inputVersionRefs: snapshot.inputVersionRefs,
      decidedBy: { kind: "employee", id: actorId },
      rationale: values.rationale,
      impact: values.impact || "",
    }));
    decisionRequestIds.delete(requestKey);
    clearSubmittedDraft(deliveryDrafts, decisionDraftKey, values);
    await loadData();
    showPage("delivery");
    if (outcome === "stopped") {
      const archived = state.projects.find((project) => project.id === projectId)?.state === "completed";
      toast(archived ? "调研已归档，报告与产物已保留。" : "决定已保存，请刷新核对项目状态。", !archived);
    } else if (outcome === "changes_requested") {
      toast("已记录补充要求。点击「创建补充调研任务」继续。");
    } else if (outcome === "approved" && gate === "research") {
      toast("已决定继续开发。点击「创建开发任务」安排下一步。");
    }
  } catch (error) {
    if (errorMessage(error).includes("gate inputs changed")) toast("报告或任务版本已变化，请刷新并重新核对后决定。", true);
  } finally {
    state.deliveryDecisionPending = false;
    renderDelivery();
  }
});

document.addEventListener("click", (event) => {
  const runButton = event.target.closest("[data-open-run]");
  if (runButton) {
    const sessionId = runButton.dataset.openSession || "";
    const runId = runButton.dataset.openRun || "";
    const cwd = runButton.dataset.sessionCwd || "";
    void window.forgeCompany.openWorkbench(
      sessionId
        ? `forge://workbench/session/${sessionId}`
        : `forge://workbench/run/${runId}`,
      {
        workItemId: runButton.dataset.workItem || state.selectedWorkItemId,
        ...(sessionId ? { sessionId } : {}),
        ...(cwd ? { cwd } : {}),
      },
    );
    return;
  }
  if (event.target.closest("[data-open-workbench]")) {
    void window.forgeCompany.openWorkbench();
  }
});
$("#showAllWorkItems")?.addEventListener("change", () => {
  renderWorkInbox();
});

$("#draftArtifactsBtn").addEventListener("click", () => void draftArtifacts().catch(() => {}));
$("#openWorkbenchBtn").addEventListener("click", () => void window.forgeCompany?.openWorkbench());
$("#ceoDrawerBtn").addEventListener("click", () => {
  $("#ceoDrawer").classList.remove("hidden");
  void loadCeoBrief();
});
$("#goalForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  const ownerId = state.employees[0]?.id;
  if (!ownerId) {
    toast("先雇一个数字员工再立目标", true);
    return;
  }
  try {
    await action("立目标", () => invoke(METHODS.createGoal, {
      companyId: state.companyId,
      title: values.title,
      ownerId,
    }));
    form.reset();
    await loadData();
  } catch {}
});
$("#projectForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  if (!values.goalId) {
    toast("先立并选择一个目标", true);
    return;
  }
  try {
    await action("建项目", () => invoke(METHODS.createProject, {
      companyId: state.companyId,
      goalId: values.goalId,
      title: values.title,
    }));
    form.reset();
    await loadData();
  } catch {}
});
$("#projectWorkspaceForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const projectId = form.querySelector("[name=projectId]")?.value;
  const workspaceIds = [...form.querySelectorAll("[name=workspaceIds] option:checked")]
    .map((option) => option.value);
  if (!projectId) {
    toast("先建并选择一个项目", true);
    return;
  }
  if (!workspaceIds.length) {
    toast("至少勾选一个项目目录", true);
    return;
  }
  try {
    await action("绑定项目目录组", () => invoke(METHODS.bindProjectWorkspaces, {
      companyId: state.companyId,
      projectId,
      workspaceIds,
    }));
    await loadData();
  } catch {}
});
$("#closeTalentModalBtn")?.addEventListener("click", () => closeTalentModal());
$("#talentModal")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeTalentModal();
});
$("#closeWorkspaceModalBtn")?.addEventListener("click", () => closeWorkspaceModal());
$("#workspaceModal")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeWorkspaceModal();
});
$("#closeDrawerBtn").addEventListener("click", () => $("#ceoDrawer").classList.add("hidden"));
$("#ceoDrawer").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) event.currentTarget.classList.add("hidden");
});
$("#ceoForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  try {
    const result = await createDemand(values, "登记草稿");
    $("#ceoDrawer").classList.add("hidden");
    form.reset();
    showPage("work");
    selectWorkItem(state.workItems.find((item) => item.id === result?.id) || result);
    await draftArtifacts();
    toast(`已登记草稿「${values.title}」。已按人才包出稿，改完后保存并接受。`);
  } catch {}
});

async function loadCeoBrief() {
  const box = $("#ceoBrief");
  if (!box || !state.companyId) return;
  try {
    const brief = await invoke(METHODS.ceoBrief, { companyId: state.companyId });
    state.ceoBrief = brief;
    box.innerHTML = `<p>${escapeHtml(brief.summary || "")}</p><ol>${
      (brief.priorities || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    }</ol>`;
  } catch {
    box.innerHTML = "<p class=\"hint\">暂时读不到经营摘要，仍可登记需求。</p>";
  }
}

async function applyDemoSeed() {
  try {
    const seed = window.forgeCompanyDemoSeed;
    if (!seed) return;
    if (seed.companyId) {
      state.companyId = seed.companyId;
      state.companyName = seed.companyName || state.companyName;
      localStorage.setItem("forgeCompany.companyId", seed.companyId);
      if (seed.companyName) localStorage.setItem("forgeCompany.companyName", seed.companyName);
    }
    if (seed.approvalActorId) $("#approvalActorId").value = seed.approvalActorId;
    if (seed.page) showPage(seed.page);
  } catch {}
}

function applyDemoSeedForms() {
  try {
    const seed = window.forgeCompanyDemoSeed;
    if (!seed?.forms) return;
    const occupiedPositions = new Set(
      (state.org.employees || state.employees).map((employee) => employee.positionId),
    );
    const hiredNames = new Set(
      (state.org.employees || state.employees).map((employee) => employee.displayName),
    );
    const applyFields = () => {
      for (const [formId, values] of Object.entries(seed.forms)) {
        if (formId === "hireForm" && (occupiedPositions.has(values.positionId) || hiredNames.has(values.displayName))) {
          continue;
        }
        const form = document.getElementById(formId);
        if (!form) continue;
        for (const [name, value] of Object.entries(values)) {
          if (value == null || value === "") continue;
          const field = form.querySelector(`[name="${name}"]`);
          if (field) field.value = value;
        }
      }
      if (seed.approvalActorId) $("#approvalActorId").value = seed.approvalActorId;
    };
    applyFields();
    renderPersonSelects(state.workItems.find((item) => item.id === state.selectedWorkItemId));
    applyFields();
    updateDispatchWorkspaceHint();
    renderApprovals();
  } catch {}
}

showPage("overview");
function openLinkedWorkItem(workItemId) {
  if (!workItemId) return;
  const item = state.workItems.find((entry) => entry.id === workItemId);
  showPage("work");
  if (item) selectWorkItem(item);
  else {
    state.selectedWorkItemId = workItemId;
    sessionStorage.setItem("forgeCompany.selectedWorkItemId", workItemId);
  }
}
function pendingWorkIdFromLocation() {
  try {
    return new URLSearchParams(window.location.search).get("work") || "";
  } catch {
    return "";
  }
}
window.forgeCompany?.onOpenWork?.((payload) => {
  const workItemId = payload?.workItemId || payload?.id;
  void loadData().then(() => openLinkedWorkItem(workItemId));
});
const pendingWorkId = pendingWorkIdFromLocation();
if (pendingWorkId) state.selectedWorkItemId = pendingWorkId;
void applyDemoSeed()
  .then(() => loadData())
  .then(() => {
    applyDemoSeedForms();
    if (pendingWorkId) openLinkedWorkItem(pendingWorkId);
  })
  .catch((error) => {
    $("#globalStatus").textContent = "连接失败";
    toast(errorMessage(error), true);
  });


document.addEventListener("click", (event) => {
  const workspaceFile = event.target.closest("[data-open-workspace-file]");
  if (workspaceFile) {
    void openWorkspaceFile(workspaceFile.dataset.fileWork, workspaceFile.dataset.openWorkspaceFile);
    return;
  }
  const output = event.target.closest("[data-open-output]");
  if (output) void openOutput(output.dataset.outputWork, output.dataset.openOutput);
});
$("#closeOutputBtn")?.addEventListener("click", () => $("#outputDialog").close());
$("#outputDialog")?.addEventListener("close", () => { ++outputReadVersion; outputOpener?.focus?.(); });


$("#deliveryGateHost")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-followup]");
  if (!button || button.disabled) return;
  const model = deliveryModel();
  const source = model.researchItems[0];
  const ownerId = source?.ownerId || deliveryOwner().id;
  if (!source || !ownerId) return toast("请先选择已有调研的项目", true);
  button.disabled = true;
  const type = button.dataset.followup;
  const existing = model.items.find((item) => item.type === type &&
    (type !== "research" || item.title?.startsWith("补充调研：")) &&
    !["completed", "accepted", "cancelled"].includes(item.state));
  try {
    const item = existing || await action("创建后续任务", () => invoke(METHODS.createWorkItem, {
      companyId: state.companyId, projectId: state.deliveryProjectId, type, ownerId,
      title: `${type === "research" ? "补充调研" : "开发"}：${source.title}`,
      problem: `${source.problem}\n\n调研决策：${state.deliveryGates.research?.rationale || ""}\n\n参考报告：\n${model.reports.map((report) => report.content).join("\n\n")}`,
      expectedOutcome: type === "research" ? "补齐决策中提出的问题，更新调研报告。" : "根据调研结论确认开发范围，完成实现与验收。",
    }));
    await loadData();
    showPage("work");
    selectWorkItem(state.workItems.find((row) => row.id === item.id) || item);
  } catch {} finally { button.disabled = false; }
});

document.addEventListener("input", rememberFormDraft);
document.addEventListener("change", rememberFormDraft);

// Discard only the selected local draft; server versions remain authoritative.
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-discard-draft]");
  if (!button) return;
  const form = button.closest("form");
  if (form?.id === "gateForm") {
    const item = selectedWorkItem();
    if (!item) return;
    if (!workDrafts.delete(workDraftKey(item.id))) return draftNotice(form, "本机草稿清除失败，请重试。");
    selectWorkItem(item);
  } else if (["deliveryIntakeForm", "deliveryGateForm"].includes(form?.id)) {
    if (!deliveryDrafts.delete(deliveryDraftKey(form.id))) return draftNotice(form, "本机草稿清除失败，请重试。");
    renderDelivery();
  }
});
