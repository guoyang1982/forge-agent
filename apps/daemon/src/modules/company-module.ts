import { newCompanyId } from "@forge/company-domain";
import { DAEMON_COMPANY_METHODS, rpcFault } from "@forge/protocol";
import { RpcFaultError } from "../host/router.js";
import type { DaemonModule } from "../host/types.js";
import type { ForgeDaemonContext } from "./context.js";

type Params = Record<string, unknown>;

export function createCompanyModule(): DaemonModule<ForgeDaemonContext> {
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

      register(DAEMON_COMPANY_METHODS.CREATE, (params) =>
        context.company.companies.create({ name: stringParam(params, "name") }));
      register(DAEMON_COMPANY_METHODS.GET, (params) =>
        context.company.companies.get(companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.ORGANIZATION_TREE, (params) =>
        context.company.org.tree(companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.EMPLOYEES_HIRE, (params) =>
        context.company.org.hire({
          companyId: companyIdParam(params),
          displayName: stringParam(params, "displayName"),
          positionId: stringParam(params, "positionId"),
          managerEmployeeId: optionalStringParam(params, "managerEmployeeId"),
          autonomyLevel: autonomyParam(params),
        }));
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
      register(DAEMON_COMPANY_METHODS.WORK_ITEMS_CREATE, (params) =>
        context.company.work.createWorkItem({
          companyId: companyIdParam(params),
          projectId: optionalStringParam(params, "projectId"),
          type: workItemTypeParam(params),
          title: stringParam(params, "title"),
          problem: stringParam(params, "problem"),
          expectedOutcome: stringParam(params, "expectedOutcome"),
          ownerId: stringParam(params, "ownerId"),
        }));
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
      register(DAEMON_COMPANY_METHODS.WORK_ITEMS_DISPATCH, (params) =>
        context.company.work.dispatch({
          workItemId: stringParam(params, "workItemId"),
          assigneeId: stringParam(params, "assigneeId"),
          actorId: stringParam(params, "actorId"),
        }));
      register(DAEMON_COMPANY_METHODS.WORK_ITEMS_PAUSE_FOR_FIX, (params) =>
        context.company.work.pauseForFix({
          workItemId: stringParam(params, "workItemId"),
          reason: stringParam(params, "reason"),
          ownerId: stringParam(params, "ownerId"),
        }));

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
      register(DAEMON_COMPANY_METHODS.DASHBOARD_GET, (params) =>
        dashboard(context, companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.WORK_ITEMS_REQUEST_RUN, (params) =>
        requestRun(context, stringParam(params, "workItemId")));
      register(DAEMON_COMPANY_METHODS.APPROVALS_LIST, (params) =>
        listApprovals(context, companyIdParam(params)));
      register(DAEMON_COMPANY_METHODS.APPROVALS_DECIDE, (params) =>
        decideApproval(context, params));
    },
  };
}

function requestRun(context: ForgeDaemonContext, workItemId: string) {
  const plan = context.company.gates.assertImplementationRunAllowed(workItemId);
  context.store.db.prepare(
    `INSERT INTO company_run_links
      (id, company_id, work_item_id, run_id, plan_artifact_id, created_at)
    VALUES (?, ?, ?, '', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run(newCompanyId("run_link"), plan.companyId, workItemId, plan.id);
  return { workItemId, planArtifactId: plan.id };
}

function decideApproval(context: ForgeDaemonContext, params: Params) {
  const workItemId = stringParam(params, "workItemId");
  const actorId = stringParam(params, "actorId");
  const decision = stringParam(params, "decision");
  const item = getWorkItem(context, workItemId);
  if (item.assigneeId === actorId) {
    throw new Error("executor cannot approve own work");
  }
  const result = {
    id: newCompanyId("decision"),
    companyId: item.companyId,
    workItemId,
    employeeId: actorId,
    decision,
    version: 1,
  };
  context.store.db.prepare(
    `INSERT INTO company_decisions
      (id, company_id, work_item_id, employee_id, decision, version, created_at, updated_at)
    VALUES
      (@id, @companyId, @workItemId, @employeeId, @decision, @version,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run(result);
  return result;
}

function listApprovals(context: ForgeDaemonContext, companyId: string) {
  const pending = context.store.db.prepare(
    `${workItemSelect()}
    WHERE company_id = ? AND state = 'waiting_approval'
    ORDER BY updated_at DESC LIMIT 20`,
  ).all(companyId);
  const decisions = context.store.db.prepare(
    `SELECT id, company_id AS companyId, work_item_id AS workItemId,
      employee_id AS employeeId, decision, version, created_at AS createdAt
    FROM company_decisions
    WHERE company_id = ?
    ORDER BY created_at DESC LIMIT 20`,
  ).all(companyId);
  return { pending, decisions };
}

function dashboard(context: ForgeDaemonContext, companyId: string) {
  context.company.companies.get(companyId);
  const count = (table: string) =>
    (context.store.db.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE company_id = ?`,
    ).get(companyId) as { count: number }).count;
  return {
    companyId,
    employees: count("company_employees"),
    goals: count("company_goals"),
    projects: count("company_projects"),
    workItems: count("company_work_items"),
  };
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
  ).all(companyId);
}

function listProjects(context: ForgeDaemonContext, companyId: string) {
  context.company.companies.get(companyId);
  return context.store.db.prepare(
    `SELECT id, company_id AS companyId, goal_id AS goalId, title, version
    FROM company_projects WHERE company_id = ? ORDER BY created_at, id`,
  ).all(companyId);
}

function listWorkItems(context: ForgeDaemonContext, companyId: string) {
  context.company.companies.get(companyId);
  return context.store.db.prepare(
    `${workItemSelect()} WHERE company_id = ? ORDER BY created_at, id`,
  ).all(companyId);
}

function getWorkItem(context: ForgeDaemonContext, workItemId: string) {
  const item = context.store.db.prepare(
    `${workItemSelect()} WHERE id = ?`,
  ).get(workItemId);
  if (!item) throw new Error("work item not found");
  return item as {
    id: string;
    companyId: string;
    assigneeId: string | null;
  } & Record<string, unknown>;
}

function workItemSelect(): string {
  return `SELECT id, company_id AS companyId, goal_id AS goalId,
    project_id AS projectId, parent_id AS parentId, type, title, problem,
    expected_outcome AS expectedOutcome, owner_id AS ownerId,
    assignee_id AS assigneeId, state, risk,
    autonomy_level AS autonomyLevel, version
  FROM company_work_items`;
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

function optionalStringParam(params: Params, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    invalidRequest(`${name} must be a non-empty string`);
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

function invalidRequest(message: string): never {
  throw new RpcFaultError(rpcFault("INVALID_REQUEST", message));
}

function companyRpcError(error: unknown): RpcFaultError {
  if (error instanceof RpcFaultError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "spec not accepted"
    || message === "plan not accepted"
    || message === "executor cannot approve own work"
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
