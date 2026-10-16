import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { applyRequestedModel, loadConfig } from "@forge/config";
import { handleGetTalentTemplate, handleListTalentTemplates } from "../services/talent-service.js";
import {
  acceptBrief,
  bindProjectWorkspaceGroup,
  buildCeoBrief,
  buildCompanyDashboard,
  buildCompanyRunMessage,
  buildDeliveryTrace,
  capabilityNeedsTemplateFill,
  companyBudgetAllowsRun,
  companyRunAutoApply,
  composeArtifactDrafts,
  composeReviewPreview,
  decodeReviewPreviewReason,
  encodeReviewPreviewReason,
  ensureCompanyBudgetAccount,
  getCompanyBudgetAccountId,
  getProjectWorkspaceGroupId,
  newCompanyId,
  persistWorkArtifactFile,
  pickDefaultReviewerId,
  pickProjectWriteGrant,
  previewWorkspaceFile,
  REVIEW_PREVIEW_SCHEMA,
  type EmployeeWorkspaceGrant,
  recallEmployeeMemories,
  rememberEmployeeMemory,
  resolveEmployeeCapability,
  StageGateService,
  StageGateCoordinator,
  talentTemplateIdForSeatTitle,
  toDraftTalentPack,
  type DecideStageGateInput,
  type StageGateKind,
} from "@forge/company-domain";
import { isTerminalRunState, runRequestToRunSpec } from "@forge/execution";
import { LlmClient } from "@forge/llm";
import {
  DAEMON_COMPANY_METHODS,
  rpcFault,
  type CompanyWorkflowStartRequest,
} from "@forge/protocol";
import { RpcFaultError } from "../host/router.js";
import type { DaemonModule } from "../host/types.js";
import type { ForgeDaemonContext } from "./context.js";
import { getCompanyWorkflowCapabilities } from "../services/company-workflow-capabilities.js";
import {
  CompanyWorkflowStartError,
  startCompanyResearchWorkflow,
} from "../services/company-workflow-dispatch.js";
import { getCompanyResearchWorkflowStatus } from "../services/company-workflow-status.js";
import { researchGateWaitRef, resumeWaitsByRef } from "../services/company-workflow-executors.js";
import { createLinkedCompanyRun } from "./execution-module.js";

type Params = Record<string, unknown>;
type SharedProject = { id: string; name: string; cwd: string };
type ModelProfileOption = { id: string; name: string; provider?: string };

let listSharedProjects: () => SharedProject[] = defaultSharedProjects;
let listModelProfiles: () => ModelProfileOption[] = defaultModelProfiles;

function defaultSharedProjects(): SharedProject[] {
  try {
    const projects = loadConfig().ui?.projects;
    if (!Array.isArray(projects)) return [];
    return projects.filter((project): project is SharedProject =>
      Boolean(project) &&
      typeof project.id === "string" &&
      Boolean(project.id) &&
      typeof project.name === "string" &&
      Boolean(project.name) &&
      typeof project.cwd === "string" &&
      Boolean(project.cwd),
    );
  } catch {
    return [];
  }
}

function defaultModelProfiles(): ModelProfileOption[] {
  try {
    const profiles = loadConfig().profiles;
    if (!profiles) return [];
    return Object.entries(profiles).map(([id, profile]) => ({
      id,
      name: profile.name,
      provider: profile.provider,
    }));
  } catch {
    return [];
  }
}

