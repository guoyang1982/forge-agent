import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CompanyService, OrganizationService, WorkService, WorkGates, applyCompanyRunTerminalEvent } from "@forge/company-domain";
import { AgentProfileStore } from "@forge/agent-profile";
import { ArtifactService } from "@forge/evidence";
import { DurableExecutor, ExecutionStore, ForgeAgentStepExecutor, StepExecutorRegistry } from "@forge/execution";
import { ForgeStore } from "@forge/store";
import { BudgetLedgerService } from "@forge/usage-ledger";
import { WorkspaceGroupService, WorkspaceLeaseService } from "@forge/workspace";
import { TypedRouter } from "./host/router.js";
import { createCompanyModule } from "./modules/company-module.js";
import { persistForgeRunResult } from "./services/forge-run-results.js";
import { hireNamed, rpcContext } from "./company-p1-e2e-fixture.js";

const roots: string[] = [];
const stores = new Set<ForgeStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Real RPC handlers, durable scheduling, result persistence, and terminal-event
// application; only the model run is deterministic. This is not an Electron test.
function openJourney(root: string) {
  const store = ForgeStore.open({ dbPath: join(root, "data.db"), migrationsDir: join(dirname(fileURLToPath(import.meta.url)), "../../../migrations"), owner: "test" });
  stores.add(store);
  let time = Date.parse("2026-09-16T00:00:00Z");
  const clock = { now: () => new Date(time++).toISOString(), nowMs: () => time++ };
  const company = { companies: new CompanyService(store.db, clock), org: new OrganizationService(store.db, clock), work: new WorkService(store.db, clock), gates: new WorkGates(store.db, clock) };
  const executionStore = new ExecutionStore(store.db);
  const context = {
    socketPath: join(root, "daemon.sock"), store, company, executionStore,
    executionClock: clock, serverVersion: "test", build: "journey",
    artifacts: new ArtifactService(store.db, join(root, "artifacts")),
    agentProfiles: new AgentProfileStore(store.db), budgetLedger: new BudgetLedgerService(store.db),
    workspaceGroups: new WorkspaceGroupService(store.db), workspaceLeases: new WorkspaceLeaseService(store.db),
    wakeExecutor: () => {},
  };
  const router = new TypedRouter();
  createCompanyModule({ generateDraft: async () => { throw new Error("draft model is not configured"); }, listSharedProjects: () => [{ id: "journey-ws", name: "Journey", cwd: join(root, "workspace") }], listModelProfiles: () => [] }).register(router, context);
  const control = { fail: false, report: "# 调研报告\n## 一句话结论\n先访谈五位用户。\n## 关键依据\n演示样本，仅用于测试。\n## 风险\n样本不足。\n## 下一步建议\n补充访谈。", calls: 0 };
  const registry = new StepExecutorRegistry();
  registry.register(new ForgeAgentStepExecutor({
    run: async (request) => {
      control.calls++;
      if (control.fail) throw new Error("deterministic research failure");
      expect(request.message).toContain("Accepted plan");
      writeFileSync(join(root, "workspace", "report.md"), control.report);
      return { sessionId: `journey-${control.calls}`, finalText: control.report };
    },
    persistResult: (result) => persistForgeRunResult(store.db, result),
  }));
  const executor = new DurableExecutor(executionStore, registry, clock);
  const rpc = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) =>
    await router.handleUntyped(method, params, rpcContext()) as T;
  const relayTerminal = (runId: string) => {
    const event = store.db.prepare("SELECT event_type AS type, run_id AS runId FROM core_events WHERE run_id = ? AND event_type IN ('run.succeeded','run.failed','run.cancelled') ORDER BY rowid DESC LIMIT 1").get(runId) as { type: string; runId: string } | undefined;
    expect(event).toBeDefined();
    applyCompanyRunTerminalEvent(company.gates, event!);
    context.workspaceLeases.releaseByRunId(runId);
  };
  return { root, store, company, control, executor, executionStore, rpc, relayTerminal, close() { store.close(); stores.delete(store); } };
}

type Item = { id: string; state: string; projectId: string; trace: { outputs: Array<{ id: string; content?: string }> }; openFix?: { id: string } };

