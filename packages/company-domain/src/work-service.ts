import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  persistWorkArtifactFile,
  type CompanyArtifactOptions,
} from "./artifact-files.js";
import type { Clock } from "./clock.js";
import { newCompanyId } from "./ids.js";
import { WorkGates } from "./work-gates.js";

export type Goal = {
  id: string;
  companyId: string;
  title: string;
  ownerId: string;
  version: number;
};

export type Project = {
  id: string;
  companyId: string;
  goalId: string;
  title: string;
  version: number;
};

export type WorkItemType = "intent" | "implementation" | "fix" | "research";

export type WorkItemState =
  | "draft"
  | "ready"
  | "in_progress"
  | "waiting_input"
  | "waiting_approval"
  | "blocked"
  | "submitted"
  | "verifying"
  | "accepted"
  | "rejected"
  | "completed"
  | "cancelled";

export type WorkItem = {
  id: string;
  companyId: string;
  goalId: string | null;
  projectId: string | null;
  parentId: string | null;
  type: WorkItemType;
  title: string;
  problem: string;
  expectedOutcome: string;
  ownerId: string;
  assigneeId: string | null;
  state: WorkItemState;
  risk: "low";
  autonomyLevel: 2;
  version: number;
};

export type WorkArtifact = {
  id: string;
  companyId: string;
  workItemId: string;
  kind: "intent" | "spec" | "plan";
  version: number;
  status: "draft" | "accepted" | "superseded";
  content: string;
  contentHash: string;
  workspacePath: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
};

export class WorkService {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly artifactOptions?: CompanyArtifactOptions,
  ) {}

  createGoal(input: {
    companyId: string;
    title: string;
    ownerId: string;
  }): Goal {
    const goal: Goal = {
      id: newCompanyId("goal"),
      companyId: input.companyId,
      title: input.title,
      ownerId: input.ownerId,
      version: 1,
    };
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO company_goals
          (id, company_id, title, owner_id, version, created_at, updated_at)
        VALUES
          (@id, @companyId, @title, @ownerId, @version, @createdAt, @updatedAt)`,
      )
      .run({ ...goal, createdAt: now, updatedAt: now });
    return goal;
  }

  createProject(input: {
    companyId: string;
    goalId: string;
    title: string;
  }): Project {
    const project: Project = {
      id: newCompanyId("project"),
      companyId: input.companyId,
      goalId: input.goalId,
      title: input.title,
      version: 1,
    };
    const now = this.clock.now();
    this.db
      .prepare(
        `INSERT INTO company_projects
          (id, company_id, goal_id, title, version, created_at, updated_at)
        VALUES
          (@id, @companyId, @goalId, @title, @version, @createdAt, @updatedAt)`,
      )
      .run({ ...project, createdAt: now, updatedAt: now });
    return project;
  }

  createWorkItem(input: {
    companyId: string;
    projectId?: string;
    type: WorkItemType;
    title: string;
    problem: string;
    expectedOutcome: string;
    ownerId: string;
  }): WorkItem {
    const item: WorkItem = {
      id: newCompanyId("work"),
      companyId: input.companyId,
      goalId: null,
      projectId: input.projectId ?? null,
      parentId: null,
      type: input.type,
      title: input.title,
      problem: input.problem,
      expectedOutcome: input.expectedOutcome,
      ownerId: input.ownerId,
      assigneeId: null,
      state: "draft",
      risk: "low",
      autonomyLevel: 2,
      version: 1,
    };
    const artifact: WorkArtifact = {
      id: newCompanyId("artifact"),
      companyId: input.companyId,
      workItemId: item.id,
      kind: "intent",
      version: 1,
      status: "draft",
      content: input.problem,
      contentHash: createHash("sha256")
        .update(input.problem, "utf8")
        .digest("hex"),
      workspacePath: null,
      acceptedAt: null,
      acceptedBy: null,
    };
    const now = this.clock.now();

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO company_work_items
            (id, company_id, goal_id, project_id, parent_id, type, title,
              problem, expected_outcome, owner_id, assignee_id, state, risk,
              autonomy_level, version, created_at, updated_at)
          VALUES
            (@id, @companyId, @goalId, @projectId, @parentId, @type, @title,
              @problem, @expectedOutcome, @ownerId, @assigneeId, @state, @risk,
              @autonomyLevel, @version, @createdAt, @updatedAt)`,
        )
        .run({ ...item, createdAt: now, updatedAt: now });
      this.db
        .prepare(
          `INSERT INTO company_work_artifacts
            (id, company_id, work_item_id, kind, version, status, content,
              content_hash, workspace_path, accepted_at, accepted_by,
              created_at, updated_at)
          VALUES
            (@id, @companyId, @workItemId, @kind, @version, @status, @content,
              @contentHash, @workspacePath, @acceptedAt, @acceptedBy,
              @createdAt, @updatedAt)`,
        )
        .run({ ...artifact, createdAt: now, updatedAt: now });
    })();
    persistWorkArtifactFile(this.artifactOptions, artifact, this.db);

    return item;
  }

  listArtifacts(workItemId: string): WorkArtifact[] {
    return this.db
      .prepare(
        `SELECT id, company_id AS companyId, work_item_id AS workItemId,
          kind, version, status, content, content_hash AS contentHash,
          workspace_path AS workspacePath, accepted_at AS acceptedAt,
          accepted_by AS acceptedBy
        FROM company_work_artifacts
        WHERE work_item_id = ?
        ORDER BY created_at, id`,
      )
      .all(workItemId) as WorkArtifact[];
  }

  dispatch(input: {
    workItemId: string;
    assigneeId: string;
    actorId: string;
  }): WorkItem {
    return new WorkGates(
      this.db,
      this.clock,
      this.artifactOptions,
    ).dispatch(input);
  }

  pauseForFix(input: {
    workItemId: string;
    reason: string;
    ownerId: string;
  }): WorkItem {
    return new WorkGates(
      this.db,
      this.clock,
      this.artifactOptions,
    ).pauseForFix(input);
  }
}
