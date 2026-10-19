import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyService } from "../company-service.js";
import { OrganizationService } from "../organization-service.js";
import { WorkService } from "../work-service.js";
import type { DecideStageGateInput, StageGateNextAction } from "./stage-gate.js";
import { StageGateService } from "./stage-gate.js";
import { StageGateCoordinator } from "./stage-gate-coordinator.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const roots: string[] = [];
const stores: ForgeStore[] = [];
const clock = { now: () => "2026-09-11T07:00:00.000Z" };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("StageGateCoordinator", () => {
  function ready() {
    const f = fixture(true);
    const work = new WorkService(f.store.db, clock);
    const item = work.createWorkItem({ companyId: f.companyId, projectId: f.projectId, type: "research", title: "Research", problem: "Problem", expectedOutcome: "Report", ownerId: f.ownerId });
    const db = f.store.db;
    db.prepare("UPDATE company_work_items SET state = 'completed' WHERE id = ?").run(item.id);
    db.prepare(`INSERT INTO core_runs (id, state, spec_json, correlation_id, requested_by_json, created_at, updated_at) VALUES ('run', 'succeeded', '{}', 'r', '{}', ?, ?)`).run(clock.now(), clock.now());
    db.prepare(`INSERT INTO company_run_links (id, company_id, work_item_id, run_id, created_at) VALUES ('link', ?, ?, 'run', ?)`).run(f.companyId, item.id, clock.now());
    db.prepare(`INSERT INTO core_artifacts (id, producer_run_id, media_type, sha256, content_ref, size_bytes, created_at) VALUES ('report', 'run', 'text/markdown', 'hash1', 'report-ref', 10, ?)`).run(clock.now());
    const gates = new StageGateCoordinator(db, clock.now);
    const request = { id: "decision", companyId: f.companyId, projectId: f.projectId!, gate: "research" as const, outcome: "stopped" as const, inputVersionRefs: gates.snapshot(f.companyId, f.projectId!, "research").inputVersionRefs, decidedBy: { kind: "employee", id: f.ownerId }, rationale: "Not viable", impact: "Close" };
    return { ...f, work, item, db, gates, request };
  }
  function workflowOnly(options: { synthesis: "succeeded" | "running" | "none"; waitReason?: string; waitState?: string } = { synthesis: "succeeded" }) {
    const f = fixture(true);
    const work = new WorkService(f.store.db, clock);
    work.createWorkItem({ companyId: f.companyId, projectId: f.projectId, type: "research", title: "Research", problem: "Problem", expectedOutcome: "Report", ownerId: f.ownerId });
    const db = f.store.db;
    const t = clock.now();
    db.prepare(`INSERT INTO core_runs (id, state, spec_json, correlation_id, requested_by_json, created_at, updated_at) VALUES ('wf-run', 'waiting', '{}', 'wf', '{}', ?, ?)`).run(t, t);
    const step = (id: string, kind: string, state: string) => db.prepare(`INSERT INTO core_steps (id, run_id, kind, state, retry_json, timeout_ms, created_at, updated_at) VALUES (?, 'wf-run', ?, ?, '{}', 1000, ?, ?)`).run(id, kind, state, t, t);
    const attempt = (id: string, stepId: string, state: string, outputRef: string | null) => db.prepare(`INSERT INTO core_attempts (id, run_id, step_id, attempt_number, state, output_ref, created_at, updated_at) VALUES (?, 'wf-run', ?, 1, ?, ?, ?, ?)`).run(id, stepId, state, outputRef, t, t);
    if (options.synthesis !== "none") {
      step("synthesis", "requirement-research.synthesis", options.synthesis);
      attempt("att-syn", "synthesis", options.synthesis, options.synthesis === "succeeded" ? "forge-result:syn" : null);
    }
    step("research-gate", "requirement-research.gate", "waiting");
    attempt("att-gate", "research-gate", "abandoned", null);
    db.prepare(`INSERT INTO core_step_waits (id, run_id, step_id, attempt_id, wait_kind, wait_ref, state, payload_json, created_at) VALUES ('wait-1', 'wf-run', 'research-gate', 'att-gate', 'manual_review', 'wait-1', ?, ?, ?)`)
      .run(options.waitState ?? "waiting", JSON.stringify({ kind: "manual_review", reason: options.waitReason ?? `company-stage-gate:research:${f.projectId}` }), t);
    const gates = new StageGateCoordinator(db, clock.now);
    return { ...f, db, gates };
  }
  it("is research-ready from an active workflow gate wait plus a succeeded synthesis, without a linked succeeded run", () => {
    const f = workflowOnly();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM company_run_links").get()).toEqual({ n: 0 });
    const snapshot = f.gates.snapshot(f.companyId, f.projectId!, "research");
    expect(snapshot).toMatchObject({ ready: true });
    expect(snapshot.inputVersionRefs).toEqual(expect.arrayContaining([
      "workflow-gate-wait:wait-1:wf-run",
      expect.stringMatching(/^synthesis:wf-run:synthesis:forge-result:syn:/),
    ]));
    const decision = f.gates.decide({ id: "wf-decision", companyId: f.companyId, projectId: f.projectId!, gate: "research", outcome: "approved", inputVersionRefs: snapshot.inputVersionRefs, decidedBy: { kind: "employee", id: f.ownerId }, rationale: "ok", impact: "go" });
    expect(decision).toMatchObject({ id: "wf-decision", outcome: "approved" });
    // Later gates remain gated by their own prerequisites.
    expect(f.gates.snapshot(f.companyId, f.projectId!, "technical")).toMatchObject({ ready: false, reason: expect.stringContaining("scope gate approval required") });
  });
  it("is not research-ready when the workflow wait exists but synthesis has not succeeded", () => {
    for (const synthesis of ["running", "none"] as const) {
      const f = workflowOnly({ synthesis });
      const snapshot = f.gates.snapshot(f.companyId, f.projectId!, "research");
      expect(snapshot.ready).toBe(false);
      expect(() => f.gates.decide({ id: "wf-decision", companyId: f.companyId, projectId: f.projectId!, gate: "research", outcome: "approved", inputVersionRefs: [], decidedBy: { kind: "employee", id: f.ownerId }, rationale: "ok", impact: "go" })).toThrow();
    }
  });
  it("is not research-ready for a resolved, foreign-project or absent workflow wait", () => {
    for (const options of [
      { synthesis: "succeeded" as const, waitState: "resolved" },
      { synthesis: "succeeded" as const, waitReason: "company-stage-gate:research:other-project" },
    ]) {
      const f = workflowOnly(options);
      expect(f.gates.snapshot(f.companyId, f.projectId!, "research").ready).toBe(false);
    }
  });
  it("stops a workflow-path project without hand-finishing the research work item", () => {
    const f = workflowOnly();
    expect(f.db.prepare("SELECT state FROM company_work_items").get()).toEqual({ state: "draft" });
    const snapshot = f.gates.snapshot(f.companyId, f.projectId!, "research");
    const decision = f.gates.decide({ id: "wf-stop", companyId: f.companyId, projectId: f.projectId!, gate: "research", outcome: "stopped", inputVersionRefs: snapshot.inputVersionRefs, decidedBy: { kind: "employee", id: f.ownerId }, rationale: "no", impact: "close" });
    expect(decision.outcome).toBe("stopped");
    expect(f.db.prepare("SELECT state, version FROM company_work_items").get()).toEqual({ state: "completed", version: 2 });
    expect(f.db.prepare("SELECT state FROM company_projects").get()).toEqual({ state: "completed" });
  });
  it("completes workflow-path research items on approved and changes_requested too", () => {
    for (const outcome of ["approved", "changes_requested"] as const) {
      const f = workflowOnly();
      const snapshot = f.gates.snapshot(f.companyId, f.projectId!, "research");
      f.gates.decide({ id: `wf-${outcome}`, companyId: f.companyId, projectId: f.projectId!, gate: "research", outcome, inputVersionRefs: snapshot.inputVersionRefs, decidedBy: { kind: "employee", id: f.ownerId }, rationale: "ok", impact: "go" });
      expect(f.db.prepare("SELECT state FROM company_work_items").get()).toEqual({ state: "completed" });
      expect(f.db.prepare("SELECT state FROM company_projects").get()).toEqual({ state: "active" });
    }
  });
  it("closes research atomically and replays exactly once", () => {
    const f = ready();
    const decision = f.gates.decide(f.request);
    expect(decision.decidedAt).toBe(clock.now());
    expect(f.gates.snapshot(f.companyId, f.projectId!, "research")).toMatchObject({ ready: false, projectState: "completed" });
    expect(f.gates.decide(f.request)).toEqual(decision);
    expect(() => f.gates.decide({ ...f.request, rationale: "changed" })).toThrow("conflict");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM company_stage_gates").get()).toEqual({ n: 1 });
    expect(() => f.work.createWorkItem({ companyId: f.companyId, projectId: f.projectId, type: "research", title: "new", problem: "new", expectedOutcome: "new", ownerId: f.ownerId })).toThrow("completed");
  });
  it("requires approved predecessor gates before each later stage", () => {
    const f = ready();
    for (const gate of ["scope", "technical", "release"] as const) {
      expect(f.gates.snapshot(f.companyId, f.projectId!, gate)).toMatchObject({ ready: false, reason: expect.stringContaining("gate approval required") });
      expect(() => f.gates.decide({ ...f.request, gate, outcome: "approved" })).toThrow("gate approval required");
    }
  });
  it("ignores cancelled historical research when choosing current report", () => {
    const f = ready();
    const old = f.work.createWorkItem({ companyId: f.companyId, projectId: f.projectId, type: "research", title: "cancelled", problem: "old", expectedOutcome: "old", ownerId: f.ownerId });
    f.db.prepare("UPDATE company_work_items SET state = 'cancelled' WHERE id = ?").run(old.id);
    const snapshot = f.gates.snapshot(f.companyId, f.projectId!, "research");
    expect(snapshot.ready).toBe(true);
    expect(f.gates.decide({ ...f.request, inputVersionRefs: snapshot.inputVersionRefs }).outcome).toBe("stopped");
  });
  it("rejects content changes even when the client claims matching current versions", () => {
    const f = ready();
    f.db.prepare("UPDATE core_artifacts SET sha256 = 'hash2'").run();
    expect(() => f.gates.decide(f.request)).toThrow("inputs changed");
    expect(f.db.prepare("SELECT state FROM company_projects").get()).toEqual({ state: "active" });
  });
  it("stops research on a mixed project without closing the shared project", () => {
    const f = ready();
    f.work.createWorkItem({
      companyId: f.companyId,
      projectId: f.projectId,
      type: "implementation",
      title: "dev",
      problem: "dev",
      expectedOutcome: "dev",
      ownerId: f.ownerId,
    });
    f.request.inputVersionRefs = f.gates.snapshot(f.companyId, f.projectId!, "research").inputVersionRefs;
    const decision = f.gates.decide(f.request);
    expect(decision.outcome).toBe("stopped");
    expect(f.db.prepare("SELECT state FROM company_projects").get()).toEqual({ state: "active" });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM company_stage_gates").get()).toEqual({ n: 1 });
  });

  it("blocks pending research, inactive actors and missing scope", () => {
    const f = ready();
    f.db.prepare("UPDATE company_work_items SET state = 'draft'").run();
    f.request.inputVersionRefs = f.gates.snapshot(f.companyId, f.projectId!, "research").inputVersionRefs;
    expect(() => f.gates.decide(f.request)).toThrow("research tasks must be completed");
    f.db.prepare("UPDATE company_work_items SET state = 'completed'").run();
    expect(f.gates.snapshot(f.companyId, f.projectId!, "scope").ready).toBe(false);
    expect(() => f.gates.decide({ ...f.request, companyId: "other" })).toThrow();
    f.db.prepare("UPDATE company_employments SET status = 'inactive'").run();
    expect(() => f.gates.decide(f.request)).toThrow("active company employee");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM company_stage_gates").get()).toEqual({ n: 0 });
  });
});