export function createCompanyModule(options: {
  generateDraft?: (prompt: string, model?: string) => Promise<string>;
  listSharedProjects?: () => SharedProject[];
  listModelProfiles?: () => ModelProfileOption[];
} = {}): DaemonModule<ForgeDaemonContext> {
  listSharedProjects = options.listSharedProjects ?? defaultSharedProjects;
  listModelProfiles = options.listModelProfiles ?? defaultModelProfiles;
  return {
    id: "company",
    feature: { version: 1, enabled: true },
    register(router, context) {
      const register = (
        method: string,
        handler: (params: Params) => unknown,
      ) => {
        router.registerProduct(method, async (params) => {
          try {
            return await handler(recordParams(params));
          } catch (error) {
            throw companyRpcError(error);
          }
        });
      };

      register(DAEMON_COMPANY_METHODS.WORKFLOW_CAPABILITIES, () =>
        context.companyWorkflowCapabilities?.() ?? getCompanyWorkflowCapabilities());
      register(DAEMON_COMPANY_METHODS.WORKFLOWS_RESEARCH_STATUS, (params) =>
        getCompanyResearchWorkflowStatus(
          { db: context.store.db, executionStore: context.executionStore },
          {
            companyId: companyIdParam(params),
            projectId: stringParam(params, "projectId"),
            briefId: optionalStringParam(params, "briefId"),
          },
        ));
      register(DAEMON_COMPANY_METHODS.WORKFLOWS_START, (params) => {
        const companyId = companyIdParam(params);
        const company = context.company.companies.get(companyId);
        ensureCompanyGrantedWorkspaces(context, companyId);
        return startCompanyResearchWorkflow(
          {
            db: context.store.db,
            executionStore: context.executionStore,
            validations: context.validations,
            clock: context.executionClock,
            wakeExecutor: context.wakeExecutor,
            budgetLedger: context.budgetLedger,
            companyName: company?.name,
          },
          {
            companyId,
            projectId: stringParam(params, "projectId"),
            workflowId: stringParam(params, "workflowId") as CompanyWorkflowStartRequest["workflowId"],
            briefId: stringParam(params, "briefId"),
            idempotencyKey: stringParam(params, "idempotencyKey"),
            assignments: assignmentsParam(params),
          },
        );
      });
      register(DAEMON_COMPANY_METHODS.CREATE, (params) =>
        createCompany(context, stringParam(params, "name")));
      register(DAEMON_COMPANY_METHODS.GET, (params) =>
        context.company.companies.get(companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.ORGANIZATION_TREE, (params) =>
        organizationTree(context, companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.ORGANIZATION_ENSURE_CREW, (params) =>
        ensureOperatingCrew(context, params));
      register(DAEMON_COMPANY_METHODS.EMPLOYEES_HIRE, (params) =>
        context.company.org.hire({
          companyId: companyIdParam(params),
          displayName: stringParam(params, "displayName"),
          positionId: stringParam(params, "positionId"),
          managerEmployeeId: optionalStringParam(params, "managerEmployeeId"),
          autonomyLevel: autonomyParam(params),
        }));
      register(DAEMON_COMPANY_METHODS.EMPLOYEES_ONBOARD_OPTIONS, (params) =>
        onboardOptions(context, companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.EMPLOYEES_ONBOARD, (params) =>
        onboardEmployee(context, params));
      register(DAEMON_COMPANY_METHODS.EMPLOYEES_BIND, (params) =>
        bindEmployee(context, params));
      register(DAEMON_COMPANY_METHODS.EMPLOYEES_GRANT_DEFAULT_WORKSPACE, (params) =>
        grantDefaultWorkspace(context, params));
      register(DAEMON_COMPANY_METHODS.GOALS_CREATE, (params) =>
        context.company.work.createGoal({
          companyId: companyIdParam(params),
          title: stringParam(params, "title"),
          ownerId: stringParam(params, "ownerId"),
        }));
      register(DAEMON_COMPANY_METHODS.PROJECTS_CREATE, (params) =>
        context.company.work.createProject({
          companyId: companyIdParam(params),
          goalId: stringParam(params, "goalId"),
          title: stringParam(params, "title"),
        }));
      register(DAEMON_COMPANY_METHODS.PROJECTS_BIND_WORKSPACES, (params) =>
        bindProjectWorkspaces(context, params));
      register(DAEMON_COMPANY_METHODS.CEO_BRIEF, (params) =>
        ceoBrief(context, companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.WORK_ITEMS_CREATE, (params) =>
        createWorkItemWithBrief(context, params));
      register(DAEMON_COMPANY_METHODS.WORK_ARTIFACTS_UPSERT, (params) =>
        context.company.gates.upsertDraft({
          workItemId: stringParam(params, "workItemId"),
          kind: artifactKindParam(params),
          content: stringParam(params, "content"),
          actorId: stringParam(params, "actorId"),
        }));
      register(DAEMON_COMPANY_METHODS.WORK_ARTIFACTS_ACCEPT, (params) =>
        context.company.gates.acceptArtifact({
          artifactId: stringParam(params, "artifactId"),
          actorId: stringParam(params, "actorId"),
        }));
      register(DAEMON_COMPANY_METHODS.WORK_ARTIFACTS_DRAFT, (params) =>
        draftWorkArtifacts(context, params, options.generateDraft));
      register(DAEMON_COMPANY_METHODS.WORK_ITEMS_DISPATCH, (params) =>
        context.company.work.dispatch({
          workItemId: stringParam(params, "workItemId"),
          assigneeId: stringParam(params, "assigneeId"),
          actorId: stringParam(params, "actorId"),
        }));
      register(DAEMON_COMPANY_METHODS.WORK_ITEMS_PAUSE_FOR_FIX, (params) =>
        pauseWorkItemForFix(context, params));
      register(DAEMON_COMPANY_METHODS.WORK_ITEMS_PREVIEW_APPROVAL, (params) =>
        previewApproval(context, stringParam(params, "workItemId"), options.generateDraft));

      register(DAEMON_COMPANY_METHODS.EMPLOYEES_LIST, (params) =>
        listEmployees(context, companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.GOALS_LIST, (params) =>
        listGoals(context, companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.PROJECTS_LIST, (params) =>
        listProjects(context, companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.WORK_ITEMS_LIST, (params) =>
        listWorkItems(context, companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.WORK_ITEMS_GET, (params) =>
        getWorkItem(context, stringParam(params, "workItemId")));
      register(DAEMON_COMPANY_METHODS.WORK_OUTPUTS_READ, async (params) => {
        const companyId = companyIdParam(params);
        const item = getWorkItem(context, stringParam(params, "workItemId"));
        if (item.companyId !== companyId) throw new Error("work item not found");
        const output = item.trace.outputs.find((row) => row.id === stringParam(params, "outputId"));
        if (!output) throw new Error("artifact not found");
        if (output.content !== undefined) return { ...output, previewable: true };
        if (output.kind === "report") return { ...output, previewable: false, reason: "执行正文未保存，请在工作台查看会话。" };
        const artifact = context.artifacts.get(output.id);
        if (!/^(text\/|application\/(json|xml))/.test(artifact.mediaType)) {
          return { ...output, previewable: false, reason: "此文件不支持文本预览，请在工作台查看。" };
        }
        if (artifact.sizeBytes > 2 * 1024 * 1024) {
          return { ...output, previewable: false, reason: "文件超过 2 MB，请在工作台查看。" };
        }
        const content = await context.artifacts.readContent(output.id, { companyId });
        return { ...output, content: content.toString("utf8"), previewable: true };
      });
      register(DAEMON_COMPANY_METHODS.WORK_FILES_READ, (params) => {
        const companyId = companyIdParam(params);
        const item = getWorkItem(context, stringParam(params, "workItemId"));
        if (item.companyId !== companyId) throw new Error("work item not found");
        return previewWorkspaceFile(
          context.store.db,
          item.id,
          stringParam(params, "path"),
          { readFile: readCompanyWorkspaceText },
        );
      });
      register(DAEMON_COMPANY_METHODS.DASHBOARD_GET, (params) =>
        dashboard(context, companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN, (params) =>
        requestRun(context, stringParam(params, "workItemId")));
      register(DAEMON_COMPANY_METHODS.APPROVALS_LIST, (params) =>
        listApprovals(context, companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.APPROVALS_DECIDE, (params) =>
        decideApproval(context, params));
      register(DAEMON_COMPANY_METHODS.DELIVERY_GATES_SNAPSHOT, (params) =>
        new StageGateCoordinator(context.store.db).snapshot(companyIdParam(params), stringParam(params, "projectId"), stageGateKindParam(params)));
      register(DAEMON_COMPANY_METHODS.DELIVERY_GATES_DECIDE, (params) => {
        const request = { ...stageGateDecisionParam(params), projectId: stringParam(params, "projectId") };
        const decision = new StageGateCoordinator(context.store.db).decide(request);
        // Idempotent re-decides re-run this: a prior crash between commit and resume self-heals.
        if (request.gate === "research" && context.executor) {
          const resumed = resumeWaitsByRef(
            { db: context.store.db, executor: context.executor },
            researchGateWaitRef(request.projectId),
            { decisionId: decision.id, outcome: decision.outcome },
          );
          if (resumed > 0) context.wakeExecutor?.();
        }
        return decision;
      });
      register(DAEMON_COMPANY_METHODS.DELIVERY_GATES_LATEST, (params) =>
        new StageGateService(context.store.db).getLatest(
          stringParam(params, "projectId"),
          stageGateKindParam(params),
        ));
    },
  };
}

async function draftWorkArtifacts(
  context: ForgeDaemonContext,
  params: Params,
  generateDraft?: (prompt: string, model?: string) => Promise<string>,
) {
  const workItemId = stringParam(params, "workItemId");
  const item = getWorkItem(context, workItemId);
  const tree = context.company.org.tree(String(item.companyId));
  const drafterId = optionalDrafterId(params);
  const employee = drafterId
    ? tree.employees.find((entry) => entry.id === drafterId)
    : undefined;
  if (drafterId && !employee) invalidRequest("drafter not found");
  const position = employee
    ? tree.positions.find((entry) => entry.id === employee.positionId)
    : undefined;
  const drafter = employee
    ? {
        id: employee.id,
        displayName: employee.displayName,
        title: position?.title,
      }
    : null;
  const actorId =
    optionalStringParam(params, "actorId") ?? drafterId ?? item.ownerId;
  if (!actorId) invalidRequest("actorId must be a non-empty string");

  const composed = await composeArtifactDrafts({
    type: item.type,
    title: item.title,
    problem: item.problem,
    expectedOutcome: item.expectedOutcome,
    drafter,
    talent: employee ? await employeeTalentPack(context, employee) : undefined,
    memories: employee
      ? recallEmployeeMemories(context.store.db, item.companyId, employee.id).map((row) => row.content)
      : [],
    generate: async (prompt) => {
      const model = employee?.profile?.modelProfileId;
      return generateDraft
        ? generateDraft(prompt, model)
        : generateCompanyDraft(prompt, model);
    },
  });

  if (item.specVersion == null) {
    context.company.gates.upsertDraft({
      workItemId,
      kind: "spec",
      content: composed.spec,
      actorId,
    });
  }
  if (item.planVersion == null) {
    context.company.gates.upsertDraft({
      workItemId,
      kind: "plan",
      content: composed.plan,
      actorId,
    });
  }

  const latest = getWorkItem(context, workItemId);
  return {
    spec: latest.specDraft ?? composed.spec,
    plan: latest.planDraft ?? composed.plan,
    source: composed.source,
    drafterId: composed.drafterId,
    talentRole: composed.talentRole,
    ...(composed.error ? { error: composed.error } : {}),
  };
}

async function generateCompanyDraft(prompt: string, model?: string): Promise<string> {
  const config = applyRequestedModel(loadConfig(), model);
  if (!config.model?.apiKey) {
    throw new Error("Model API key not set");
  }
  const result = await new LlmClient(config.model).chat({
    messages: [{ role: "user", content: prompt }],
    tools: [],
    signal: AbortSignal.timeout(120_000),
  });
  return result.text ?? "";
}

function optionalDrafterId(params: Params): string | undefined {
  const value = params.drafterId;
  if (value === undefined || value === null || value === "" || value === "model") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    invalidRequest("drafterId must be a string");
  }
  return value.trim();
}

/** Display names + models for seeded crew; talent packs come from OPERATING_SEATS by title. */
const OPERATING_CREW = [
  { title: "研发负责人", displayName: "林川", modelProfileId: "deepseek" },
  { title: "执行工程师", displayName: "苏衡", modelProfileId: "deepseek-pro" },
  { title: "质量负责人", displayName: "沈清", modelProfileId: "deepseek-pro" },
  { title: "产品助理", displayName: "乔麦", modelProfileId: "deepseek" },
  { title: "市场调查员", displayName: "闻启", modelProfileId: "deepseek" },
  { title: "设计师", displayName: "顾言", modelProfileId: "deepseek" },
  { title: "增长运营", displayName: "韩舟", modelProfileId: "deepseek" },
  { title: "客户支持", displayName: "叶宁", modelProfileId: "deepseek" },
  { title: "财务合规", displayName: "沈律", modelProfileId: "deepseek" },
] as const;

const seedingCrew = new Map<string, Promise<void>>();

async function organizationTree(context: ForgeDaemonContext, companyId: string) {
  return context.company.org.tree(companyId);
}

async function ensureOperatingCrew(context: ForgeDaemonContext, params: Params) {
  const companyId = companyIdParam(params);
  await seedOperatingCrew(context, companyId);
  const workspaceId = optionalStringParam(params, "workspaceId");
  if (workspaceId) {
    grantDefaultWorkspace(context, { companyId, workspaceId });
  }
  return context.company.org.tree(companyId);
}

async function onboardOptions(context: ForgeDaemonContext, companyId: string) {
  context.company.org.ensureOperatingSeats(companyId);
  const tree = context.company.org.tree(companyId);
  const occupied = new Set(
    tree.employees
      .filter((employee) => employee.status === "active")
      .map((employee) => employee.positionId),
  );
  return {
    positions: tree.positions.map((position) => ({
      id: position.id,
      title: position.title,
      occupied: occupied.has(position.id),
      talentTemplateId: talentTemplateIdForSeatTitle(position.title),
    })),
    talents: await listOnboardTalents(context),
    models: listModelProfiles(),
    workspaces: listCoreWorkspaces(context),
  };
}

async function onboardEmployee(context: ForgeDaemonContext, params: Params) {
  const companyId = companyIdParam(params);
  const talent = await resolveTalentTemplate(
    context,
    stringParam(params, "talentTemplateId"),
  );
  const modelProfileId = resolveModelProfile(optionalModelProfileId(params));
  const workspaces = workspaceGrantsParam(context, params);
  return context.store.db.transaction(() => {
    const hired = context.company.org.hire({
      companyId,
      displayName: stringParam(params, "displayName"),
      positionId: stringParam(params, "positionId"),
      managerEmployeeId: optionalStringParam(params, "managerEmployeeId"),
      autonomyLevel: 2,
    });
    const binding = bindEmployeeKit(context, {
      companyId,
      employeeId: hired.id,
      talent,
      modelProfileId,
      workspaces,
    });
    return { ...hired, ...binding };
  })();
}

async function bindEmployee(context: ForgeDaemonContext, params: Params) {
  const companyId = companyIdParam(params);
  const talent = await resolveTalentTemplate(
    context,
    stringParam(params, "talentTemplateId"),
  );
  return bindEmployeeKit(context, {
    companyId,
    employeeId: stringParam(params, "employeeId"),
    talent,
    modelProfileId: resolveModelProfile(optionalModelProfileId(params)),
    workspaces: workspaceGrantsParam(context, params),
  });
}

function bindEmployeeKit(
  context: Pick<ForgeDaemonContext, "company" | "agentProfiles">,
  input: {
    companyId: string;
    employeeId: string;
    talent: ResolvedTalentKit;
    modelProfileId?: string;
    workspaces: ReturnType<typeof workspaceGrantsParam>;
  },
) {
  const published = context.agentProfiles?.createFromTalent({
    source: {
      templateId: input.talent.id,
      name: input.talent.role,
      suggestedSkills: input.talent.skills,
      suggestedTools: input.talent.tools,
      knowledgeRefs: input.talent.knowledgeRefs,
      connectors: input.talent.connectors,
    },
    hired: { skills: input.talent.skills, tools: input.talent.tools },
    model: input.modelProfileId,
  });
  return context.company.org.bindCapability({
    companyId: input.companyId,
    employeeId: input.employeeId,
    talentTemplateId: input.talent.id,
    talentRole: input.talent.role,
    skills: input.talent.skills,
    tools: input.talent.tools,
    modelProfileId: input.modelProfileId,
    systemPrompt: input.talent.systemPrompt,
    methodology: input.talent.methodology,
    qualityGates: input.talent.qualityGates,
    knowledgeRefs: input.talent.knowledgeRefs,
    connectors: input.talent.connectors,
    agentProfileId: published?.profileId,
    agentProfileVersionId: published?.id,
    workspaces: input.workspaces,
  });
}

async function listOnboardTalents(context: ForgeDaemonContext) {
  if (!context.dataDir) return [];
  try {
    const result = await handleListTalentTemplates({}, { dataDir: context.dataDir });
    return result.templates.map((template) => ({
      id: template.id,
      role: template.role,
      category: template.category,
      description: template.description,
      suggestedSkills: template.suggestedSkills ?? [],
      suggestedTools: template.suggestedTools ?? [],
    }));
  } catch {
    return [];
  }
}

type ResolvedTalentKit = {
  id: string;
  role: string;
  skills: string[];
  tools: string[];
  systemPrompt: string;
  methodology: string[];
  qualityGates: string[];
  knowledgeRefs: string[];
  connectors: string[];
};

async function resolveTalentTemplate(
  context: ForgeDaemonContext,
  talentTemplateId: string,
): Promise<ResolvedTalentKit> {
  const talents = await listOnboardTalents(context);
  const found = talents.find((talent) => talent.id === talentTemplateId);
  if (talents.length > 0 && !found) {
    invalidRequest("talent template not found");
  }
  if (context.dataDir) {
    try {
      const result = await handleGetTalentTemplate(
        { templateId: talentTemplateId },
        { dataDir: context.dataDir },
      );
      const template = result.template;
      if (template) {
        return {
          id: template.id,
          role: template.role || talentTemplateId,
          skills: template.suggestedSkills ?? [],
          tools: template.suggestedTools ?? [],
          systemPrompt: template.systemPrompt || "",
          methodology: template.methodology || [],
          qualityGates: template.qualityGates || [],
          knowledgeRefs: template.knowledgeRefs || [],
          connectors: template.connectors || [],
        };
      }
    } catch {
      /* fall through to the list snapshot */
    }
  }
  return {
    id: talentTemplateId,
    role: found?.role || talentTemplateId,
    skills: found?.suggestedSkills ?? [],
    tools: found?.suggestedTools ?? [],
    systemPrompt: "",
    methodology: [],
    qualityGates: [],
    knowledgeRefs: [],
    connectors: [],
  };
}

function optionalModelProfileId(params: Params): string | undefined {
  const value = params.modelProfileId;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    invalidRequest("modelProfileId must be a string");
  }
  return value.trim();
}

function resolveModelProfile(modelProfileId?: string): string | undefined {
  if (!modelProfileId) return undefined;
  const models = listModelProfiles();
  if (
    models.length > 0 &&
    !models.some((model) => model.id === modelProfileId || model.name === modelProfileId)
  ) {
    invalidRequest("model profile not found");
  }
  return modelProfileId;
}

function listCoreWorkspaces(context: ForgeDaemonContext) {
  const registered = context.store.db.prepare(
    `SELECT id, root_path AS rootPath, label
    FROM core_workspaces
    ORDER BY created_at, id`,
  ).all() as Array<{ id: string; rootPath: string; label: string | null }>;
  const registeredByPath = new Map(
    registered.map((workspace) => [workspace.rootPath, workspace]),
  );
  const byPath = new Map<string, {
    id: string;
    rootPath: string;
    label: string;
  }>();
  for (const project of listSharedProjects()) {
    const cwd = project.cwd.trim();
    if (!isAssignableProjectPath(cwd)) continue;
    const match = registeredByPath.get(cwd);
    byPath.set(cwd, {
      id: match?.id ?? project.id,
      rootPath: cwd,
      label: workspaceDisplayName(cwd, project.name || match?.label || null),
    });
  }
  return [...byPath.values()];
}

function workspaceDisplayName(rootPath: string, label: string | null): string {
  if (label && !label.startsWith("Automation ")) return label;
  return basename(rootPath) || rootPath;
}

function isAssignableProjectPath(rootPath: string): boolean {
  const path = rootPath.trim();
  if (!path || path === ".") return false;
  return !path.includes("/.worktrees/");
}

function resolveListedWorkspaceId(context: ForgeDaemonContext, workspaceId: string) {
  const listed = listCoreWorkspaces(context);
  const direct = listed.find((item) => item.id === workspaceId);
  if (direct) return direct.id;
  return listed.find((item) => item.rootPath === workspaceId)?.id;
}

function resolveWorkspaceRecord(context: ForgeDaemonContext, workspaceId: string) {
  const listed = listCoreWorkspaces(context);
  const hit = listed.find((item) => item.id === workspaceId || item.rootPath === workspaceId);
  if (hit) return hit;
  const row = context.store.db.prepare(
    `SELECT id, root_path AS rootPath, label
    FROM core_workspaces
    WHERE id = ? OR root_path = ?`,
  ).get(workspaceId, workspaceId) as
    | { id: string; rootPath: string; label: string | null }
    | undefined;
  if (!row || !isAssignableProjectPath(row.rootPath)) return undefined;
  return {
    id: row.id,
    rootPath: row.rootPath,
    label: workspaceDisplayName(row.rootPath, row.label),
  };
}

/**
 * Shared Forge projects can be granted/bound by id before they exist in core_workspaces.
 * Research governance, leases, and workspace bindings only accept core rows,
 * so materialize on grant/start/project bind.
 */
function materializeWorkspaceId(context: ForgeDaemonContext, workspaceId: string): string {
  const existing = context.store.db
    .prepare(`SELECT id FROM core_workspaces WHERE id = ?`)
    .get(workspaceId) as { id: string } | undefined;
  if (existing) return existing.id;

  const record = resolveWorkspaceRecord(context, workspaceId);
  if (!record) return workspaceId;
  const byPath = context.store.db
    .prepare(
      `SELECT id FROM core_workspaces
      WHERE root_path = ? OR canonical_root_path = ?
      ORDER BY created_at, id LIMIT 1`,
    )
    .get(record.rootPath, record.rootPath) as { id: string } | undefined;
  if (byPath) return byPath.id;
  if (!context.workspaceGroups || !existsSync(record.rootPath)) return record.id;
  try {
    context.workspaceGroups.registerWorkspace({
      id: record.id,
      rootPath: record.rootPath,
      label: record.label,
    });
    return record.id;
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    const conflict = message.match(/already registered to workspace (\S+)/);
    if (conflict?.[1]) return conflict[1];
    throw error;
  }
}

function ensureCompanyGrantedWorkspaces(context: ForgeDaemonContext, companyId: string): void {
  const grants = context.store.db
    .prepare(
      `SELECT DISTINCT workspace_id AS workspaceId
      FROM company_employee_workspaces
      WHERE company_id = ?`,
    )
    .all(companyId) as Array<{ workspaceId: string }>;
  for (const grant of grants) {
    const materialized = materializeWorkspaceId(context, grant.workspaceId);
    if (materialized === grant.workspaceId) continue;
    context.store.db
      .prepare(
        `UPDATE company_employee_workspaces
        SET workspace_id = ?
        WHERE company_id = ? AND workspace_id = ?`,
      )
      .run(materialized, companyId, grant.workspaceId);
  }
}

function workspaceGrantsParam(context: ForgeDaemonContext, params: Params) {
  const value = params.workspaces;
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidRequest("workspaces must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      invalidRequest("workspace grant must be an object");
    }
    const grant = entry as Record<string, unknown>;
    const workspaceId = typeof grant.workspaceId === "string"
      ? grant.workspaceId.trim()
      : "";
    if (!workspaceId) invalidRequest("workspaceId must be a non-empty string");
    const resolved = resolveListedWorkspaceId(context, workspaceId);
    if (!resolved) invalidRequest("workspace not found");
    const writable = grant.mode === "write" || grant.isDefault === true;
    const env = grant.env === "staging" || grant.env === "prod" ? grant.env : "dev";
    const row: EmployeeWorkspaceGrant = {
      workspaceId: materializeWorkspaceId(context, resolved),
      mode: writable ? "write" : "read",
      isDefault: grant.isDefault === true,
    };
    if (env !== "dev") row.env = env;
    return row;
  });
}

async function createCompany(context: ForgeDaemonContext, name: string) {
  const created = context.company.companies.create({ name });
  if (context.budgetLedger) {
    ensureCompanyBudgetAccount(context.store.db, {
      companyId: created.id,
      companyName: created.name,
      createdAt: new Date().toISOString(),
      createAccount: (account) => context.budgetLedger!.createAccount(account),
    });
  }
  await seedOperatingCrew(context, created.id);
  return created;
}

function seedOperatingCrew(context: ForgeDaemonContext, companyId: string) {
  const pending = seedingCrew.get(companyId);
  if (pending) return pending;
  const done = seedOperatingCrewOnce(context, companyId).finally(() => {
    if (seedingCrew.get(companyId) === done) seedingCrew.delete(companyId);
  });
  seedingCrew.set(companyId, done);
  return done;
}

async function seedOperatingCrewOnce(
  context: ForgeDaemonContext,
  companyId: string,
) {
  context.company.org.ensureOperatingSeats(companyId);
  const tree = context.company.org.tree(companyId);
  const occupied = new Set(
    tree.employees
      .filter((employee) => employee.status === "active")
      .map((employee) => employee.positionId),
  );
  const takenNames = new Set(tree.employees.map((employee) => employee.displayName));
  let ownerId = tree.employees.find((employee) => {
    const title = tree.positions.find((position) => position.id === employee.positionId)?.title;
    return title === "研发负责人";
  })?.id;
  const workspaces = defaultCrewWorkspaces(tree);

  for (const crew of OPERATING_CREW) {
    const position = tree.positions.find((entry) => entry.title === crew.title);
    if (!position || occupied.has(position.id)) continue;
    const talentTemplateId = talentTemplateIdForSeatTitle(crew.title);
    if (!talentTemplateId) continue;
    const displayName = uniqueCrewName(crew.displayName, takenNames);
    const talent = await resolveTalentTemplate(context, talentTemplateId);
    const modelProfileId = pickCrewModel(crew.modelProfileId);
    let hired: { id: string };
    try {
      hired = context.store.db.transaction(() => {
        const created = context.company.org.hire({
          companyId,
          displayName,
          positionId: position.id,
          managerEmployeeId: crew.title === "研发负责人" ? undefined : ownerId,
          autonomyLevel: 2,
        });
        bindEmployeeKit(context, {
          companyId,
          employeeId: created.id,
          talent,
          modelProfileId,
          workspaces,
        });
        return created;
      })();
    } catch (error) {
      if (String(error instanceof Error ? error.message : error).includes("occupied")) {
        continue;
      }
      throw error;
    }
    occupied.add(position.id);
    takenNames.add(displayName);
    if (crew.title === "研发负责人") ownerId = hired.id;
  }
}

function uniqueCrewName(preferred: string, taken: Set<string>): string {
  if (!taken.has(preferred)) return preferred;
  for (let index = 2; index < 10; index += 1) {
    const candidate = `${preferred}${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${preferred}-${Date.now().toString(36)}`;
}

function pickCrewModel(preferred: string): string | undefined {
  const models = listModelProfiles();
  if (models.length === 0) return undefined;
  const hit = models.find((model) => model.id === preferred || model.name === preferred);
  return hit?.id ?? models[0].id;
}

function defaultCrewWorkspaces(
  tree: ReturnType<ForgeDaemonContext["company"]["org"]["tree"]>,
): EmployeeWorkspaceGrant[] {
  for (const employee of tree.employees) {
    const grant = (employee.workspaces || []).find(
      (item) => item.isDefault && item.mode === "write",
    );
    if (grant) return [{ ...grant }];
  }
  return [];
}

function grantDefaultWorkspace(context: ForgeDaemonContext, params: Params) {
  const companyId = companyIdParam(params);
  const workspaceId = stringParam(params, "workspaceId");
  const resolved = resolveListedWorkspaceId(context, workspaceId)
    ?? resolveWorkspaceRecord(context, workspaceId)?.id;
  if (!resolved) invalidRequest("workspace not found");
  const grant: EmployeeWorkspaceGrant = {
    workspaceId: materializeWorkspaceId(context, resolved),
    mode: "write",
    isDefault: true,
  };
  const tree = context.company.org.tree(companyId);
  let updated = 0;
  for (const employee of tree.employees) {
    if (employee.status !== "active") continue;
    const hasDefaultWrite = (employee.workspaces || []).some(
      (item) => item.isDefault && item.mode === "write",
    );
    if (hasDefaultWrite) continue;
    context.company.org.grantWorkspaces({
      companyId,
      employeeId: employee.id,
      workspaces: [...(employee.workspaces || []), grant],
    });
    updated += 1;
  }
  return {
    workspaceId: resolved,
    updated,
    tree: context.company.org.tree(companyId),
  };
}

function bindProjectWorkspaces(context: ForgeDaemonContext, params: Params) {
  const companyId = companyIdParam(params);
  const projectId = stringParam(params, "projectId");
  const workspaceIds = params.workspaceIds;
  if (!Array.isArray(workspaceIds) || workspaceIds.length === 0) {
    invalidRequest("workspaceIds must be a non-empty array");
  }
  const project = context.store.db.prepare(
    `SELECT id, title FROM company_projects WHERE company_id = ? AND id = ?`,
  ).get(companyId, projectId) as { id: string; title: string } | undefined;
  if (!project) invalidRequest("project not found");
  if (!context.workspaceGroups) {
    throw new Error("workspace groups unavailable");
  }
  const group = context.workspaceGroups.createGroup({ name: project.title });
  const boundWorkspaceIds: string[] = [];
  for (const raw of workspaceIds) {
    const workspaceId = typeof raw === "string" ? raw.trim() : "";
    if (!workspaceId) invalidRequest("workspaceIds must be strings");
    const workspace = resolveWorkspaceRecord(context, workspaceId);
    if (!workspace) invalidRequest("workspace not found");
    // Shared Forge projects appear in the picker before core_workspaces has a row.
    // Bindings FK core_workspaces(id), so materialize first (same as employee grants).
    const coreWorkspaceId = materializeWorkspaceId(context, workspace.id);
    const coreRow = context.store.db
      .prepare(`SELECT id FROM core_workspaces WHERE id = ?`)
      .get(coreWorkspaceId) as { id: string } | undefined;
    if (!coreRow) {
      invalidRequest(
        `workspace not registered in core_workspaces: ${workspace.rootPath}`,
      );
    }
    context.workspaceGroups.bindWorkspace({
      groupId: group.id,
      workspaceId: coreWorkspaceId,
      rootPath: workspace.rootPath,
      mode: "write",
    });
    boundWorkspaceIds.push(coreWorkspaceId);
  }
  bindProjectWorkspaceGroup(context.store.db, {
    companyId,
    projectId,
    groupId: group.id,
    createdAt: new Date().toISOString(),
  });
  // Research / requestRun require employee grants inside the project group.
  // Binding the group is the CEO authorization to work there — merge write access.
  const granted = grantProjectGroupWorkspaces(context, companyId, boundWorkspaceIds);
  return { projectId, groupId: group.id, grantedEmployees: granted };
}

function grantProjectGroupWorkspaces(
  context: ForgeDaemonContext,
  companyId: string,
  workspaceIds: string[],
): number {
  const uniqueIds = [...new Set(workspaceIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return 0;
  const tree = context.company.org.tree(companyId);
  let updated = 0;
  for (const employee of tree.employees) {
    if (employee.status !== "active") continue;
    const existing = employee.workspaces || [];
    const byId = new Map(existing.map((grant) => [grant.workspaceId, { ...grant }]));
    let changed = false;
    for (const workspaceId of uniqueIds) {
      const prev = byId.get(workspaceId);
      if (prev?.mode === "write") continue;
      byId.set(workspaceId, {
        workspaceId,
        mode: "write",
        isDefault: prev?.isDefault ?? false,
        ...(prev?.env ? { env: prev.env } : {}),
      });
      changed = true;
    }
    if (!changed && existing.length > 0) continue;
    if (existing.length === 0) {
      const first = byId.get(uniqueIds[0]!);
      if (first) first.isDefault = true;
      changed = true;
    }
    if (!changed) continue;
    context.company.org.grantWorkspaces({
      companyId,
      employeeId: employee.id,
      workspaces: [...byId.values()],
    });
    updated += 1;
  }
  return updated;
}

function ceoBrief(context: ForgeDaemonContext, companyId: string) {
  const company = context.company.companies.get(companyId);
  const snapshot = dashboard(context, companyId);
  const employees = context.company.org.tree(companyId).employees;
  return buildCeoBrief({
    companyName: company.name,
    dashboard: snapshot,
    employees,
  });
}

async function requestRun(context: ForgeDaemonContext, workItemId: string) {
  if (context.store.db.prepare(`SELECT 1 FROM company_work_items w JOIN company_projects p ON p.id = w.project_id WHERE w.id = ? AND p.state = 'completed'`).get(workItemId)) throw new Error("project is completed");
  const plan = context.company.gates.assertImplementationRunAllowed(workItemId);
  const item = getWorkItem(context, workItemId);
  if (!item.assigneeId) {
    throw new Error("work item has no assignee");
  }
  assertNoActiveRun(context, workItemId);
  const employee = context.company.org.tree(item.companyId).employees
    .find((entry) => entry.id === item.assigneeId);
  let grant = employee?.workspaces.find((row) => row.isDefault && row.mode === "write");
  if (item.projectId && context.workspaceGroups) {
    const groupId = getProjectWorkspaceGroupId(context.store.db, item.projectId);
    if (groupId) {
      const groupIds = context.workspaceGroups.listBindings(groupId)
        .map((binding) => binding.workspaceId);
      const picked = pickProjectWriteGrant(employee?.workspaces || [], groupIds);
      if (!picked) {
        throw new Error("assignee has no write workspace in the project group");
      }
      grant = picked;
    }
  }
  if (!grant) {
    throw new Error("assignee has no default write workspace");
  }
  const workspace = resolveWorkspaceRecord(context, grant.workspaceId);
  if (!workspace) {
    throw new Error("workspace not found");
  }
  const artifacts = context.company.work.listArtifacts(workItemId);
  const accepted = (kind: "intent" | "spec" | "plan") =>
    artifacts.find((row) => row.kind === kind && row.status === "accepted")?.content;
  const capability = await employeeCapabilityFor(context, employee);
  const memories = recallEmployeeMemories(
    context.store.db,
    item.companyId,
    item.assigneeId,
  ).map((row) => row.content);
  const spec = runRequestToRunSpec(
    {
      cwd: workspace.rootPath,
      message: buildCompanyRunMessage({
        workType: item.type,
        title: item.title,
        assigneeName: employee?.displayName ?? item.assigneeId,
        talentRole: capability.role || employee?.profile?.talentRole,
        intent: accepted("intent") ?? item.problem,
        spec: accepted("spec") ?? "",
        plan: accepted("plan") ?? plan.content,
        capability,
        memories,
      }),
      autoApply: companyRunAutoApply(employee?.autonomyLevel, grant.env),
      companyWorkItemId: workItemId,
      automationRun: { name: item.title },
      ...(capability.modelProfileId
        ? { runtime: { provider: "forge", model: capability.modelProfileId } }
        : {}),
    },
    { runId: () => randomUUID(), correlationId: () => randomUUID() },
  );
  spec.objective = item.title;
  spec.requestedBy = { kind: "employee", id: item.assigneeId };
  spec.actingSubject = {
    kind: "agent_profile",
    id: capability.agentProfileId || "forge-default",
  };
  spec.policyContext = {
    companyWorkItemId: workItemId,
    employeeId: item.assigneeId,
    ...(capability.agentProfileVersionId
      ? { profileVersionId: capability.agentProfileVersionId }
      : {}),
  };
  const accountId = getCompanyBudgetAccountId(context.store.db, item.companyId);
  if (accountId && context.budgetLedger) {
    if (!companyBudgetAllowsRun(context.budgetLedger.balance(accountId))) {
      throw new Error("company budget exhausted");
    }
    spec.budgetAccountId = accountId;
  }
  if (existsSync(workspace.rootPath)) {
    for (const artifact of artifacts) {
      persistWorkArtifactFile({ workspaceRoot: workspace.rootPath }, artifact, context.store.db);
    }
  }
  const created = createLinkedCompanyRun(spec, context, spec.correlationId);
  if (context.workspaceLeases && existsSync(workspace.rootPath)) {
    try {
      context.workspaceLeases.acquire({
        workspaceId: workspace.id,
        runId: created.runId,
        mode: "write",
        rootPath: workspace.rootPath,
        expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      });
    } catch (caught) {
      if (
        caught instanceof Error &&
        caught.name === "WorkspaceConflictError" &&
        !caught.message.includes("does not match registered")
      ) {
        throw new Error("workspace write lease conflict");
      }
    }
  }
  if (
    capability.agentProfileId &&
    capability.agentProfileVersionId &&
    context.agentProfiles
  ) {
    context.agentProfiles.resolveSnapshot({
      profileId: capability.agentProfileId,
      profileVersionId: capability.agentProfileVersionId,
      runId: created.runId,
    });
  }
  return {
    workItemId,
    planArtifactId: plan.id,
    runId: created.runId,
  };
}

function assertNoActiveRun(context: ForgeDaemonContext, workItemId: string) {
  const links = context.store.db
    .prepare(
      `SELECT run_id AS runId FROM company_run_links
      WHERE work_item_id = ? AND TRIM(run_id) <> ''`,
    )
    .all(workItemId) as Array<{ runId: string }>;
  for (const { runId } of links) {
    const run = context.executionStore.getRun(runId);
    if (run && !isTerminalRunState(run.state)) {
      throw new Error("work item already has an active run");
    }
  }
}

export async function previewCompanyApprovalForRun(
  context: Pick<ForgeDaemonContext, "store" | "company"> & { dataDir?: string },
  runId: string,
  generateDraft?: (prompt: string, model?: string) => Promise<string>,
): Promise<{
  workItemId: string;
  reviewerId: string;
  reviewerName?: string;
  runId?: string;
  recommendation: "approved" | "rejected" | null;
  summary: string;
  findings: string[];
  source: "employee" | "unavailable";
  talentRole: string;
  createdAt?: string;
} | null> {
  const link = context.store.db.prepare(
    `SELECT work_item_id AS workItemId FROM company_run_links
    WHERE run_id = ? AND TRIM(run_id) <> ''
    ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(runId) as { workItemId: string } | undefined;
  if (!link) return null;
  const item = getWorkItem(context, link.workItemId);
  if (!["submitted", "waiting_approval", "verifying"].includes(item.state)) {
    return null;
  }
  return previewApproval(context, link.workItemId, generateDraft);
}

async function previewApproval(
  context: Pick<ForgeDaemonContext, "store" | "company"> & { dataDir?: string },
  workItemId: string,
  generateDraft?: (prompt: string, model?: string) => Promise<string>,
) {
  const item = getWorkItem(context, workItemId);
  if (!["submitted", "waiting_approval", "verifying"].includes(item.state)) {
    throw new Error("work item is not a submission");
  }
  const runId = item.runIds?.[item.runIds.length - 1];
  const existing = readLatestPreview(context, workItemId);
  if (
    existing
    && existing.schemaVersion === REVIEW_PREVIEW_SCHEMA
    && (!runId || existing.runId === runId)
  ) {
    return { workItemId, ...existing };
  }
  const tree = context.company.org.tree(item.companyId);
  const reviewerId = pickDefaultReviewerId({
    employees: tree.employees,
    positions: tree.positions,
    assigneeId: item.assigneeId,
    ownerId: item.ownerId,
  });
  if (!reviewerId || reviewerId === item.assigneeId) {
    throw new Error("executor cannot approve own work");
  }
  const employee = tree.employees.find((entry) => entry.id === reviewerId);
  if (!employee) throw new Error("reviewer not found");
  const position = tree.positions.find((entry) => entry.id === employee.positionId);
  const artifacts = context.company.work.listArtifacts(workItemId);
  const accepted = (kind: "intent" | "spec" | "plan") =>
    artifacts.find((row) => row.kind === kind && row.status === "accepted")?.content ?? "";
  const composed = await composeReviewPreview({
    title: item.title,
    problem: item.problem,
    expectedOutcome: item.expectedOutcome,
    spec: accepted("spec"),
    plan: accepted("plan"),
    workType: item.type,
    resultExcerpt: reviewResultExcerpt(item),
    workspaceFiles: item.trace?.workspaceFiles?.map((file) => file.path) || [],
    runId,
    reviewer: {
      id: employee.id,
      displayName: employee.displayName,
      title: position?.title,
    },
    talent: await employeeTalentPack(context, employee),
    memories: recallEmployeeMemories(context.store.db, item.companyId, employee.id)
      .map((row) => row.content),
    generate: async (prompt) => {
      const model = employee.profile?.modelProfileId;
      return generateDraft
        ? generateDraft(prompt, model)
        : generateCompanyDraft(prompt, model);
    },
  });
  const decision = composed.recommendation === "rejected"
    ? "preview_reject"
    : composed.recommendation === "approved"
      ? "preview_approve"
      : "preview_failed";
  context.store.db.prepare(
    `INSERT INTO company_decisions
      (id, company_id, work_item_id, employee_id, decision, reason, version,
        created_at, updated_at)
    VALUES
      (@id, @companyId, @workItemId, @employeeId, @decision, @reason, @version,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run({
    id: newCompanyId("decision"),
    companyId: item.companyId,
    workItemId,
    employeeId: reviewerId,
    decision,
    reason: encodeReviewPreviewReason({ ...composed, runId }),
    version: 1,
  });
  return {
    ...composed,
    workItemId,
    reviewerName: employee.displayName,
    runId,
  };
}

type EmployeeCapabilityContext = Pick<ForgeDaemonContext, "store" | "company"> & {
  dataDir?: string;
  agentProfiles?: ForgeDaemonContext["agentProfiles"];
};

async function employeeTalentPack(
  context: EmployeeCapabilityContext,
  employee: {
    id?: string;
    companyId?: string;
    profile?: Parameters<typeof resolveEmployeeCapability>[0];
  },
) {
  return toDraftTalentPack(await employeeCapabilityFor(context, employee));
}

async function employeeCapabilityFor(
  context: EmployeeCapabilityContext,
  employee?: {
    id?: string;
    companyId?: string;
    profile?: Parameters<typeof resolveEmployeeCapability>[0];
  } | null,
) {
  const capability = resolveEmployeeCapability(employee?.profile);
  if (!capabilityNeedsTemplateFill(capability) || !employee?.profile?.talentTemplateId) {
    return ensureEmployeeAgentProfile(context, employee, capability);
  }
  if (!context.dataDir) {
    return ensureEmployeeAgentProfile(context, employee, capability);
  }
  try {
    const result = await handleGetTalentTemplate(
      { templateId: employee.profile.talentTemplateId },
      { dataDir: context.dataDir },
    );
    const template = result.template;
    if (!template) return ensureEmployeeAgentProfile(context, employee, capability);
    return ensureEmployeeAgentProfile(context, employee, {
      ...capability,
      role: template.role || capability.role,
      skills: capability.skills.length ? capability.skills : template.suggestedSkills || [],
      tools: capability.tools.length ? capability.tools : template.suggestedTools || [],
      qualityGates: template.qualityGates || [],
      methodology: template.methodology || [],
      systemPrompt: template.systemPrompt || "",
      knowledgeRefs: template.knowledgeRefs || capability.knowledgeRefs,
      connectors: template.connectors || capability.connectors,
    });
  } catch {
    return ensureEmployeeAgentProfile(context, employee, capability);
  }
}

function ensureEmployeeAgentProfile(
  context: Pick<ForgeDaemonContext, "company"> & {
    agentProfiles?: ForgeDaemonContext["agentProfiles"];
  },
  employee: {
    id?: string;
    companyId?: string;
    profile?: { talentTemplateId?: string } | null;
  } | null | undefined,
  capability: ReturnType<typeof resolveEmployeeCapability>,
) {
  if (capability.agentProfileId || !employee?.id || !employee.companyId || !context.agentProfiles) {
    return capability;
  }
  if (!employee.profile?.talentTemplateId) return capability;
  const published = context.agentProfiles.createFromTalent({
    source: {
      templateId: employee.profile.talentTemplateId,
      name: capability.role || employee.profile.talentTemplateId,
      suggestedSkills: capability.skills,
      suggestedTools: capability.tools,
      knowledgeRefs: capability.knowledgeRefs,
      connectors: capability.connectors,
    },
    hired: { skills: capability.skills, tools: capability.tools },
    model: capability.modelProfileId,
  });
  const current = context.company.org.tree(employee.companyId).employees
    .find((entry) => entry.id === employee.id);
  context.company.org.bindCapability({
    companyId: employee.companyId,
    employeeId: employee.id,
    talentTemplateId: employee.profile.talentTemplateId,
    talentRole: capability.role || employee.profile.talentTemplateId,
    skills: capability.skills,
    tools: capability.tools,
    modelProfileId: capability.modelProfileId,
    systemPrompt: capability.systemPrompt,
    methodology: capability.methodology,
    qualityGates: capability.qualityGates,
    agentProfileId: published.profileId,
    agentProfileVersionId: published.id,
    workspaces: current?.workspaces || [],
  });
  return {
    ...capability,
    agentProfileId: published.profileId,
    agentProfileVersionId: published.id,
  };
}

function pauseWorkItemForFix(context: ForgeDaemonContext, params: Params) {
  const workItemId = stringParam(params, "workItemId");
  const reason = stringParam(params, "reason");
  const item = getWorkItem(context, workItemId);
  const fix = context.company.work.pauseForFix({
    workItemId,
    reason,
    ownerId: stringParam(params, "ownerId"),
  });
  rememberAssigneeLesson(context, item, "gate", `执行失败待修：${reason}`);
  return fix;
}

function rememberAssigneeLesson(
  context: Pick<ForgeDaemonContext, "store">,
  item: { companyId: string; id: string; assigneeId?: string | null; title?: string },
  kind: "lesson" | "gate",
  content: string,
) {
  if (!item.assigneeId) return;
  rememberEmployeeMemory(context.store.db, { now: () => new Date().toISOString() }, {
    companyId: item.companyId,
    employeeId: item.assigneeId,
    kind,
    content,
    sourceWorkItemId: item.id,
  });
}

function readLatestPreview(
  context: Pick<ForgeDaemonContext, "store" | "company">,
  workItemId: string,
) {
  const row = context.store.db.prepare(
    `SELECT employee_id AS reviewerId, reason, created_at AS createdAt
    FROM company_decisions
    WHERE work_item_id = ? AND decision LIKE 'preview_%'
    ORDER BY created_at DESC, id DESC
    LIMIT 1`,
  ).get(workItemId) as { reviewerId: string; reason: string; createdAt: string } | undefined;
  if (!row) return null;
  const decoded = decodeReviewPreviewReason(row.reason);
  if (!decoded) return null;
  const treeEmployee = (() => {
    try {
      const item = context.store.db.prepare(
        "SELECT company_id AS companyId FROM company_work_items WHERE id = ?",
      ).get(workItemId) as { companyId: string } | undefined;
      if (!item) return undefined;
      return context.company.org.tree(item.companyId).employees
        .find((entry) => entry.id === row.reviewerId);
    } catch {
      return undefined;
    }
  })();
  return {
    reviewerId: row.reviewerId,
    reviewerName: treeEmployee?.displayName,
    runId: decoded.runId ?? undefined,
    schemaVersion: decoded.schemaVersion,
    recommendation: decoded.recommendation,
    summary: decoded.summary,
    findings: decoded.findings,
    source: decoded.source,
    talentRole: decoded.talentRole,
    createdAt: row.createdAt,
  };
}

function reviewResultExcerpt(item: ReturnType<typeof getWorkItem>): string {
  const reports = (item.trace?.outputs || [])
    .filter((output) => output.content?.trim())
    .map((output) => String(output.content).trim().slice(0, 4000));
  return reports.join("\n\n").slice(0, 8000);
}

function decideApproval(context: ForgeDaemonContext, params: Params) {
  const workItemId = stringParam(params, "workItemId");
  const actorId = stringParam(params, "actorId");
  const item = getWorkItem(context, workItemId);
  if (!["submitted", "waiting_approval", "verifying"].includes(item.state)) {
    throw new Error("work item is not a submission");
  }
  if (item.assigneeId === actorId) {
    throw new Error("executor cannot approve own work");
  }
  const decision = approvalDecisionParam(params);
  const reason = decision === "rejected"
    ? stringParam(params, "reason")
    : optionalReasonParam(params);
  const result = {
    id: newCompanyId("decision"),
    companyId: item.companyId,
    workItemId,
    employeeId: actorId,
    decision,
    reason,
    version: 1,
  };
  context.store.db.transaction(() => {
    context.store.db.prepare(
      `INSERT INTO company_decisions
        (id, company_id, work_item_id, employee_id, decision, reason, version,
          created_at, updated_at)
      VALUES
        (@id, @companyId, @workItemId, @employeeId, @decision, @reason, @version,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(result);
    rememberAssigneeLesson(
      context,
      item,
      decision === "approved" ? "lesson" : "gate",
      decision === "approved"
        ? (reason ? `验收通过：${item.title}。${reason}` : `验收通过：${item.title}`)
        : `验收驳回：${reason || item.title}`,
    );
  })();
  if (decision === "approved") {
    const runId = item.runIds?.[item.runIds.length - 1];
    if (runId) {
      context.company.gates.recordAcceptance(
        runId,
        reason || "独立验收通过",
      );
    }
    const closed = context.company.work.completeDelivery(workItemId);
    return { ...result, state: closed.state };
  }
  const fixWorkItem = context.company.work.pauseForFix({
    workItemId,
    reason: reason || item.title,
    ownerId: item.assigneeId || item.ownerId,
  });
  return {
    ...result,
    state: "blocked",
    fixWorkItem: {
      id: fixWorkItem.id,
      title: fixWorkItem.title,
      parentId: workItemId,
    },
  };
}

function listApprovals(context: ForgeDaemonContext, companyId: string) {
  const pending = context.store.db.prepare(
    `${workItemSelect()}
    WHERE company_id = ? AND state = 'waiting_approval'
    ORDER BY updated_at DESC LIMIT 20`,
  ).all(companyId) as Array<{ id: string }>;
  const decisions = context.store.db.prepare(
    `SELECT decision.id, decision.company_id AS companyId,
      decision.work_item_id AS workItemId, decision.employee_id AS employeeId,
      decision.decision, decision.reason, decision.version,
      decision.created_at AS createdAt, item.title
    FROM company_decisions AS decision
    JOIN company_work_items AS item ON item.id = decision.work_item_id
    WHERE decision.company_id = ? AND decision.decision IN ('approved', 'rejected')
    ORDER BY decision.created_at DESC LIMIT 20`,
  ).all(companyId);
  return {
    pending: pending.map((item) => ({
      ...item,
      preview: readLatestPreview(context, item.id),
    })),
    decisions,
  };
}

function dashboard(context: ForgeDaemonContext, companyId: string) {
  context.company.companies.get(companyId);
  const workItems = listWorkItems(context, companyId);
  const goals = listGoals(context, companyId);
  const projects = listProjects(context, companyId);
  const pendingApprovals = (context.store.db.prepare(
    `SELECT COUNT(*) AS count FROM company_work_items
    WHERE company_id = ? AND state = 'waiting_approval'`,
  ).get(companyId) as { count: number }).count;
  const accountId = getCompanyBudgetAccountId(context.store.db, companyId);
  const balance = accountId && context.budgetLedger
    ? context.budgetLedger.balance(accountId)
    : undefined;
  return buildCompanyDashboard({
    companyId,
    employees: context.company.org.tree(companyId).employees.length,
    goals,
    projects,
    workItems,
    pendingApprovals,
    ...(accountId && balance
      ? {
        budget: {
          accountId,
          currency: balance.currency,
          ...(balance.availableMinor != null
            ? { availableMinor: Number(balance.availableMinor) }
            : {}),
          ...(balance.hardLimitMinor != null
            ? { hardLimitMinor: Number(balance.hardLimitMinor) }
            : {}),
        },
      }
      : {}),
  });
}

function listEmployees(context: ForgeDaemonContext, companyId: string) {
  context.company.companies.get(companyId);
  return context.store.db.prepare(
    `SELECT employee.id, employee.company_id AS companyId,
      employee.display_name AS displayName, employee.version,
      employment.position_id AS positionId, employment.status,
      employment.autonomy_level AS autonomyLevel
    FROM company_employees AS employee
    JOIN company_employments AS employment
      ON employment.company_id = employee.company_id
      AND employment.employee_id = employee.id
    WHERE employee.company_id = ?
    ORDER BY employee.created_at, employee.id`,
  ).all(companyId);
}

function listGoals(context: ForgeDaemonContext, companyId: string) {
  context.company.companies.get(companyId);
  return context.store.db.prepare(
    `SELECT id, company_id AS companyId, title, owner_id AS ownerId, version
    FROM company_goals WHERE company_id = ? ORDER BY created_at, id`,
  ).all(companyId) as Array<{ id: string; title: string }>;
}

function listProjects(context: ForgeDaemonContext, companyId: string) {
  context.company.companies.get(companyId);
  return context.store.db.prepare(
    `SELECT id, company_id AS companyId, goal_id AS goalId, title, version, state
    FROM company_projects WHERE company_id = ? ORDER BY created_at, id`,
  ).all(companyId) as Array<{ id: string }>;
}

function listWorkItems(context: ForgeDaemonContext, companyId: string) {
  context.company.companies.get(companyId);
  const items = context.store.db.prepare(
    `${workItemSelect()} WHERE company_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC`,
  ).all(companyId) as WorkItemRow[];
  return items.map((item) => enrichWorkItem(context, item));
}

function getWorkItem(context: Pick<ForgeDaemonContext, "store">, workItemId: string) {
  const item = context.store.db.prepare(
    `${workItemSelect()} WHERE id = ?`,
  ).get(workItemId) as WorkItemRow | undefined;
  if (!item) throw new Error("work item not found");
  return enrichWorkItem(context, item);
}

function workItemSelect(): string {
  return `SELECT id, company_id AS companyId, goal_id AS goalId,
    project_id AS projectId, parent_id AS parentId, type, title, problem,
    expected_outcome AS expectedOutcome, owner_id AS ownerId,
    assignee_id AS assigneeId, state, risk,
    autonomy_level AS autonomyLevel, version,
    created_at AS createdAt, updated_at AS updatedAt
  FROM company_work_items`;
}

type WorkItemRow = {
  type?: string;
  id: string;
  companyId: string;
  goalId?: string | null;
  projectId?: string | null;
  title: string;
  problem: string;
  expectedOutcome: string;
  ownerId: string;
  assigneeId: string | null;
  state: string;
  runIds?: string[];
};

type CurrentGate =
  | "缺 spec"
  | "缺 plan"
  | "执行中"
  | "待验收"
  | "已完成"
  | "已驳回待修"
  | "执行失败待修"
  | "等待输入";

function enrichWorkItem(context: Pick<ForgeDaemonContext, "store">, item: WorkItemRow) {
  const trace = buildDeliveryTrace(context.store.db, item.id);
  const { specVersion, planVersion, runIds } = trace;
  const specDraft = latestArtifactContent(context, item.id, "spec");
  const planDraft = latestArtifactContent(context, item.id, "plan");
  const openFix = findOpenFixChild(context, item.id);
  const researchBriefId = item.type === "research"
    ? latestReadyBriefId(context, item.companyId, item.id)
    : undefined;

  return {
    ...item,
    ...(researchBriefId ? { researchBriefId } : {}),
    ...(specVersion === undefined ? {} : { specVersion }),
    ...(planVersion === undefined ? {} : { planVersion }),
    ...(specDraft === undefined ? {} : { specDraft }),
    ...(planDraft === undefined ? {} : { planDraft }),
    ...(openFix ? { openFix } : {}),
    currentGate: currentGate(context, { ...item, specVersion, planVersion }, trace),
    runIds,
    trace,
  };
}

/** Latest ready research brief for a work item; lets the UI start a feasibility workflow. */
function latestReadyBriefId(
  context: Pick<ForgeDaemonContext, "store">,
  companyId: string,
  workItemId: string,
): string | undefined {
  const row = context.store.db
    .prepare(
      `SELECT id FROM company_research_briefs
        WHERE company_id = ? AND work_item_id = ? AND ready = 1
        ORDER BY version DESC LIMIT 1`,
    )
    .get(companyId, workItemId) as { id: string } | undefined;
  return row?.id;
}

function latestArtifactContent(
  context: Pick<ForgeDaemonContext, "store">,
  workItemId: string,
  kind: "spec" | "plan",
): string | undefined {
  const row = context.store.db
    .prepare(
      `SELECT content
      FROM company_work_artifacts
      WHERE work_item_id = ? AND kind = ?
      ORDER BY CASE status WHEN 'draft' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
        version DESC
      LIMIT 1`,
    )
    .get(workItemId, kind) as { content: string } | undefined;
  return row?.content;
}

function currentGate(
  context: Pick<ForgeDaemonContext, "store">,
  item: WorkItemRow & { specVersion?: number; planVersion?: number },
  trace?: { runs?: Array<{ state?: string }> },
): CurrentGate {
  if (item.state === "accepted" || item.state === "completed") return "已完成";
  if (item.state === "blocked") {
    const rejected = context.store.db.prepare(
      `SELECT 1 AS ok FROM company_decisions
      WHERE work_item_id = ? AND decision = 'rejected' LIMIT 1`,
    ).get(item.id) as { ok: number } | undefined;
    return rejected ? "已驳回待修" : "执行失败待修";
  }
  if (item.specVersion === undefined) return "缺 spec";
  if (item.planVersion === undefined) return "缺 plan";
  if (["submitted", "waiting_approval", "verifying"].includes(item.state)) {
    return "待验收";
  }
  const latestRun = trace?.runs?.[trace.runs.length - 1];
  if (item.state === "waiting_input" || latestRun?.state === "waiting") {
    return "等待输入";
  }
  return "执行中";
}

function findOpenFixChild(
  context: Pick<ForgeDaemonContext, "store">,
  parentId: string,
): { id: string; title: string } | undefined {
  return context.store.db.prepare(
    `SELECT id, title FROM company_work_items
    WHERE parent_id = ? AND type = 'fix'
      AND state NOT IN ('completed', 'cancelled', 'accepted')
    ORDER BY created_at DESC, id DESC
    LIMIT 1`,
  ).get(parentId) as { id: string; title: string } | undefined;
}

function recordParams(params: unknown): Params {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    invalidRequest("params must be an object");
  }
  return params as Params;
}

function stringParam(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") {
    invalidRequest(`${name} must be a non-empty string`);
  }
  return value;
}

/** Constraints may arrive as a string array or a comma/newline separated string from the UI. */
function constraintsParam(params: Params): string[] {
  const value = params.constraints;
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，;；\n]/)
      : invalidRequest("constraints must be an array of strings or a string");
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") invalidRequest("constraints must contain only strings");
    const trimmed = entry.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Creates a work item; research items also persist a ready research brief
 * (atomically) so the feasibility workflow can start from `researchBriefId`.
 */
function createWorkItemWithBrief(context: ForgeDaemonContext, params: Params) {
  const type = workItemTypeParam(params);
  const input = {
    companyId: companyIdParam(params),
    goalId: optionalStringParam(params, "goalId"),
    projectId: optionalStringParam(params, "projectId"),
    type,
    title: stringParam(params, "title"),
    problem: stringParam(params, "problem"),
    expectedOutcome: stringParam(params, "expectedOutcome"),
    ownerId: stringParam(params, "ownerId"),
  };
  if (type !== "research") return context.company.work.createWorkItem(input);

  const targetUser = params.targetUser;
  if (typeof targetUser !== "string" || targetUser.trim() === "") {
    invalidRequest("targetUser is required for research work items");
  }
  const constraints = constraintsParam(params);
  const db = context.store.db;
  return db.transaction(() => {
    const item = context.company.work.createWorkItem(input);
    const brief = acceptBrief(db, { now: () => new Date().toISOString() }, {
      companyId: item.companyId,
      workItemId: item.id,
      problem: input.problem,
      targetUser: targetUser as string,
      expectedOutcome: input.expectedOutcome,
      constraints,
    });
    if (!brief.ready) {
      invalidRequest("research brief is not ready: check problem, target user, expected outcome and constraints");
    }
    return item;
  })();
}

function optionalStringParam(params: Params, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    invalidRequest(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalReasonParam(params: Params): string | null {
  const value = params.reason;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    invalidRequest("reason must be a string");
  }
  return value;
}

function companyIdParam(params: Params): string {
  const value = params.companyId ?? params.id;
  if (typeof value !== "string" || value.trim() === "") {
    invalidRequest("companyId must be a non-empty string");
  }
  return value;
}

function autonomyParam(params: Params): 0 | 1 | 2 | 3 | 4 {
  const value = params.autonomyLevel;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 4) {
    invalidRequest("autonomyLevel must be an integer from 0 to 4");
  }
  return value as 0 | 1 | 2 | 3 | 4;
}

function workItemTypeParam(params: Params) {
  const value = stringParam(params, "type");
  if (!["intent", "implementation", "fix", "research"].includes(value)) {
    invalidRequest("invalid work item type");
  }
  return value as "intent" | "implementation" | "fix" | "research";
}

function artifactKindParam(params: Params) {
  const value = stringParam(params, "kind");
  if (value !== "spec" && value !== "plan") {
    invalidRequest("kind must be spec or plan");
  }
  return value;
}

function stageGateDecisionParam(params: Params): DecideStageGateInput {
  return {
    id: stringParam(params, "id"),
    companyId: companyIdParam(params),
    projectId: optionalStringParam(params, "projectId"),
    gate: stageGateKindParam(params),
    outcome: stageGateOutcomeParam(params),
    inputVersionRefs: stringArrayParam(params, "inputVersionRefs"),
    decidedBy: stageGateDeciderParam(params),
    rationale: stringParam(params, "rationale"),
    impact: stringValueParam(params, "impact"),
    decidedAt: new Date().toISOString(),
  };
}

function stageGateKindParam(params: Params): StageGateKind {
  const value = stringParam(params, "gate");
  if (!["research", "scope", "technical", "release"].includes(value)) {
    invalidRequest("invalid stage gate");
  }
  return value as StageGateKind;
}

function stageGateOutcomeParam(
  params: Params,
): DecideStageGateInput["outcome"] {
  const value = stringParam(params, "outcome");
  if (!["approved", "rejected", "changes_requested", "stopped"].includes(value)) {
    invalidRequest("invalid stage gate outcome");
  }
  return value as DecideStageGateInput["outcome"];
}

function stageGateDeciderParam(
  params: Params,
): DecideStageGateInput["decidedBy"] {
  const value = params.decidedBy;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidRequest("decidedBy must be an object");
  }
  const decider = value as Params;
  return {
    kind: stringParam(decider, "kind"),
    id: stringParam(decider, "id"),
  };
}

function stringArrayParam(params: Params, name: string): string[] {
  const value = params[name];
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    invalidRequest(`${name} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function stringValueParam(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== "string") {
    invalidRequest(`${name} must be a string`);
  }
  return value;
}

function approvalDecisionParam(params: Params): "approved" | "rejected" {
  const value = stringParam(params, "decision");
  if (value !== "approved" && value !== "rejected") {
    invalidRequest("decision must be approved or rejected");
  }
  return value;
}

function readCompanyWorkspaceText(cwd: string, relativePath: string): string | null {
  try {
    const root = realpathSync(cwd);
    const absolute = resolve(root, relativePath);
    if (!existsSync(absolute)) return null;
    const real = realpathSync(absolute);
    if (real !== root && !real.startsWith(root + sep)) return null;
    const stat = statSync(real);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    const buf = readFileSync(real);
    if (buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function invalidRequest(message: string): never {
  throw new RpcFaultError(rpcFault("INVALID_REQUEST", message));
}

function assignmentsParam(params: Params): Record<string, string> | undefined {
  const value = params.assignments;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new RpcFaultError(rpcFault("INVALID_REQUEST", "assignments must map step ids to employee ids"));
  }
  return value as Record<string, string>;
}

function companyRpcError(error: unknown): RpcFaultError {
  if (error instanceof RpcFaultError) return error;
  if (error instanceof CompanyWorkflowStartError) {
    const code = error.code === "WORKFLOW_NOT_RUNNABLE" ? "POLICY_DENIED" : error.code;
    return new RpcFaultError(rpcFault(code, error.message));
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "spec not accepted"
    || message === "plan not accepted"
    || message === "executor cannot approve own work"
    || message === "work item is not a submission"
    || message === "position already occupied"
    || message === "employee can have at most one default workspace"
    || message === "work item has no assignee"
    || message === "assignee has no default write workspace"
    || message === "work item already has an active run"
    || message === "gate inputs changed"
  ) {
    return new RpcFaultError(rpcFault("POLICY_DENIED", message));
  }
  if (
    message.endsWith("not found")
    || message.startsWith("artifact not ")
    || message.includes("constraint failed")
  ) {
    return new RpcFaultError(rpcFault("INVALID_REQUEST", message));
  }
  return new RpcFaultError(rpcFault("INTERNAL_ERROR", message));
}
