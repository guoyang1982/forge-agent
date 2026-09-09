import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  persistWorkArtifactFile,
  type CompanyArtifactOptions,
} from "./artifact-files.js";
import type { Clock } from "./clock.js";
import { newCompanyId } from "./ids.js";
import type {
  WorkArtifact,
  WorkItem,
  WorkItemType,
} from "./work-service.js";

type DraftKind = "spec" | "plan";

export class WorkGates {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly artifactOptions?: CompanyArtifactOptions,
  ) {}

  upsertDraft(input: {
    workItemId: string;
    kind: DraftKind;
    content: string;
    actorId: string;
  }): WorkArtifact {
    const artifact = this.db.transaction(() => {
      const item = this.getWorkItem(input.workItemId);
      const now = this.clock.now();
      const contentHash = createHash("sha256")
        .update(input.content, "utf8")
        .digest("hex");
      const liveDraft = this.db
        .prepare(
          `SELECT id
          FROM company_work_artifacts
          WHERE work_item_id = ? AND kind = ? AND status = 'draft'
          ORDER BY version DESC
          LIMIT 1`,
        )
        .get(input.workItemId, input.kind) as { id: string } | undefined;

      if (liveDraft) {
        this.db
          .prepare(
            `UPDATE company_work_artifacts
            SET content = ?, content_hash = ?, updated_at = ?
            WHERE id = ?`,
          )
          .run(input.content, contentHash, now, liveDraft.id);
        return this.getArtifact(liveDraft.id);
      }

      const next = this.db
        .prepare(
          `SELECT COALESCE(MAX(version), 0) + 1 AS version
          FROM company_work_artifacts
          WHERE work_item_id = ? AND kind = ?`,
        )
        .get(input.workItemId, input.kind) as { version: number };
      const artifact: WorkArtifact = {
        id: newCompanyId("artifact"),
        companyId: item.companyId,
        workItemId: item.id,
        kind: input.kind,
        version: next.version,
        status: "draft",
        content: input.content,
        contentHash,
        workspacePath: null,
        acceptedAt: null,
        acceptedBy: null,
      };

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
      return artifact;
    })();
    const workspacePath = persistWorkArtifactFile(
      this.artifactOptions,
      artifact,
      this.db,
    );
    return workspacePath ? { ...artifact, workspacePath } : artifact;
  }

  acceptArtifact(input: {
    artifactId: string;
    actorId: string;
  }): WorkArtifact {
    const artifact = this.db.transaction(() => {
      const artifact = this.getArtifact(input.artifactId);
      if (artifact.status !== "draft") {
        throw new Error("artifact not draft");
      }
      const current = this.db
        .prepare(
          `SELECT id
          FROM company_work_artifacts
          WHERE work_item_id = ? AND kind = ?
          ORDER BY version DESC
          LIMIT 1`,
        )
        .get(artifact.workItemId, artifact.kind) as { id: string };
      if (current.id !== artifact.id) {
        throw new Error("artifact not current draft");
      }
      const now = this.clock.now();

      this.db
        .prepare(
          `UPDATE company_work_artifacts
          SET status = 'superseded', updated_at = ?
          WHERE work_item_id = ? AND kind = ? AND status = 'accepted'`,
        )
        .run(now, artifact.workItemId, artifact.kind);
      this.db
        .prepare(
          `UPDATE company_work_artifacts
          SET status = 'accepted', accepted_at = ?, accepted_by = ?,
            updated_at = ?
          WHERE id = ?`,
        )
        .run(now, input.actorId, now, artifact.id);

      return this.getArtifact(artifact.id);
    })();
    const workspacePath = persistWorkArtifactFile(
      this.artifactOptions,
      artifact,
      this.db,
    );
    return workspacePath ? { ...artifact, workspacePath } : artifact;
  }

  dispatch(input: {
    workItemId: string;
    assigneeId: string;
    actorId: string;
  }): WorkItem {
    return this.db.transaction(() => {
      this.requireAccepted(input.workItemId, "spec", "spec not accepted");
      this.db
        .prepare(
          `UPDATE company_work_items
          SET assignee_id = ?, state = 'ready', updated_at = ?
          WHERE id = ?`,
        )
        .run(input.assigneeId, this.clock.now(), input.workItemId);
      return this.getWorkItem(input.workItemId);
    })();
  }

  assertImplementationRunAllowed(workItemId: string): WorkArtifact {
    return this.requireAccepted(workItemId, "plan", "plan not accepted");
  }

  linkRun(input: {
    workItemId: string;
    runId: string;
    planArtifactId: string;
  }): void {
    this.db.transaction(() => {
      const item = this.getWorkItem(input.workItemId);
      const placeholder = this.db
        .prepare(
          `SELECT id
          FROM company_run_links
          WHERE work_item_id = ? AND plan_artifact_id = ? AND run_id = ''
          ORDER BY created_at, id
          LIMIT 1`,
        )
        .get(input.workItemId, input.planArtifactId) as
        | { id: string }
        | undefined;

      if (placeholder) {
        this.db
          .prepare("UPDATE company_run_links SET run_id = ? WHERE id = ?")
          .run(input.runId, placeholder.id);
      } else {
        this.db
          .prepare(
            `INSERT INTO company_run_links
              (id, company_id, work_item_id, run_id, plan_artifact_id, created_at)
            VALUES
              (@id, @companyId, @workItemId, @runId, @planArtifactId, @createdAt)`,
          )
          .run({
            id: newCompanyId("run_link"),
            companyId: item.companyId,
            workItemId: input.workItemId,
            runId: input.runId,
            planArtifactId: input.planArtifactId,
            createdAt: this.clock.now(),
          });
      }

      if (input.runId.trim() !== "") {
        this.db
          .prepare(
            `UPDATE company_work_items
            SET state = 'waiting_approval', updated_at = ?
            WHERE id = ?`,
          )
          .run(this.clock.now(), input.workItemId);
      }
    })();
  }

  pauseForFix(input: {
    workItemId: string;
    reason: string;
    ownerId: string;
  }): WorkItem {
    const result = this.db.transaction(() => {
      const parent = this.getWorkItem(input.workItemId);
      const now = this.clock.now();
      this.db
        .prepare(
          `UPDATE company_work_items
          SET state = 'blocked', updated_at = ?
          WHERE id = ?`,
        )
        .run(now, parent.id);

      return this.insertWorkItemWithIntent({
        companyId: parent.companyId,
        projectId: parent.projectId,
        parentId: parent.id,
        type: "fix",
        title: `Fix: ${parent.title}`,
        problem: input.reason,
        expectedOutcome: input.reason,
        ownerId: input.ownerId,
        now,
      });
    })();
    persistWorkArtifactFile(this.artifactOptions, result.artifact, this.db);
    return result.item;
  }

  getArtifact(id: string): WorkArtifact {
    const artifact = this.db
      .prepare(
        `SELECT id, company_id AS companyId, work_item_id AS workItemId,
          kind, version, status, content, content_hash AS contentHash,
          workspace_path AS workspacePath, accepted_at AS acceptedAt,
          accepted_by AS acceptedBy
        FROM company_work_artifacts
        WHERE id = ?`,
      )
      .get(id) as WorkArtifact | undefined;
    if (!artifact) {
      throw new Error("artifact not found");
    }
    return artifact;
  }

  private requireAccepted(
    workItemId: string,
    kind: DraftKind,
    message: string,
  ): WorkArtifact {
    const artifact = this.db
      .prepare(
        `SELECT id, company_id AS companyId, work_item_id AS workItemId,
          kind, version, status, content, content_hash AS contentHash,
          workspace_path AS workspacePath, accepted_at AS acceptedAt,
          accepted_by AS acceptedBy
        FROM company_work_artifacts
        WHERE work_item_id = ? AND kind = ? AND status = 'accepted'
        ORDER BY version DESC
        LIMIT 1`,
      )
      .get(workItemId, kind) as WorkArtifact | undefined;
    if (!artifact) {
      throw new Error(message);
    }
    return artifact;
  }

  private getWorkItem(id: string): WorkItem {
    const item = this.db
      .prepare(
        `SELECT id, company_id AS companyId, goal_id AS goalId,
          project_id AS projectId, parent_id AS parentId, type, title, problem,
          expected_outcome AS expectedOutcome, owner_id AS ownerId,
          assignee_id AS assigneeId, state, risk,
          autonomy_level AS autonomyLevel, version
        FROM company_work_items
        WHERE id = ?`,
      )
      .get(id) as WorkItem | undefined;
    if (!item) {
      throw new Error("work item not found");
    }
    return item;
  }

  private insertWorkItemWithIntent(input: {
    companyId: string;
    projectId: string | null;
    parentId: string;
    type: WorkItemType;
    title: string;
    problem: string;
    expectedOutcome: string;
    ownerId: string;
    now: string;
  }): { item: WorkItem; artifact: WorkArtifact } {
    const item: WorkItem = {
      id: newCompanyId("work"),
      companyId: input.companyId,
      goalId: null,
      projectId: input.projectId,
      parentId: input.parentId,
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
      companyId: item.companyId,
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
      .run({ ...item, createdAt: input.now, updatedAt: input.now });
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
      .run({ ...artifact, createdAt: input.now, updatedAt: input.now });
    return { item, artifact };
  }
}