function fixture(withProject = false) {
  const root = mkdtempSync(join(tmpdir(), "forge-stage-gate-"));
  roots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);
  const companies = new CompanyService(store.db, clock);
  const company = companies.create({ name: "Forge" });
  let projectId: string | undefined;
  let ownerId = "";
  if (withProject) {
    const org = new OrganizationService(store.db, clock);
    const department = org.createDepartment({ companyId: company.id, name: "Product" });
    const template = org.createPositionTemplate({
      companyId: company.id,
      name: "Owner",
      charter: "Decide",
    });
    const position = org.createPosition({
      companyId: company.id,
      departmentId: department.id,
      templateId: template.id,
      title: "Owner",
    });
    const owner = org.hire({
      companyId: company.id,
      displayName: "Owner",
      positionId: position.id,
      autonomyLevel: 2,
    });
    ownerId = owner.id;
    const work = new WorkService(store.db, clock);
    const goal = work.createGoal({
      companyId: company.id,
      title: "Ship",
      ownerId: owner.id,
    });
    projectId = work.createProject({
      companyId: company.id,
      goalId: goal.id,
      title: "Delivery",
    }).id;
  }
  return {
    store,
    ownerId,
    companyId: company.id,
    projectId,
    gates: new StageGateService(store.db),
  };
}
