import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { StageGateService, type DecideStageGateInput } from "./stage-gate.js";
import { ReleaseService } from "./release.js";
import type { StageGateKind } from "./types.js";

export type StageGateSnapshot = { inputVersionRefs: string[]; ready: boolean; reason?: string; projectState: string };
export type StageGateRequest = Omit<DecideStageGateInput, "decidedAt" | "projectId"> & { projectId: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Production boundary: submitted refs are optimistic concurrency expectations, never authority. */
export class StageGateCoordinator {
  constructor(private readonly db: Database.Database, private readonly now = () => new Date().toISOString()) {}

  snapshot(companyId: string, projectId: string, gate: StageGateKind): StageGateSnapshot {
    const project = this.db.prepare("SELECT state FROM company_projects WHERE company_id = ? AND id = ?").get(companyId, projectId) as { state: string } | undefined;
    if (!project) throw new Error("project not found in company");
    const refs: string[] = [];
    try {
      if (project.state !== "active") throw new Error("project is completed");
      const predecessor = { scope: "research", technical: "scope", release: "technical" }[gate as "scope" | "technical" | "release"] as StageGateKind | undefined;
      if (predecessor) {
        const decision = new StageGateService(this.db).getLatest(projectId, predecessor);
        if (!decision || decision.outcome !== "approved") throw new Error(`${predecessor} gate approval required`);
        refs.push(`prerequisite:${decision.id}:${hash(decision)}`);
      }
      const items = this.db.prepare("SELECT id, type, state, version FROM company_work_items WHERE company_id = ? AND project_id = ? ORDER BY created_at, rowid").all(companyId, projectId) as { id: string; type: string; state: string; version: number }[];
      if (!items.length) throw new Error("project work items required");
      refs.push(`tasks:${hash(items)}`);
      refs.push(`accepted:${hash(this.db.prepare(`SELECT a.* FROM company_work_artifacts a JOIN company_work_items w ON w.id = a.work_item_id WHERE w.company_id = ? AND w.project_id = ? AND a.status = 'accepted' ORDER BY a.id`).all(companyId, projectId))}`);
      if (gate === "research") {
        refs.push(...this.researchReadiness(projectId, items));
      } else if (gate === "scope" || gate === "technical") {
        const kind = gate === "scope" ? "spec" : "plan";
        const artifacts = this.db.prepare(`SELECT a.id, a.work_item_id, a.kind, a.version, a.content_hash, a.content FROM company_work_artifacts a
          JOIN company_work_items w ON w.id = a.work_item_id WHERE w.company_id = ? AND w.project_id = ? AND w.type <> 'research' AND a.status = 'accepted' AND a.kind = ? ORDER BY a.id`).all(companyId, projectId, kind);
        if (!artifacts.length) throw new Error(`accepted ${kind} artifact required`);
        if (gate === "technical" && !this.db.prepare(`SELECT 1 FROM company_work_artifacts a JOIN company_work_items w ON w.id = a.work_item_id WHERE w.company_id = ? AND w.project_id = ? AND w.type <> 'research' AND a.status = 'accepted' AND a.kind = 'spec'`).get(companyId, projectId)) throw new Error("accepted spec artifact required");
        refs.push(`${kind}:${hash(artifacts)}`);
      } else {
        const candidate = this.db.prepare("SELECT id FROM company_release_candidates WHERE company_id = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(companyId, projectId) as { id: string } | undefined;
        if (!candidate) throw new Error("release candidate required");
        refs.push(`release:${hash(new ReleaseService(this.db, { now: this.now }).validatedGateInputs(candidate.id))}`);
      }
      return { inputVersionRefs: refs, ready: true, projectState: project.state };
    } catch (error) {
      return { inputVersionRefs: refs, ready: false, reason: error instanceof Error ? error.message : String(error), projectState: project.state };
    }
  }

  /**
   * Research is decidable when EITHER (A) the latest research work item has a succeeded linked run with
   * a report/artifact, OR (B) an active durable `company-stage-gate:research:<projectId>` wait exists whose
   * run has a succeeded synthesis step with persisted output. Path B is the requirement-research workflow,
   * which is deliberately unlinked and still waiting at the gate while the human decides.
   */
  private researchReadiness(projectId: string, items: { id: string; type: string; state: string }[]): string[] {
    let classicError: Error;
    try {
      return this.classicResearchRefs(items);
    } catch (error) {
      classicError = error instanceof Error ? error : new Error(String(error));
    }
    const waitRef = `company-stage-gate:research:${projectId}`;
    const waits = this.db.prepare(`SELECT w.id, w.run_id AS runId FROM core_step_waits w JOIN core_runs r ON r.id = w.run_id
      WHERE w.state = 'waiting' AND r.state NOT IN ('succeeded', 'failed', 'cancelled')
        AND (w.wait_ref = ? OR json_extract(CASE WHEN json_valid(w.payload_json) THEN w.payload_json ELSE '{}' END, '$.reason') = ?)
      ORDER BY w.created_at DESC, w.rowid DESC`).all(waitRef, waitRef) as { id: string; runId: string }[];
    if (!waits.length) throw classicError;
    for (const wait of waits) {
      const synthesis = this.db.prepare(`SELECT a.id, a.step_id AS stepId, a.output_ref AS outputRef FROM core_attempts a
        JOIN core_steps s ON s.run_id = a.run_id AND s.id = a.step_id
        WHERE a.run_id = ? AND s.kind = 'requirement-research.synthesis' AND s.state = 'succeeded' AND a.state = 'succeeded'
          AND a.output_ref IS NOT NULL AND TRIM(a.output_ref) <> ''
        ORDER BY a.attempt_number DESC, a.rowid DESC LIMIT 1`).get(wait.runId) as { id: string; stepId: string; outputRef: string } | undefined;
      if (!synthesis) continue;
      const result = this.db.prepare("SELECT final_text FROM core_legacy_run_results WHERE output_ref = ?").get(synthesis.outputRef) as { final_text: string } | undefined;
      const artifacts = this.db.prepare("SELECT id, sha256, content_ref FROM core_artifacts WHERE producer_run_id = ? ORDER BY id").all(wait.runId);
      return [
        `workflow-gate-wait:${wait.id}:${wait.runId}`,
        `synthesis:${wait.runId}:${synthesis.stepId}:${synthesis.outputRef}:${hash({ result, artifacts })}`,
      ];
    }
    throw new Error("research synthesis must succeed before the research gate");
  }

  /** Marks unfinished research items (without an in-flight linked run) completed; the durable workflow did the research. */
  private completeWorkflowResearchItems(companyId: string, projectId: string): void {
    this.db.prepare(`UPDATE company_work_items SET state = 'completed', version = version + 1, updated_at = ?
      WHERE company_id = ? AND project_id = ? AND type = 'research' AND state NOT IN ('accepted', 'completed', 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM company_run_links l JOIN core_runs r ON r.id = l.run_id
          WHERE l.work_item_id = company_work_items.id AND r.state NOT IN ('succeeded', 'failed', 'cancelled'))`)
      .run(this.now(), companyId, projectId);
  }

  private classicResearchRefs(items: { id: string; type: string; state: string }[]): string[] {
    const refs: string[] = [];
    const research = items.filter(item => item.type === "research" && item.state !== "cancelled").slice(-1);
    if (!research.length) throw new Error("research work item required");
    for (const item of research) {
      const run = this.db.prepare(`SELECT r.id, r.state FROM company_run_links l JOIN core_runs r ON r.id = l.run_id
        WHERE l.work_item_id = ? ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1`).get(item.id) as { id: string; state: string } | undefined;
      if (!run || run.state !== "succeeded") throw new Error("latest research run must succeed");
      const report = this.db.prepare(`SELECT a.id, a.output_ref, r.final_text FROM core_attempts a
        JOIN core_legacy_run_results r ON r.output_ref = a.output_ref WHERE a.run_id = ? AND a.state = 'succeeded'
        ORDER BY a.attempt_number DESC, a.rowid DESC LIMIT 1`).get(run.id) as { id: string; output_ref: string; final_text: string } | undefined;
      const artifacts = this.db.prepare("SELECT id, sha256, content_ref FROM core_artifacts WHERE producer_run_id = ? ORDER BY id").all(run.id);
      if (!report?.final_text?.trim() && !artifacts.length) throw new Error("research report or artifact required");
      refs.push(`research:${item.id}:${run.id}:${hash({ report, artifacts })}`);
    }
    return refs;
  }

  decide(input: StageGateRequest) {
    return this.db.transaction(() => {
      if (!input.rationale.trim()) throw new Error("decision rationale required");
      if (input.decidedBy.kind !== "employee" || !this.db.prepare(`SELECT 1 FROM company_employees e JOIN company_employments m ON m.employee_id = e.id AND m.company_id = e.company_id WHERE e.company_id = ? AND e.id = ? AND m.status = 'active'`).get(input.companyId, input.decidedBy.id)) throw new Error("active company employee actor required");
      if (!this.db.prepare("SELECT 1 FROM company_projects WHERE company_id = ? AND id = ?").get(input.companyId, input.projectId)) throw new Error("project not found in company");
      const existing = this.db.prepare("SELECT company_id, project_id, decision_json FROM company_stage_gates WHERE id = ?").get(input.id) as { company_id: string; project_id: string; decision_json: string } | undefined;
      if (existing) {
        const decision = JSON.parse(existing.decision_json);
        const same = existing.company_id === input.companyId && existing.project_id === input.projectId &&
          ["gate", "outcome", "rationale", "impact"].every(key => decision[key] === input[key as keyof StageGateRequest]) &&
          decision.decidedBy.kind === input.decidedBy.kind && decision.decidedBy.id === input.decidedBy.id &&
          JSON.stringify([...decision.inputVersionRefs].sort()) === JSON.stringify([...input.inputVersionRefs].sort());
        if (!same) throw new Error("decision id conflict");
        return decision;
      }
      const snapshot = this.snapshot(input.companyId, input.projectId, input.gate);
      if (!snapshot.ready) throw new Error(snapshot.reason);
      // Workflow-path research (unlinked durable run waiting at the gate) never advances its work items;
      // finishing them here lets the decision complete without hand-finishing the placeholder task.
      const workflowPath = input.gate === "research" && snapshot.inputVersionRefs.some(ref => ref.startsWith("workflow-gate-wait:"));
      const hasDevelopmentWork = Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM company_work_items WHERE company_id = ? AND project_id = ? AND type <> 'research'",
          )
          .get(input.companyId, input.projectId),
      );
      if (input.gate === "research" && input.outcome === "stopped") {
        // Shared projects keep development work; stopping research must not force-close them.
        if (!hasDevelopmentWork) {
          if (this.db.prepare(`SELECT 1 FROM company_work_items w JOIN company_run_links l ON l.work_item_id = w.id JOIN core_runs r ON r.id = l.run_id WHERE w.company_id = ? AND w.project_id = ? AND r.state NOT IN ('succeeded', 'failed', 'cancelled')`).get(input.companyId, input.projectId)) {
            throw new Error("active research run must finish before closing project");
          }
          if (workflowPath) this.completeWorkflowResearchItems(input.companyId, input.projectId);
          if (this.db.prepare("SELECT 1 FROM company_work_items WHERE company_id = ? AND project_id = ? AND state NOT IN ('accepted', 'completed', 'cancelled')").get(input.companyId, input.projectId)) {
            throw new Error("research tasks must be completed before closing project");
          }
        } else if (workflowPath) {
          this.completeWorkflowResearchItems(input.companyId, input.projectId);
        }
      }
      const decidedAt = this.now();
      const decision = new StageGateService(this.db).decide({ ...input, decidedAt }, snapshot.inputVersionRefs);
      if (workflowPath && input.outcome !== "rejected") this.completeWorkflowResearchItems(input.companyId, input.projectId);
      if (input.gate === "research" && input.outcome === "stopped" && !hasDevelopmentWork) {
        this.db
          .prepare(
            "UPDATE company_projects SET state = 'completed', version = version + 1, updated_at = ? WHERE company_id = ? AND id = ?",
          )
          .run(decidedAt, input.companyId, input.projectId);
      }
      return decision;
    })();
  }
}
