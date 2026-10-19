import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeStore } from "@forge/store";
import { afterEach, describe, expect, it } from "vitest";
import { persistResearchResult } from "./research-result.js";
import { CompanyService } from "./company-service.js";
import { buildDeliveryTrace, canMarkDelivered, previewWorkspaceFile } from "./delivery-trace.js";
import { OrganizationService } from "./organization-service.js";
import { WorkGates } from "./work-gates.js";
import { WorkService } from "./work-service.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "migrations");
const fixtureRoots: string[] = [];
const stores: ForgeStore[] = [];
const clock = {
  now: () => "2026-09-09T00:00:00.000Z",
};

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("delivery trace", () => {
  it("returns the exact saved result of linked executions, excluding other work", () => {
    const { db, gates, item, employee } = openFixture();
    const plan = gates.upsertDraft({ workItemId: item.id, kind: "plan", content: "调研", actorId: employee.id });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    for (const id of ["research-own", "research-other"]) {
      db.prepare(`INSERT INTO core_runs (id, state, spec_json, correlation_id, requested_by_json, created_at, updated_at)
        VALUES (?, 'succeeded', '{}', ?, '{}', ?, ?)`).run(id, id, clock.now(), clock.now());
      db.prepare(`INSERT INTO core_steps (id, run_id, kind, state, retry_json, timeout_ms, created_at, updated_at)
        VALUES ('report', ?, 'agent', 'succeeded', '{}', 1000, ?, ?)`).run(id, clock.now(), clock.now());
      db.prepare(`INSERT INTO core_attempts (id, run_id, step_id, attempt_number, state, output_ref, created_at, updated_at)
        VALUES (?, ?, 'report', 1, 'succeeded', ?, ?, ?)`).run(id, id, `forge-result:${id}`, clock.now(), clock.now());
      db.prepare(`INSERT INTO core_legacy_run_results VALUES (?, ?, ?, ?)`)
        .run(`forge-result:${id}`, `session-${id}`, id === "research-own" ? "结论：先验证付费意愿，再开发。" : "别的项目的报告", clock.now());
    }
    gates.linkRun({ workItemId: item.id, runId: "research-own", planArtifactId: plan.id });
    const trace = buildDeliveryTrace(db, item.id);
    expect(trace.outputs).toHaveLength(1);
    expect(trace.outputs[0]).toMatchObject({ runId: "research-own", content: "结论：先验证付费意愿，再开发。", mediaType: "text/markdown" });
    expect(JSON.stringify(trace.outputs)).not.toContain("别的项目的报告");
    // Losing the saved body must not substitute the original demand or a newer session message.
    db.prepare("DELETE FROM core_legacy_run_results").run();
    expect(buildDeliveryTrace(db, item.id).outputs[0]).not.toHaveProperty("content");
  });

  it("persists structured report snapshots without accepting cross-run or stale cached data", () => {
    const { db, gates, item, employee } = openFixture();
    const plan = gates.upsertDraft({ workItemId: item.id, kind: "plan", content: "research", actorId: employee.id });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    const content = '```forge-research-result\n' + JSON.stringify({ schemaVersion: 1, conclusion: "Supported", evidence: [], risks: [], unknowns: ["Missing interviews"], nextActions: [] }) + '\n```';
    db.prepare(`INSERT INTO core_runs (id, state, spec_json, correlation_id, requested_by_json, created_at, updated_at) VALUES ('structured-run', 'succeeded', '{}', 'r', '{}', ?, ?)`).run(clock.now(), clock.now());
    db.prepare(`INSERT INTO core_steps (id, run_id, kind, state, retry_json, timeout_ms, created_at, updated_at) VALUES ('report', 'structured-run', 'agent', 'succeeded', '{}', 1000, ?, ?)`).run(clock.now(), clock.now());
    db.prepare(`INSERT INTO core_attempts (id, run_id, step_id, attempt_number, state, output_ref, created_at, updated_at) VALUES ('a', 'structured-run', 'report', 1, 'succeeded', 'result:1', ?, ?)`).run(clock.now(), clock.now());
    db.prepare("INSERT INTO core_legacy_run_results VALUES ('result:1', 'session', ?, ?)").run(content, clock.now());
    gates.linkRun({ workItemId: item.id, runId: "structured-run", planArtifactId: plan.id });
    expect(persistResearchResult(db, content, "other-run", "result:1")).toBeNull();
    expect(persistResearchResult(db, content + "changed", "structured-run", "result:1")).toBeNull();
    const result = buildDeliveryTrace(db, item.id).outputs[0]?.researchResult;
    expect(result?.conclusion).toBe("Supported");
    expect(db.prepare("SELECT COUNT(*) AS count FROM company_research_results").get()).toEqual({ count: 1 });
    db.prepare("UPDATE company_research_results SET result_json = '{}' ").run();
    expect(buildDeliveryTrace(db, item.id).outputs[0]?.researchResult).toEqual(result);
    db.prepare("DELETE FROM core_legacy_run_results").run();
    expect(buildDeliveryTrace(db, item.id).outputs[0]?.researchResult).toBeUndefined();
  });

  it("omits delivery until spec plan and run exist", () => {
    const { db, item, work } = openFixture();

    const trace = buildDeliveryTrace(db, item.id);

    expect(trace).toEqual({
      workItemId: item.id,
      runIds: [],
      runs: [],
      artifactIds: work.listArtifacts(item.id).map(({ id }) => id),
      validationIds: [],
      validations: [],
      evidence: [],
      outputs: [],
      workspaceFiles: [],
    });
    expect(canMarkDelivered(trace)).toBe(false);
  });

  it("is complete after accepted spec, plan, and linked run", () => {
    const { db, gates, item, employee, work } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "先实现状态切换，再补快捷键",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    gates.linkRun({
      workItemId: item.id,
      runId: "run_delivery_1",
      planArtifactId: plan.id,
    });
    db.prepare(
      `INSERT INTO core_validations (
        id, run_id, validator_id, layer, status, severity,
        evidence_ids_json, summary, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "validation_delivery_1",
      "run_delivery_1",
      employee.id,
      "result",
      "passed",
      "info",
      "[]",
      "Delivery output verified",
      "{}",
      clock.now(),
    );
    db.prepare(
      `INSERT INTO core_validations (
        id, run_id, validator_id, layer, status, severity,
        evidence_ids_json, summary, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "validation_process_1",
      "run_delivery_1",
      "company.plan_alignment",
      "process",
      "passed",
      "info",
      "[]",
      "引用已接受计划",
      "{}",
      clock.now(),
    );
    db.prepare(
      `INSERT INTO core_validations (
        id, run_id, validator_id, layer, status, severity,
        evidence_ids_json, summary, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "validation_answer_1",
      "run_delivery_1",
      "company.acceptance",
      "answer",
      "passed",
      "info",
      "[]",
      "独立验收通过",
      "{}",
      clock.now(),
    );
    db.prepare(
      `INSERT INTO core_evidence (
        id, run_id, claim, source_kind, source_ref, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "evidence_commit_1",
      "run_delivery_1",
      "feat: maximize pane",
      "git.commit",
      "abc1234",
      "{}",
      clock.now(),
    );
    db.prepare(
      `INSERT INTO core_artifacts (
        id, producer_run_id, media_type, sha256, content_ref, size_bytes,
        access_scope_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "artifact_diff_1",
      "run_delivery_1",
      "text/x-diff",
      "a".repeat(64),
      "sha256:diff1",
      12,
      "{}",
      "{}",
      clock.now(),
    );

    const trace = buildDeliveryTrace(db, item.id);

    expect(trace).toEqual({
      workItemId: item.id,
      specVersion: 1,
      planVersion: 1,
      runIds: ["run_delivery_1"],
      runs: [
        {
          runId: "run_delivery_1",
          createdAt: clock.now(),
        },
      ],
      artifactIds: work.listArtifacts(item.id).map(({ id }) => id),
      validationIds: [
        "validation_answer_1",
        "validation_delivery_1",
        "validation_process_1",
      ],
      validations: [
        {
          id: "validation_answer_1",
          runId: "run_delivery_1",
          status: "passed",
          summary: "独立验收通过",
          validatorId: "company.acceptance",
          layer: "answer",
        },
        {
          id: "validation_delivery_1",
          runId: "run_delivery_1",
          status: "passed",
          summary: "Delivery output verified",
          validatorId: employee.id,
          layer: "result",
        },
        {
          id: "validation_process_1",
          runId: "run_delivery_1",
          status: "passed",
          summary: "引用已接受计划",
          validatorId: "company.plan_alignment",
          layer: "process",
        },
      ],
      evidence: [
        {
          id: "evidence_commit_1",
          runId: "run_delivery_1",
          claim: "feat: maximize pane",
          sourceKind: "git.commit",
          sourceRef: "abc1234",
        },
      ],
      outputs: [
        {
          id: "artifact_diff_1",
          runId: "run_delivery_1",
          mediaType: "text/x-diff",
          contentRef: "sha256:diff1",
        },
      ],
      workspaceFiles: [],
    });
    expect(canMarkDelivered(trace)).toBe(true);
  });

  it("is not delivered when the run has no self-check", () => {
    const { db, gates, item, employee } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "先实现状态切换",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    gates.linkRun({
      workItemId: item.id,
      runId: "run_no_check",
      planArtifactId: plan.id,
    });

    expect(canMarkDelivered(buildDeliveryTrace(db, item.id))).toBe(false);
  });

  it("uses only currently accepted artifact versions and non-empty runs", () => {
    const { db, gates, item, employee } = openFixture();
    const specV1 = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "v1",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: specV1.id, actorId: employee.id });
    const specV2 = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "v2",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: specV2.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "plan",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    gates.linkRun({
      workItemId: item.id,
      runId: "",
      planArtifactId: plan.id,
    });

    const trace = buildDeliveryTrace(db, item.id);

    expect(trace.specVersion).toBe(2);
    expect(trace.planVersion).toBe(1);
    expect(trace.runIds).toEqual([]);
    expect(trace.runs).toEqual([]);
    expect(canMarkDelivered(trace)).toBe(false);
  });

  it("attaches the workbench session for each linked run", () => {
    const { db, gates, item, employee } = openFixture();
    const spec = gates.upsertDraft({
      workItemId: item.id,
      kind: "spec",
      content: "范围：最大化",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: spec.id, actorId: employee.id });
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "先实现状态切换",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    gates.linkRun({
      workItemId: item.id,
      runId: "run_session_a",
      planArtifactId: plan.id,
    });
    gates.linkRun({
      workItemId: item.id,
      runId: "run_session_b",
      planArtifactId: plan.id,
    });
    db.prepare(
      "INSERT INTO sessions (id, cwd, created_at) VALUES (?, ?, ?)",
    ).run("sess_a", "/tmp/repo-a", clock.now());
    db.prepare(
      "INSERT INTO sessions (id, cwd, created_at) VALUES (?, ?, ?)",
    ).run("sess_b", "/tmp/repo-b", clock.now());
    db.prepare(
      `INSERT INTO core_events
        (event_id, event_type, envelope_json, occurred_at, run_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "evt_a",
      "agent.event",
      JSON.stringify({ data: { sessionId: "sess_a" } }),
      clock.now(),
      "run_session_a",
    );
    db.prepare(
      `INSERT INTO core_events
        (event_id, event_type, envelope_json, occurred_at, run_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "evt_b",
      "agent.event",
      JSON.stringify({ data: { sessionId: "sess_b" } }),
      clock.now(),
      "run_session_b",
    );

    expect(buildDeliveryTrace(db, item.id).runs).toEqual(
      expect.arrayContaining([
        {
          runId: "run_session_a",
          createdAt: clock.now(),
          sessionId: "sess_a",
          cwd: "/tmp/repo-a",
        },
        {
          runId: "run_session_b",
          createdAt: clock.now(),
          sessionId: "sess_b",
          cwd: "/tmp/repo-b",
        },
      ]),
    );
  });

  it("lists unique workspace write paths without reading file bodies", () => {
    const { db, gates, item, employee } = openFixture();
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "调研",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    db.prepare(
      `INSERT INTO core_runs (id, state, spec_json, correlation_id, requested_by_json, created_at, updated_at)
      VALUES ('run_files', 'succeeded', '{}', 'run_files', '{}', ?, ?)`,
    ).run(clock.now(), clock.now());
    gates.linkRun({ workItemId: item.id, runId: "run_files", planArtifactId: plan.id });
    const insertEvent = db.prepare(
      `INSERT INTO core_events (event_id, event_type, envelope_json, occurred_at, run_id)
      VALUES (?, 'agent.event', ?, ?, 'run_files')`,
    );
    insertEvent.run(
      "evt_write_1",
      JSON.stringify({
        data: { type: "tool_start", name: "write_file", args: { path: "docs/00.md", content: "SECRET" } },
      }),
      clock.now(),
    );
    insertEvent.run(
      "evt_write_dup",
      JSON.stringify({
        data: { type: "tool_start", name: "write_patch", args: { path: "docs/00.md" } },
      }),
      clock.now(),
    );
    insertEvent.run(
      "evt_read",
      JSON.stringify({
        data: { type: "tool_start", name: "read_file", args: { path: "docs/skip.md" } },
      }),
      clock.now(),
    );
    insertEvent.run(
      "evt_escape",
      JSON.stringify({
        data: { type: "tool_start", name: "write_file", args: { path: "../outside.md" } },
      }),
      clock.now(),
    );

    const trace = buildDeliveryTrace(db, item.id);
    expect(trace.workspaceFiles).toEqual([{ path: "docs/00.md", runId: "run_files" }]);
    expect(JSON.stringify(trace.workspaceFiles)).not.toContain("SECRET");
    expect(trace.workspaceFiles.map((file) => file.path)).not.toContain("docs/skip.md");
    expect(previewWorkspaceFile(db, item.id, "docs/00.md")).toEqual({
      path: "docs/00.md",
      runId: "run_files",
      previewable: true,
      content: "SECRET",
      mediaType: "text/markdown",
    });
    expect(() => previewWorkspaceFile(db, item.id, "docs/skip.md")).toThrow(
      /workspace file not found/,
    );
    expect(() => previewWorkspaceFile(db, item.id, "../outside.md")).toThrow(
      /workspace file not found/,
    );
  });

  it("prefers the file on disk over the write event body", () => {
    const { db, gates, item, employee } = openFixture();
    const plan = gates.upsertDraft({
      workItemId: item.id,
      kind: "plan",
      content: "调研",
      actorId: employee.id,
    });
    gates.acceptArtifact({ artifactId: plan.id, actorId: employee.id });
    db.prepare(
      `INSERT INTO core_runs (id, state, spec_json, correlation_id, requested_by_json, created_at, updated_at)
      VALUES ('run_disk', 'succeeded', ?, 'run_disk', '{}', ?, ?)`,
    ).run(
      JSON.stringify({ steps: [{ input: { cwd: "/tmp/repo" } }] }),
      clock.now(),
      clock.now(),
    );
    gates.linkRun({ workItemId: item.id, runId: "run_disk", planArtifactId: plan.id });
    db.prepare(
      `INSERT INTO core_events (event_id, event_type, envelope_json, occurred_at, run_id)
      VALUES ('evt_disk', 'agent.event', ?, ?, 'run_disk')`,
    ).run(
      JSON.stringify({
        data: { type: "tool_start", name: "write_file", args: { path: "docs/00.md", content: "EVENT" } },
      }),
      clock.now(),
    );

    expect(
      previewWorkspaceFile(db, item.id, "docs/00.md", {
        readFile: (cwd, relativePath) => {
          expect(cwd).toBe("/tmp/repo");
          expect(relativePath).toBe("docs/00.md");
          return "FROM_DISK";
        },
      }),
    ).toMatchObject({ previewable: true, content: "FROM_DISK" });
  });
});

function openFixture() {
  const root = mkdtempSync(join(tmpdir(), "forge-delivery-trace-"));
  fixtureRoots.push(root);
  const store = ForgeStore.open({
    dbPath: join(root, "data.db"),
    migrationsDir,
    owner: "test",
  });
  stores.push(store);

  const companies = new CompanyService(store.db, clock);
  const org = new OrganizationService(store.db, clock);
  const company = companies.create({ name: "曜石" });
  const department = org.createDepartment({
    companyId: company.id,
    name: "产品部",
  });
  const template = org.createPositionTemplate({
    companyId: company.id,
    name: "Product Director",
    charter: "范围建议权，无发布权",
  });
  const position = org.createPosition({
    companyId: company.id,
    departmentId: department.id,
    templateId: template.id,
    title: "产品总监",
  });
  const employee = org.hire({
    companyId: company.id,
    displayName: "方夏",
    positionId: position.id,
    autonomyLevel: 2,
  });
  const work = new WorkService(store.db, clock);
  const item = work.createWorkItem({
    companyId: company.id,
    type: "implementation",
    title: "团队版窗格最大化",
    problem: "给 SSH 客户端出团队版：窗格一键最大化",
    expectedOutcome: "可一键最大化窗格",
    ownerId: employee.id,
  });

  return {
    db: store.db,
    employee,
    gates: new WorkGates(store.db, clock),
    item,
    work,
  };
}
