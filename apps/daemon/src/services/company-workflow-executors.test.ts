import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompanyService,
  OrganizationService,
  StageGateCoordinator,
  StageGateService,
  WorkService,
  acceptBrief,
  bindCompanyBudgetAccount,
} from "@forge/company-domain";
import { ValidationService } from "@forge/evidence";
import {
  ExecutionStore,
  StepExecutorRegistry,
  type ForgeAgentRunFn,
  type StepOutcome,
} from "@forge/execution";
import { ForgeStore } from "@forge/store";
import { WorkspaceGroupService } from "@forge/workspace";
import { startCompanyResearchWorkflow } from "./company-workflow-dispatch.js";
import { getCompanyResearchWorkflowStatus } from "./company-workflow-status.js";
import {
  createRequirementResearchExecutors,
  researchGateWaitRef,
  resumeWaitsByRef,
} from "./company-workflow-executors.js";
import { readForgeRunResult } from "./forge-run-results.js";
import { createProductionValidatorRegistry } from "./production-validators.js";

const migrationsDir = join(import.meta.dirname, "..", "..", "..", "..", "migrations");
const BASE_TIME = "2026-09-11T12:00:00.000Z";
let nowIso = BASE_TIME;
const clock = { now: () => nowIso };
const advanceClock = (ms: number) => {
  nowIso = new Date(Date.parse(nowIso) + ms).toISOString();
};
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  nowIso = BASE_TIME;
});

type BranchPayload = {
  claims: Array<{ text: string; classification: string; evidenceRefs: unknown[] }>;
  evidenceRefs?: unknown[];
  unknowns?: string[];
};

const CLEAN_BRANCH: BranchPayload = {
  claims: [{ text: "SMB 运营有明确痛点", classification: "fact", evidenceRefs: ["ev-1"] }],
  evidenceRefs: ["ev-1"],
  unknowns: [],
};

