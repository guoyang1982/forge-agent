import type Database from "better-sqlite3";
import type { Clock } from "../clock.js";
import { bindProjectWorkspaceGroup } from "../project-workspaces.js";
import { WorkService, type WorkItemType } from "../work-service.js";

export type DeliveryResponsibility =
  | "product"
  | "architecture"
  | "research"
  | "implementation"
  | "validation";

export interface DeliveryAssignmentInput {
  employeeId: string;
  responsibility: DeliveryResponsibility;
  workspaceBindingId?: string;
}

export interface ApprovedDeliveryScope {
  title: string;
  problem: string;
  expectedOutcome: string;
}

export interface CreateDeliveryProjectInput {
  companyId: string;
  projectId: string;
  approvedScope: ApprovedDeliveryScope;
  assignments: DeliveryAssignmentInput[];
  groupId?: string;
  milestones?: string[];
}

export interface DeliveryAssignment {
  employeeId: string;
  responsibility: DeliveryResponsibility;
  workItemId: string;
  workspaceBindingId?: string;
  accessMode: "read" | "write";
}

export interface DeliveryProject {
  companyId: string;
  projectId: string;
  assignments: DeliveryAssignment[];
  groupId?: string;
  milestones: string[];
}

export function createDeliveryProject(
  db: Database.Database,
  clock: Clock,
  input: CreateDeliveryProjectInput,
): DeliveryProject {
  requireProject(db, input.companyId, input.projectId);
  validateRoleCoverage(input.assignments);
  validateIndependentValidation(input.assignments);
  validateWorkspaceBindings(input.assignments);
  validateEmployees(db, input.companyId, input.assignments);

  return db.transaction(() => {
    const work = new WorkService(db, clock);
    const assignments = input.assignments.map((assignment) => {
      const workspaceBindingId = normalizeOptional(
        assignment.workspaceBindingId,
      );
      const workItem = work.createWorkItem({
        companyId: input.companyId,
        projectId: input.projectId,
        type: workItemType(assignment.responsibility),
        title: `${input.approvedScope.title}: ${assignment.responsibility}`,
        problem: input.approvedScope.problem,
        expectedOutcome: input.approvedScope.expectedOutcome,
        ownerId: assignment.employeeId,
      });
      return {
        employeeId: assignment.employeeId,
        responsibility: assignment.responsibility,
        workItemId: workItem.id,
        ...(workspaceBindingId ? { workspaceBindingId } : {}),
        accessMode:
          assignment.responsibility === "implementation"
            ? ("write" as const)
            : ("read" as const),
      };
    });

    if (input.groupId) {
      bindProjectWorkspaceGroup(db, {
        companyId: input.companyId,
        projectId: input.projectId,
        groupId: input.groupId,
        createdAt: clock.now(),
      });
    }

    return {
      companyId: input.companyId,
      projectId: input.projectId,
      assignments,
      ...(input.groupId ? { groupId: input.groupId } : {}),
      milestones: [...(input.milestones ?? [])],
    };
  })();
}

function validateRoleCoverage(
  assignments: DeliveryAssignmentInput[],
): void {
  for (const responsibility of [
    "product",
    "architecture",
    "implementation",
  ] as const) {
    if (
      !assignments.some(
        (assignment) => assignment.responsibility === responsibility,
      )
    ) {
      throw new Error(`${responsibility} owner required`);
    }
  }
  if (
    !assignments.some(
      (assignment) => assignment.responsibility === "validation",
    )
  ) {
    throw new Error("independent validation owner required");
  }
}

function validateIndependentValidation(
  assignments: DeliveryAssignmentInput[],
): void {
  const implementationOwners = new Set(
    assignments
      .filter(
        (assignment) => assignment.responsibility === "implementation",
      )
      .map((assignment) => assignment.employeeId),
  );
  if (
    assignments.some(
      (assignment) =>
        assignment.responsibility === "validation" &&
        implementationOwners.has(assignment.employeeId),
    )
  ) {
    throw new Error("independent validation owner required");
  }
}

function validateWorkspaceBindings(
  assignments: DeliveryAssignmentInput[],
): void {
  const implementationBindings = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.responsibility !== "implementation") {
      continue;
    }
    const bindingId = normalizeOptional(assignment.workspaceBindingId);
    if (!bindingId) {
      throw new Error("implementation workspace binding required");
    }
    if (implementationBindings.has(bindingId)) {
      throw new Error("implementation workspace binding conflict");
    }
    implementationBindings.add(bindingId);
  }
}

function validateEmployees(
  db: Database.Database,
  companyId: string,
  assignments: DeliveryAssignmentInput[],
): void {
  const employeeExists = db.prepare(
    `SELECT 1 FROM company_employees WHERE company_id = ? AND id = ?`,
  );
  for (const assignment of assignments) {
    if (!employeeExists.get(companyId, assignment.employeeId)) {
      throw new Error(
        `employee does not belong to company: ${assignment.employeeId}`,
      );
    }
  }
}

function requireProject(
  db: Database.Database,
  companyId: string,
  projectId: string,
): void {
  const project = db
    .prepare(
      `SELECT 1 FROM company_projects WHERE company_id = ? AND id = ?`,
    )
    .get(companyId, projectId);
  if (!project) {
    throw new Error("project not found");
  }
}

function workItemType(
  responsibility: DeliveryResponsibility,
): WorkItemType {
  if (responsibility === "implementation") {
    return "implementation";
  }
  if (responsibility === "research") {
    return "research";
  }
  return "intent";
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
