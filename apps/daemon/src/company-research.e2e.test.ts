import { afterEach, describe, expect, it } from "vitest";
import {
  DAEMON_COMPANY_METHODS,
  acceptBrief,
  clock,
  hireNamed,
  openCompanyE2eFixture,
  rpcContext,
  synthesizeResearch,
} from "./company-p1-e2e-fixture.js";

const fixtures: Array<ReturnType<typeof openCompanyE2eFixture>> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

describe("company research e2e", () => {
  it("finishes a research-only project after a stop decision", async () => {
    const fx = openCompanyE2eFixture();
    fixtures.push(fx);
    const created = fx.company.companies.create({ name: "曜石" });
    const owner = hireNamed(fx.company, created.id, "乔麦");
    const goal = fx.company.work.createGoal({ companyId: created.id, title: "Research", ownerId: owner.id });
    const project = fx.company.work.createProject({ companyId: created.id, goalId: goal.id, title: "Research project" });
    const workItem = fx.company.work.createWorkItem({
      projectId: project.id,
      companyId: created.id,
      type: "research",
      title: "转化调研",
      problem: "转化低",
      expectedOutcome: "明确是否值得做产品",
      ownerId: owner.id,
    });
    const brief = acceptBrief(fx.store.db, clock, {
      companyId: created.id,
      workItemId: workItem.id,
      problem: "转化低",
      targetUser: "SMB 运营",
      expectedOutcome: "明确是否进入研发",
    });
    const synthesis = synthesizeResearch([
      {
        id: "claim-1",
        briefId: brief.id,
        text: "注册后第三步流失 18%",
        classification: "fact",
        evidenceIds: ["evidence-funnel"],
        confidence: 0.9,
        contradictions: [],
      },
    ]);
    // Deterministic persisted execution fixture; real execution is covered by user-journey E2E.
    fx.store.db.prepare("UPDATE company_work_items SET state = 'completed' WHERE id = ?").run(workItem.id);
    fx.store.db.prepare(`INSERT INTO core_runs (id, state, spec_json, correlation_id, requested_by_json, created_at, updated_at) VALUES ('research-run', 'succeeded', '{}', 'r', '{}', ?, ?)`).run(clock.now(), clock.now());
    fx.store.db.prepare(`INSERT INTO company_run_links (id, company_id, work_item_id, run_id, created_at) VALUES ('research-link', ?, ?, 'research-run', ?)`).run(created.id, workItem.id, clock.now());
    fx.store.db.prepare(`INSERT INTO core_artifacts (id, producer_run_id, media_type, sha256, content_ref, size_bytes, created_at) VALUES ('research-report', 'research-run', 'text/markdown', 'hash1', 'report-ref', 10, ?)`).run(clock.now());
    const snapshot = await fx.router.handleUntyped(DAEMON_COMPANY_METHODS.DELIVERY_GATES_SNAPSHOT,
      { companyId: created.id, projectId: project.id, gate: "research" }, rpcContext()) as { inputVersionRefs: string[]; ready: boolean };
    expect(snapshot.ready).toBe(true);
    const decided = await fx.router.handleUntyped(
      DAEMON_COMPANY_METHODS.DELIVERY_GATES_DECIDE,
      {
        id: "gate-research-stop",
        companyId: created.id,
        projectId: project.id,
        gate: "research",
        outcome: "stopped",
        inputVersionRefs: snapshot.inputVersionRefs,
        decidedBy: { kind: "employee", id: owner.id },
        rationale: "调研已足够，不进入研发",
        impact: "关闭调研项目",
      },
      rpcContext(),
    );

    const developmentWorkItems = fx.store.db
      .prepare(
        `SELECT id FROM company_work_items
          WHERE company_id = ? AND type = 'implementation'`,
      )
      .all(created.id);

    expect(brief.ready).toBe(true);
    expect(synthesis.claims.every((claim) =>
      claim.classification !== "fact" || claim.evidenceIds.length > 0,
    )).toBe(true);
    expect(decided).toMatchObject({
      outcome: "stopped",
      nextAction: "close_research_project",
    });
    expect(developmentWorkItems).toEqual([]);
    expect(fx.store.db.prepare("SELECT state FROM company_projects WHERE id = ?").get(project.id)).toEqual({ state: "completed" });
    expect(() => fx.company.work.createWorkItem({ companyId: created.id, projectId: project.id, type: "research", title: "new", problem: "new", expectedOutcome: "new", ownerId: owner.id })).toThrow("completed");
  });
});