async function researchExecutorFixture(
  options: {
    branch?: (branch: string) => BranchPayload | string;
    skills?: string[];
    systemPrompt?: string;
    formalReport?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "forge-research-exec-"));
  const store = ForgeStore.open({ dbPath: join(root, "data.db"), migrationsDir, owner: "test" });
  cleanups.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const companies = new CompanyService(store.db, clock);
  const org = new OrganizationService(store.db, clock);
  const work = new WorkService(store.db, clock);
  const company = companies.create({ name: "曜石" });
  const department = org.createDepartment({ companyId: company.id, name: "研究部" });
  const template = org.createPositionTemplate({ companyId: company.id, name: "研究员", charter: "research" });
  const position = org.createPosition({
    companyId: company.id,
    departmentId: department.id,
    templateId: template.id,
    title: "研究员",
  });
  const employee = org.hire({
    companyId: company.id,
    displayName: "研究员甲",
    positionId: position.id,
    autonomyLevel: 2,
  });
  const wsPath = join(root, "ws-a");
  mkdirSync(wsPath);
  new WorkspaceGroupService(store.db).registerWorkspace({ id: "ws-a", rootPath: wsPath });
  org.bindCapability({
    companyId: company.id,
    employeeId: employee.id,
    talentTemplateId: "tpl",
    talentRole: "researcher",
    skills: options.skills ?? [],
    tools: [],
    systemPrompt: options.systemPrompt,
    agentProfileId: "profile-1",
    agentProfileVersionId: "profile-1-v1",
    workspaces: [{ workspaceId: "ws-a", mode: "write", isDefault: true }],
  });
  const goal = work.createGoal({ companyId: company.id, title: "G", ownerId: employee.id });
  const project = work.createProject({ companyId: company.id, goalId: goal.id, title: "P" });
  bindCompanyBudgetAccount(store.db, { companyId: company.id, accountId: "acct-1", createdAt: clock.now() });
  const item = work.createWorkItem({
    companyId: company.id,
    projectId: project.id,
    type: "research",
    title: "调研",
    problem: "转化低",
    expectedOutcome: "明确是否进入研发",
    ownerId: employee.id,
  });
  const brief = acceptBrief(store.db, clock, {
    companyId: company.id,
    workItemId: item.id,
    problem: "转化低",
    targetUser: "SMB 运营",
    expectedOutcome: "明确是否进入研发",
  });
  const executionStore = new ExecutionStore(store.db);
  const started = await startCompanyResearchWorkflow(
    {
      db: store.db,
      executionStore,
      validations: new ValidationService(store.db, createProductionValidatorRegistry()),
      clock,
    },
    {
      companyId: company.id,
      projectId: project.id,
      workflowId: "forge.company.requirement-research",
      briefId: brief.id,
      idempotencyKey: "idea-1",
    },
  );

  const prompts: string[] = [];
  const cwds: string[] = [];
  const runtimes: unknown[] = [];
  const personaPrompts: Array<string | undefined> = [];
  const personaLabels: Array<string | undefined> = [];
  const personaExpected: Array<boolean | undefined> = [];
  const talentSkillIds: Array<string[] | undefined> = [];
  const strictTalentSkills: Array<boolean | undefined> = [];
  const run: ForgeAgentRunFn = async (request) => {
    prompts.push(request.message);
    cwds.push(request.cwd);
    runtimes.push(request.runtime);
    personaPrompts.push(request.personaPrompt);
    personaLabels.push(request.personaLabel);
    personaExpected.push(request.personaExpected);
    talentSkillIds.push(request.talentSkillIds);
    strictTalentSkills.push(request.strictTalentSkills);
    if (request.message.includes("调研报告撰写人") && options.formalReport) {
      return { sessionId: "session-formal-report", finalText: options.formalReport };
    }
    const branch = /Research branch: ([\w-]+)/.exec(request.message)?.[1] ?? "unknown";
    const body = options.branch?.(branch) ?? CLEAN_BRANCH;
    return {
      sessionId: `session-${branch}`,
      finalText: typeof body === "string" ? body : JSON.stringify(body),
    };
  };
  const registry = new StepExecutorRegistry();
  for (const executor of createRequirementResearchExecutors({ db: store.db, executionStore, run })) {
    registry.register(executor);
  }
  const gates = new StageGateService(store.db);

  /** Claim + execute one step the way the governed path does (waiting enters a step wait). */
  async function runStep(stepId: string, runId = started.runId): Promise<StepOutcome & { attemptId: string }> {
    const claimed = executionStore.claimNextStep(runId, "test-worker", clock.now());
    if (!claimed || claimed.stepId !== stepId) {
      throw new Error(`expected ${stepId} to be next, got ${claimed?.stepId}`);
    }
    const step = executionStore.getStep(runId, stepId)!;
    const outcome = await registry.get(step.kind)!.execute(
      {
        runId,
        stepId,
        attemptId: claimed.id,
        attemptNumber: claimed.attemptNumber,
        kind: step.kind,
        input: step.input,
        timeoutMs: step.timeoutMs,
      },
      new AbortController().signal,
    );
    if (outcome.state === "succeeded") {
      executionStore.finishAttempt(claimed.id, { state: "succeeded", outputRef: outcome.outputRef }, clock.now());
    } else if (outcome.state === "waiting") {
      executionStore.enterStepWait(
        claimed.id,
        "manual_review",
        { kind: "manual_review", reason: outcome.waitRef, payload: outcome.payload },
        clock.now(),
      );
    } else {
      executionStore.finishAttempt(claimed.id, { state: "failed", error: outcome.error }, clock.now());
    }
    return { ...outcome, attemptId: claimed.id };
  }

  const coordinator = new StageGateCoordinator(store.db, clock.now);
  const branchIds = ["user-research", "market-research", "code-data-research", "risk-research"];
  return {
    db: store.db,
    work,
    executionStore,
    started,
    companyId: company.id,
    projectId: project.id,
    briefId: brief.id,
    employeeId: employee.id,
    wsPath,
    prompts,
    cwds,
    runtimes,
    personaPrompts,
    personaLabels,
    personaExpected,
    talentSkillIds,
    strictTalentSkills,
    coordinator,
    run: runStep,
    async completeBranches(runId = started.runId) {
      for (const id of [...branchIds].sort()) await runStep(id, runId);
    },
    async completeThroughSynthesis(runId = started.runId) {
      await this.completeBranches(runId);
      await runStep("synthesis", runId);
    },
    async startAnotherRun(idempotencyKey: string) {
      return startCompanyResearchWorkflow(
        {
          db: store.db,
          executionStore,
          validations: new ValidationService(store.db, createProductionValidatorRegistry()),
          clock,
        },
        {
          companyId: company.id,
          projectId: project.id,
          workflowId: "forge.company.requirement-research",
          briefId: brief.id,
          idempotencyKey,
        },
      );
    },
    decideViaCoordinator(id: string, outcome: "approved" | "stopped" | "changes_requested" | "rejected") {
      const snapshot = coordinator.snapshot(company.id, project.id, "research");
      if (!snapshot.ready) throw new Error(snapshot.reason);
      return coordinator.decide({
        id,
        companyId: company.id,
        projectId: project.id,
        gate: "research",
        outcome,
        inputVersionRefs: snapshot.inputVersionRefs,
        decidedBy: { kind: "employee", id: employee.id },
        rationale: "ok",
        impact: "none",
      });
    },
    readOutput(outputRef: string) {
      return JSON.parse(readForgeRunResult(store.db, outputRef)!.finalText);
    },
    decideResearchGate(input: { outcome: "approved" | "stopped" | "changes_requested" | "rejected" }) {
      return gates.decide(
        {
          id: `decision-${input.outcome}`,
          companyId: company.id,
          projectId: project.id,
          gate: "research",
          outcome: input.outcome,
          inputVersionRefs: ["research:v1"],
          decidedBy: { kind: "employee", id: employee.id },
          rationale: "ok",
          impact: "none",
          decidedAt: clock.now(),
        },
        ["research:v1"],
      );
    },
    resumeActiveGateWait() {
      return resumeWaitsByRef(
        {
          db: store.db,
          executor: { resumeWait: (id, payload) => executionStore.resumeWait(id, payload, clock.now()) },
        },
        researchGateWaitRef(project.id),
        { resumed: true },
      );
    },
  };
}