describe("company RPC user journey", () => {
  it("persists a research result across restart, approves it, and runs isolated supplementary research", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-company-journey-")); roots.push(root);
    let fx = openJourney(root);
    const company = await fx.rpc<{ id: string }>("company.create", { name: "Journey" });
    const reviewer = hireNamed(fx.company, company.id, "Reviewer");
    const researcher = hireNamed(fx.company, company.id, "Researcher");
    const workspace = join(root, "workspace"); mkdirSync(workspace);
    fx.store.db.prepare("INSERT INTO core_workspaces (id, root_path, canonical_root_path, label, created_at, updated_at) VALUES ('journey-ws', ?, ?, 'journey', ?, ?)").run(workspace, workspace, new Date().toISOString(), new Date().toISOString());
    await fx.rpc("company.employees.bind", { companyId: company.id, employeeId: researcher.id, talentTemplateId: "talent.researcher", talentRole: "Researcher", skills: [], tools: [], workspaces: [{ workspaceId: "journey-ws", mode: "write", isDefault: true }] });
    const goal = await fx.rpc<{ id: string }>("company.goals.create", { companyId: company.id, title: "Investigate demand", ownerId: reviewer.id });
    const project = await fx.rpc<{ id: string }>("company.projects.create", { companyId: company.id, goalId: goal.id, title: "Primary project" });
    const otherProject = await fx.rpc<{ id: string }>("company.projects.create", { companyId: company.id, goalId: goal.id, title: "Separate project" });
    const createResearch = async (projectId: string, title: string) => {
      const item = await fx.rpc<Item>("company.workItems.create", { companyId: company.id, projectId, goalId: goal.id, type: "research", title, problem: "Should we build this?", targetUser: "Founders", expectedOutcome: "Evidence and next steps", ownerId: reviewer.id });
      for (const kind of ["spec", "plan"]) {
        const artifact = await fx.rpc<{ id: string }>("company.workArtifacts.upsert", { workItemId: item.id, kind, content: `${title}: ${kind} with explicit scope`, actorId: reviewer.id });
        await fx.rpc("company.workArtifacts.accept", { artifactId: artifact.id, actorId: reviewer.id });
      }
      await fx.rpc("company.workItems.dispatch", { workItemId: item.id, assigneeId: researcher.id, actorId: reviewer.id });
      return item;
    };
    const structured = { schemaVersion: 1, conclusion: "先访谈五位用户", evidence: [{ claim: "演示样本", source: "fixture:sample" }], risks: ["样本不足"], unknowns: ["付费意愿"], nextActions: ["补充访谈"] };
    fx.control.report += "\n```forge-research-result\n" + JSON.stringify(structured) + "\n```";
    const initial = await createResearch(project.id, "Initial research");
    const run = await fx.rpc<{ runId: string }>("company.workItems.requestRun", { workItemId: initial.id });
    await expect(fx.rpc("company.workItems.requestRun", { workItemId: initial.id })).rejects.toThrow("active run");
    await fx.executor.tick(); fx.relayTerminal(run.runId);
    expect(fx.executionStore.getRun(run.runId)?.state).toBe("succeeded");
    const detail = await fx.rpc<Item>("company.workItems.get", { workItemId: initial.id });
    expect(detail.state).toBe("waiting_approval");
    const report = detail.trace.outputs.find((output) => output.content === fx.control.report)!;
    expect(report).toBeDefined();
    expect(report).toMatchObject({ researchResult: { conclusion: structured.conclusion, source: { runId: run.runId } } });
    const expectedReport = fx.control.report;
    fx.close(); fx = openJourney(root);
    const saved = await fx.rpc("company.workOutputs.read", { companyId: company.id, workItemId: initial.id, outputId: report.id });
    expect(saved).toMatchObject({ previewable: true, content: expectedReport });
    expect(fx.control.calls).toBe(0);
    const restored = await fx.rpc<Item>("company.workItems.get", { workItemId: initial.id });
    expect(restored.trace.outputs).toEqual(expect.arrayContaining([expect.objectContaining({ researchResult: expect.objectContaining({ conclusion: structured.conclusion }) })]));
    await expect(fx.rpc("company.approvals.decide", { workItemId: initial.id, actorId: researcher.id, decision: "approved" })).rejects.toThrow("own work");
    expect(await fx.rpc("company.approvals.decide", { workItemId: initial.id, actorId: reviewer.id, decision: "approved", reason: "Evidence reviewed; supplement interviews." })).toMatchObject({ state: "completed" });
    const unrelated = await createResearch(otherProject.id, "Unrelated research");
    await expect(fx.rpc("company.workOutputs.read", { companyId: company.id, workItemId: unrelated.id, outputId: report.id })).rejects.toThrow("artifact not found");
    const supplement = await createResearch(project.id, "Supplementary interviews");
    fx.control.report = "# Supplementary research\nFive interview questions are ready.";
    const supplementaryRun = await fx.rpc<{ runId: string }>("company.workItems.requestRun", { workItemId: supplement.id });
    await fx.executor.tick(); fx.relayTerminal(supplementaryRun.runId);
    const supplementaryDetail = await fx.rpc<Item>("company.workItems.get", { workItemId: supplement.id });
    expect(supplementaryDetail.projectId).toBe(project.id);
    expect(supplementaryDetail.trace.outputs).toEqual(expect.arrayContaining([expect.objectContaining({ content: fx.control.report })]));
    expect(await fx.rpc("company.workOutputs.read", { companyId: company.id, workItemId: initial.id, outputId: report.id })).toMatchObject({ content: expectedReport });

    // Failure and cancellation exercise real durable run transitions and the
    // production Company event adapter, then retry through the same RPC.
    fx.control.fail = true;
    const failed = await fx.rpc<{ runId: string }>("company.workItems.requestRun", { workItemId: unrelated.id });
    await fx.executor.tick(); fx.relayTerminal(failed.runId);
    expect(fx.executionStore.getRun(failed.runId)?.state).toBe("failed");
    expect(await fx.rpc<Item>("company.workItems.get", { workItemId: unrelated.id })).toMatchObject({ state: "blocked", openFix: expect.objectContaining({ id: expect.any(String) }) });
    const cancelled = await fx.rpc<{ runId: string }>("company.workItems.requestRun", { workItemId: unrelated.id });
    fx.executor.cancelRun(cancelled.runId, "User stopped research"); fx.relayTerminal(cancelled.runId);
    expect(fx.executionStore.getRun(cancelled.runId)?.state).toBe("cancelled");
    expect(await fx.rpc<Item>("company.workItems.get", { workItemId: unrelated.id })).toMatchObject({ state: "blocked" });
    fx.control.fail = false;
    const recovered = await fx.rpc<{ runId: string }>("company.workItems.requestRun", { workItemId: unrelated.id });
    await fx.executor.tick(); fx.relayTerminal(recovered.runId);
    expect(fx.executionStore.getRun(recovered.runId)?.state).toBe("succeeded");
    expect(await fx.rpc<Item>("company.workItems.get", { workItemId: unrelated.id })).toMatchObject({ state: "waiting_approval" });
  });
});