describe("requirement-research executors", () => {
  it("registers all six kinds with no duplicates", () => {
    const kinds = createRequirementResearchExecutors({} as never).map((entry) => entry.kind);
    expect(kinds.sort()).toEqual([
      "requirement-research.code-data-research",
      "requirement-research.gate",
      "requirement-research.market-research",
      "requirement-research.risk-research",
      "requirement-research.synthesis",
      "requirement-research.user-research",
    ]);
  });

  it("injects the assignee's talent-pack persona into each branch run", async () => {
    const persona = "# 趋势研究员\n\n## 你的身份与记忆\n- 角色：市场情报分析";
    const fx = await researchExecutorFixture({
      systemPrompt: persona,
      skills: ["brainstorming"],
    });
    await fx.run("code-data-research");
    expect(fx.personaPrompts[0]).toBe(persona);
    expect(fx.personaLabels[0]).toMatch(/研究员甲/);
    expect(fx.personaExpected[0]).toBe(true);
    // Skills stay available via normal catalog matching; do not force-restrict.
    expect(fx.strictTalentSkills[0]).toBeFalsy();
    expect(fx.talentSkillIds[0]).toBeUndefined();
  });

  it("runs a branch read-only in the governed workspace and persists a claims artifact", async () => {
    const fx = await researchExecutorFixture();
    const outcome = await fx.run("code-data-research");
    expect(outcome.state).toBe("succeeded");
    const body = fx.readOutput((outcome as { outputRef: string }).outputRef);
    expect(body).toEqual({
      conclusionZh: expect.stringMatching(/判断：/),
      claims: [{ text: "SMB 运营有明确痛点", classification: "fact", evidenceRefs: ["ev-1"] }],
      evidenceRefs: ["ev-1"],
      unknowns: [],
    });
    expect(fx.cwds).toEqual([fx.wsPath]);
    expect(fx.prompts[0]).toMatch(/read-only/i);
    expect(fx.prompts[0]).toMatch(/conclusionZh/);
    expect(fx.runtimes).toEqual([expect.objectContaining({ provider: "forge", sandboxMode: "read-only" })]);
    const rows = fx.db
      .prepare(`SELECT classification, evidence_ids_json AS ev FROM company_research_claims WHERE brief_id = ?`)
      .all(fx.briefId);
    expect(rows).toEqual([{ classification: "fact", ev: JSON.stringify(["ev-1"]) }]);
  });

  it("downgrades facts without evidence and accepts {id} evidence refs and fenced JSON", async () => {
    const fx = await researchExecutorFixture({
      branch: () =>
        "```json\n" +
        JSON.stringify({
          claims: [
            { text: " 无证据事实 ", classification: "fact", evidenceRefs: [] },
            { text: "有证据事实", classification: "fact", evidenceRefs: [{ id: "ev-9", source: "doc" }] },
            { text: "胡乱分类", classification: "certain", evidenceRefs: [] },
          ],
          unknowns: ["预算未知"],
        }) +
        "\n```",
    });
    const outcome = await fx.run("code-data-research");
    expect(outcome.state).toBe("succeeded");
    expect(fx.readOutput((outcome as { outputRef: string }).outputRef)).toEqual({
      conclusionZh: expect.stringMatching(/判断：/),
      claims: [
        { text: "无证据事实", classification: "hypothesis", evidenceRefs: [] },
        { text: "有证据事实", classification: "fact", evidenceRefs: ["ev-9"] },
        { text: "胡乱分类", classification: "hypothesis", evidenceRefs: [] },
      ],
      evidenceRefs: ["ev-9"],
      unknowns: ["预算未知"],
    });
  });

  it("keeps a model-written Chinese conclusionZh on the branch artifact", async () => {
    const conclusionZh =
      "判断：值得继续验证，但还不能直接立项。理由：痛点明确且有可核验证据。缺口：付费意愿仍需小范围访谈确认。";
    const fx = await researchExecutorFixture({
      branch: () =>
        JSON.stringify({
          conclusionZh,
          claims: [{ text: "痛点明确", classification: "fact", evidenceRefs: ["ev-1"] }],
          evidenceRefs: ["ev-1"],
          unknowns: ["付费意愿"],
        }),
    });
    const outcome = await fx.run("code-data-research");
    expect(outcome.state).toBe("succeeded");
    expect(fx.readOutput((outcome as { outputRef: string }).outputRef)).toMatchObject({
      conclusionZh,
    });
  });

  it("fails a branch with retryable error when the model output is not the JSON contract", async () => {
    const fx = await researchExecutorFixture({ branch: () => "I could not do it" });
    const outcome = await fx.run("code-data-research");
    expect(outcome).toMatchObject({
      state: "failed",
      retryable: true,
      error: { code: "RESEARCH_BRANCH_OUTPUT_INVALID" },
    });
  });

  it("stores a formal report written from the branch conclusions", async () => {
    const report = [
      "# 转化低 调研报告",
      "",
      "评估日期：2026-10-15",
      "结论：可以进入需求设计",
      "依据成色：事实 1 · 推断 0 · 未知 0",
      "",
      "## 一、结论",
      "证据足够进入需求设计。",
      "",
      "## 关键指标",
      "- 无新增指标",
      "",
      "## 二、依据",
      "",
      "### 用户与场景",
      "用户需要更短的路径。",
      "",
      "### 市场与替代",
      "现有做法可以替换。",
      "",
      "### 竞品与替代",
      "| 名称 | 形态 | 规模或覆盖 | 对本方案的含义 | 来源 |",
      "| --- | --- | --- | --- | --- |",
      "| 现有流程 | 手工 | 未核实 | 可以缩短 | 市场段 |",
      "",
      "### 风险与合规",
      "| 风险 | 严重度 | 含义 | 来源 |",
      "| --- | --- | --- | --- |",
      "| 无否决项 | 低 | 不挡住 | 风险段 |",
      "",
      "## 三、建议",
      "1. 推导：先改一条最短路径",
      "   为什么：用户段认为路径过长。",
      "   下一步：只改这一处。",
      "",
      "## 四、工作量参考",
      "本节只估计实现成本，不作为做或不做的依据。",
      "改动限于现有页面。",
      "",
      "## 五、未核实事项",
      "无。",
    ].join("\n");
    const fx = await researchExecutorFixture({ formalReport: report });
    await fx.completeThroughSynthesis();
    const stored = fx.db
      .prepare(
        `SELECT final_text AS text FROM core_legacy_run_results
         WHERE session_id = ?`,
      )
      .get(`research-synthesis:${fx.started.runId}`) as { text: string };
    expect(JSON.parse(stored.text).formalReport).toContain("## 一、结论");
    expect(JSON.parse(stored.text).formalReport).toContain("推导：先改一条最短路径");
    expect(fx.prompts.some((prompt) => prompt.includes("不作为做或不做的依据"))).toBe(true);
    expect(fx.prompts.some((prompt) => prompt.includes("【代码与数据，只供工作量】"))).toBe(true);
  });

  it("synthesizes only persisted predecessor branch outputs", async () => {
    const fx = await researchExecutorFixture();
    await fx.completeBranches();
    const synthesis = await fx.run("synthesis");
    expect(synthesis.state).toBe("succeeded");
    const body = fx.readOutput((synthesis as { outputRef: string }).outputRef);
    expect(body.recommendation).toMatch(/stop|continue_research|enter_product_definition/);
    expect(body.recommendation).toBe("enter_product_definition");
    expect(body.decisionBriefZh).toMatch(/决策：/);
    expect(body.branchConclusions["market-research"]).toMatch(/判断：/);
    expect(Object.keys(body.sourceOutputRefs).sort()).toEqual([
      "code-data-research",
      "market-research",
      "risk-research",
      "user-research",
    ]);
  });

  it("recommends continue_research when a branch reports an unknown claim", async () => {
    const fx = await researchExecutorFixture({
      branch: (branch) =>
        branch === "risk-research"
          ? { claims: [{ text: "合规风险未知", classification: "unknown", evidenceRefs: [] }] }
          : CLEAN_BRANCH,
    });
    await fx.completeBranches();
    const synthesis = await fx.run("synthesis");
    expect(fx.readOutput((synthesis as { outputRef: string }).outputRef).recommendation).toBe(
      "continue_research",
    );
  });

  it("refuses to synthesize when a predecessor has no persisted output", async () => {
    const fx = await researchExecutorFixture();
    // Complete 3 of 4 branches, then force the synthesis step to run.
    for (const id of ["code-data-research", "market-research", "risk-research"]) await fx.run(id);
    const step = fx.executionStore.getStep(fx.started.runId, "synthesis")!;
    const outcome = await createRequirementResearchExecutors({
      db: fx.db,
      executionStore: fx.executionStore,
      run: async () => {
        throw new Error("synthesis must not call the model");
      },
    })
      .find((entry) => entry.kind === step.kind)!
      .execute(
        {
          runId: fx.started.runId,
          stepId: "synthesis",
          attemptId: "x",
          attemptNumber: 1,
          kind: step.kind,
          input: step.input,
          timeoutMs: 1000,
        },
        new AbortController().signal,
      );
    expect(outcome).toMatchObject({
      state: "failed",
      error: { code: "SYNTHESIS_SOURCE_NOT_COMPLETE", stepId: "user-research" },
    });
  });

  it("waits at research gate until a real stage decision exists", async () => {
    const fx = await researchExecutorFixture();
    await fx.completeThroughSynthesis();
    const waiting = await fx.run("research-gate");
    expect(waiting).toMatchObject({
      state: "waiting",
      waitRef: expect.stringMatching(/^company-stage-gate:research:/),
    });
    expect((waiting as { waitRef: string }).waitRef).toBe(researchGateWaitRef(fx.projectId));

    const decision = fx.decideResearchGate({ outcome: "approved" });
    expect(fx.resumeActiveGateWait()).toBe(1);
    const done = await fx.run("research-gate");
    expect(done.state).toBe("succeeded");
    expect(fx.readOutput((done as { outputRef: string }).outputRef)).toMatchObject({
      decisionId: decision.id,
      outcome: "approved",
      nextAction: "enter_product_definition",
      projectId: fx.projectId,
    });
    expect(fx.resumeActiveGateWait()).toBe(0);
  });

  it("does not pass the gate without a decision even when resumed", async () => {
    const fx = await researchExecutorFixture();
    await fx.completeThroughSynthesis();
    await fx.run("research-gate");
    expect(fx.resumeActiveGateWait()).toBe(1);
    expect((await fx.run("research-gate")).state).toBe("waiting");
  });

  it("succeeds with stopped and changes_requested decisions and fails on rejected", async () => {
    for (const [outcome, expected] of [
      ["stopped", "succeeded"],
      ["changes_requested", "succeeded"],
      ["rejected", "failed"],
    ] as const) {
      const fx = await researchExecutorFixture();
      await fx.completeThroughSynthesis();
      fx.decideResearchGate({ outcome });
      const result = await fx.run("research-gate");
      expect(result.state).toBe(expected);
      if (outcome === "rejected") {
        expect(result).toMatchObject({ error: { code: "STAGE_GATE_REJECTED" } });
      }
    }
  });
  it("passes the gate via the real coordinator with no hand-seeded succeeded linked run", async () => {
    const fx = await researchExecutorFixture();
    await fx.completeThroughSynthesis();
    expect(fx.db.prepare("SELECT COUNT(*) AS n FROM company_run_links").get()).toEqual({ n: 0 });
    expect(fx.coordinator.snapshot(fx.companyId, fx.projectId, "research").ready).toBe(false);

    const waiting = await fx.run("research-gate");
    expect(waiting.state).toBe("waiting");
    const snapshot = fx.coordinator.snapshot(fx.companyId, fx.projectId, "research");
    expect(snapshot.ready).toBe(true);
    expect(snapshot.inputVersionRefs.some((ref) => ref.startsWith("workflow-gate-wait:"))).toBe(true);
    expect(snapshot.inputVersionRefs.some((ref) => ref.startsWith("synthesis:"))).toBe(true);

    const decision = fx.decideViaCoordinator("coordinated-1", "approved");
    expect(fx.resumeActiveGateWait()).toBe(1);
    const done = await fx.run("research-gate");
    expect(done.state).toBe("succeeded");
    expect(fx.readOutput((done as { outputRef: string }).outputRef)).toMatchObject({
      decisionId: decision.id,
      outcome: "approved",
    });
  });

  it("reports workflow research status: waiting at the gate with the succeeded synthesis recommendation", async () => {
    const fx = await researchExecutorFixture();
    const status = () =>
      getCompanyResearchWorkflowStatus(
        { db: fx.db, executionStore: fx.executionStore },
        { companyId: fx.companyId, projectId: fx.projectId },
      );
    expect(status()).toMatchObject({
      workflowRunId: fx.started.runId,
      briefId: fx.briefId,
      waitingAtGate: false,
      synthesisRecommendation: null,
    });

    await fx.completeThroughSynthesis();
    expect(status()).toMatchObject({ waitingAtGate: false, synthesisRecommendation: "enter_product_definition" });
    expect((await fx.run("research-gate")).state).toBe("waiting");
    const waiting = status();
    expect(waiting).toMatchObject({
      workflowRunId: fx.started.runId,
      briefId: fx.briefId,
      waitingAtGate: true,
      synthesisRecommendation: "enter_product_definition",
    });
    expect(waiting.synthesisSummary).toContain("调研结论支持进入需求设计");
    expect(getCompanyResearchWorkflowStatus(
      { db: fx.db, executionStore: fx.executionStore },
      { companyId: fx.companyId, projectId: "other-project" },
    )).toEqual({
      workflowRunId: null,
      briefId: null,
      runState: null,
      waitingAtGate: false,
      synthesisRecommendation: null,
      synthesisSummary: null,
      claims: [],
      claimTotal: 0,
      readingBrief: null,
      decisionMemo: null,
      formalReport: null,
      failureReason: null,
    });
  });

  it("does not show an older idea's waiting research under a newer idea on the same project", async () => {
    const fx = await researchExecutorFixture();
    await fx.completeThroughSynthesis();
    expect((await fx.run("research-gate")).state).toBe("waiting");
    expect(getCompanyResearchWorkflowStatus(
      { db: fx.db, executionStore: fx.executionStore },
      { companyId: fx.companyId, projectId: fx.projectId, briefId: fx.briefId },
    )).toMatchObject({
      briefId: fx.briefId,
      waitingAtGate: true,
      synthesisRecommendation: "enter_product_definition",
    });

    advanceClock(60_000);
    const newerItem = fx.work.createWorkItem({
      companyId: fx.companyId,
      projectId: fx.projectId,
      type: "research",
      title: "小学作文批改助手",
      problem: "小学作文批改助手是否值得做",
      expectedOutcome: "明确是否值得开发",
      ownerId: fx.employeeId,
    });
    const newerBrief = acceptBrief(fx.db, clock, {
      companyId: fx.companyId,
      workItemId: newerItem.id,
      problem: "小学作文批改助手是否值得做",
      targetUser: "家长与教师",
      expectedOutcome: "明确是否值得开发",
    });
    const newer = await startCompanyResearchWorkflow(
      {
        db: fx.db,
        executionStore: fx.executionStore,
        validations: new ValidationService(fx.db, createProductionValidatorRegistry()),
        clock,
      },
      {
        companyId: fx.companyId,
        projectId: fx.projectId,
        workflowId: "forge.company.requirement-research",
        briefId: newerBrief.id,
        idempotencyKey: "essay-idea",
      },
    );
    // Fail every ready branch on the newer idea so the run becomes terminal while the older idea waits.
    for (let i = 0; i < 8; i += 1) {
      const claimed = fx.executionStore.claimNextStep(newer.runId, "test-worker", clock.now());
      if (!claimed) break;
      fx.executionStore.finishAttempt(
        claimed.id,
        {
          state: "failed",
          error: { code: "BUDGET_EXCEEDED", message: "BUDGET_EXCEEDED", retryable: false },
        },
        clock.now(),
      );
    }
    expect(fx.executionStore.getRun(newer.runId)?.state).toBe("failed");

    const scoped = getCompanyResearchWorkflowStatus(
      { db: fx.db, executionStore: fx.executionStore },
      { companyId: fx.companyId, projectId: fx.projectId },
    );
    expect(scoped.briefId).toBe(newerBrief.id);
    expect(scoped.workflowRunId).toBe(newer.runId);
    expect(scoped.runState).toBe("failed");
    expect(scoped.synthesisRecommendation).toBeNull();
    expect(scoped.waitingAtGate).toBe(false);

    expect(getCompanyResearchWorkflowStatus(
      { db: fx.db, executionStore: fx.executionStore },
      { companyId: fx.companyId, projectId: fx.projectId, briefId: fx.briefId },
    )).toMatchObject({
      briefId: fx.briefId,
      waitingAtGate: true,
      synthesisRecommendation: "enter_product_definition",
    });
  });

  it("does not let a stale research approval satisfy a later research run's gate", async () => {
    const fx = await researchExecutorFixture();
    await fx.completeThroughSynthesis();
    await fx.run("research-gate");
    fx.decideViaCoordinator("coordinated-old", "approved");
    fx.resumeActiveGateWait();
    expect((await fx.run("research-gate")).state).toBe("succeeded");

    advanceClock(60_000);
    const second = await fx.startAnotherRun("idea-2");
    expect(second.runId).not.toBe(fx.started.runId);
    await fx.completeThroughSynthesis(second.runId);
    advanceClock(1_000);
    const waiting = await fx.run("research-gate", second.runId);
    expect(waiting).toMatchObject({ state: "waiting", waitRef: researchGateWaitRef(fx.projectId) });

    // A spurious resume still cannot pass on the old decision.
    expect(fx.resumeActiveGateWait()).toBe(1);
    expect((await fx.run("research-gate", second.runId)).state).toBe("waiting");

    advanceClock(1_000);
    const fresh = fx.decideViaCoordinator("coordinated-new", "approved");
    expect(fx.resumeActiveGateWait()).toBe(1);
    const done = await fx.run("research-gate", second.runId);
    expect(done.state).toBe("succeeded");
    expect(fx.readOutput((done as { outputRef: string }).outputRef)).toMatchObject({ decisionId: fresh.id });
  });
});
