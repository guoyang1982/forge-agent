import {
  COMPANY_RESEARCH_WORKFLOW_ID,
  type CompanyResearchClaimView,
  type CompanyResearchRecommendation,
  type CompanyResearchWorkflowStatus,
} from "@forge/protocol";
import { acceptFormalReport, buildResearchDecisionMemo, buildResearchReadingBrief } from "@forge/company-domain";
import type { ExecutionStore } from "@forge/execution";
import type { Database } from "@forge/store";
import { WorkflowStore } from "@forge/workflows";
import { RESEARCH_GATE_KIND, RESEARCH_SYNTHESIS_KIND } from "./company-workflow-executors.js";
import { readForgeRunResult } from "./forge-run-results.js";

const RECOMMENDATIONS: readonly CompanyResearchRecommendation[] = [
  "stop",
  "continue_research",
  "enter_product_definition",
];
const CLAIM_CLASSES = ["fact", "inference", "hypothesis", "unknown"] as const;
const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "cancelled"]);
const MAX_STATUS_CLAIMS = 96;

const EMPTY: CompanyResearchWorkflowStatus = {
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
};

/**
 * Status of one idea's requirement-research workflow on a project.
 * Scoped by briefId (explicit or latest research brief) so an older waiting run
 * never leaks under a newer idea's delivery page.
 */
/** Keep instance.state aligned with the durable run (research had no automation reconciler). */
export function syncCompanyResearchWorkflowInstances(
  db: Database,
  executionStore: Pick<ExecutionStore, "getRun">,
): number {
  const rows = db
    .prepare(
      `SELECT i.id AS instanceId, i.run_id AS runId
       FROM core_workflow_instances i
       WHERE i.workflow_id = ?
         AND i.state IN ('pending', 'running', 'waiting')
         AND i.run_id IS NOT NULL`,
    )
    .all(COMPANY_RESEARCH_WORKFLOW_ID) as Array<{ instanceId: string; runId: string }>;
  const workflows = WorkflowStore.forDatabase(db);
  let updated = 0;
  for (const row of rows) {
    const run = executionStore.getRun(row.runId);
    if (!run || !TERMINAL_RUN_STATES.has(run.state)) continue;
    const state = run.state as "succeeded" | "failed" | "cancelled";
    workflows.updateInstanceState(row.instanceId, state);
    updated += 1;
  }
  return updated;
}

export function getCompanyResearchWorkflowStatus(
  deps: {
    db: Database;
    executionStore: Pick<ExecutionStore, "getRun" | "getStep" | "listAttempts" | "getActiveWait">;
  },
  input: { companyId: string; projectId: string; briefId?: string },
): CompanyResearchWorkflowStatus {
  syncCompanyResearchWorkflowInstances(deps.db, deps.executionStore);
  const briefId = String(input.briefId || "").trim()
    || latestResearchBriefId(deps.db, input.companyId, input.projectId);
  if (!briefId) return { ...EMPTY };

  const prefix = `company-workflow:requirement-research:${input.companyId}:${input.projectId}:`;
  const rows = deps.db
    .prepare(
      `SELECT run_id AS runId
       FROM core_workflow_instances
       WHERE workflow_id = ?
         AND substr(trigger_ref, 1, ?) = ?
         AND run_id IS NOT NULL
         AND (
           concurrency_key = ?
           OR json_extract(input_json, '$.briefId') = ?
         )
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(COMPANY_RESEARCH_WORKFLOW_ID, prefix.length, prefix, briefId, briefId) as Array<{ runId: string }>;

  for (const row of rows) {
    const run = deps.executionStore.getRun(row.runId);
    if (!run) continue;
    // Always take the newest run for this brief — do not skip a failed newer run
    // to surface an older waiting run from another attempt.
    return { ...statusForRun(deps, run.id, run.state, run.spec.steps), briefId };
  }
  return { ...EMPTY, briefId };
}

function latestResearchBriefId(db: Database, companyId: string, projectId: string): string | null {
  const row = db
    .prepare(
      `SELECT b.id AS id
       FROM company_research_briefs b
       INNER JOIN company_work_items w ON w.id = b.work_item_id
       WHERE b.company_id = ?
         AND w.company_id = ?
         AND w.project_id = ?
         AND w.type = 'research'
       ORDER BY b.created_at DESC, b.rowid DESC
       LIMIT 1`,
    )
    .get(companyId, companyId, projectId) as { id: string } | undefined;
  return row?.id ?? null;
}

function statusForRun(
  deps: {
    db: Database;
    executionStore: Pick<ExecutionStore, "getStep" | "listAttempts" | "getActiveWait">;
  },
  runId: string,
  runState: string,
  steps: Array<{ id: string; kind: string }>,
): CompanyResearchWorkflowStatus {
  const gateStep = steps.find((step) => step.kind === RESEARCH_GATE_KIND);
  const synthesisStep = steps.find((step) => step.kind === RESEARCH_SYNTHESIS_KIND);
  const waitingAtGate = Boolean(gateStep && deps.executionStore.getActiveWait(runId, gateStep.id));
  const result: CompanyResearchWorkflowStatus = {
    ...EMPTY,
    workflowRunId: runId,
    runState: waitingAtGate && runState === "running" ? "waiting" : runState,
    waitingAtGate,
    failureReason: runState === "failed" ? firstFailureReason(deps, runId, steps) : null,
  };
  if (!synthesisStep || deps.executionStore.getStep(runId, synthesisStep.id)?.state !== "succeeded") {
    return result;
  }
  const outputRef = deps.executionStore
    .listAttempts(runId, synthesisStep.id)
    .filter((attempt) => attempt.state === "succeeded" && attempt.outputRef)
    .at(-1)?.outputRef;
  const stored = readForgeRunResult(deps.db, outputRef);
  if (!stored) return result;
  try {
    const body = JSON.parse(stored.finalText) as Record<string, unknown>;
    const recommendation = RECOMMENDATIONS.find((value) => value === body.recommendation);
    if (!recommendation) return result;
    const claimViews = toClaimViews(body.claims);
    const conflicts = Array.isArray(body.conflicts) ? body.conflicts.length : 0;
    const unknowns = Array.isArray(body.unknownClaims) ? body.unknownClaims.length : 0;
    // The synthesis output always carries one synthetic recommendation claim.
    const sourceClaims = Math.max(0, claimViews.length - 1);
    const branchConclusions = readBranchConclusions(body, deps.db);
    const decisionBriefZh = typeof body.decisionBriefZh === "string" && body.decisionBriefZh.trim()
      ? body.decisionBriefZh.trim()
      : null;
    const readingBrief = buildResearchReadingBrief({
      recommendation,
      claims: claimViews,
      conflictCount: conflicts,
      unknownCount: unknowns,
      decisionBriefZh,
      branchConclusions,
    });
    const builtMemo = buildResearchDecisionMemo({
      recommendation,
      readingBrief,
      claims: claimViews,
      title: typeof body.ideaTitle === "string" ? body.ideaTitle : undefined,
      evaluatedAt: typeof body.evaluatedAt === "string" ? body.evaluatedAt : undefined,
    });
    const decisionMemo = {
      ...builtMemo,
      attachments: builtMemo.attachments.map((part) => ({
        ...part,
        claims: part.claims.map((claim) => ({
          id: claim.id,
          text: claim.text,
          classification: claim.classification,
          evidenceIds: claim.evidenceIds ?? [],
        })),
      })),
    };
    return {
      ...result,
      synthesisRecommendation: recommendation,
      synthesisSummary: `${recommendationLabel(recommendation)}：基于 ${sourceClaims} 条论断，${conflicts} 处冲突，${unknowns} 项未知。`,
      claimTotal: claimViews.length,
      claims: claimViews.slice(0, MAX_STATUS_CLAIMS),
      readingBrief,
      decisionMemo,
      formalReport: acceptFormalReport(typeof body.formalReport === "string" ? body.formalReport : ""),
    };
  } catch {
    return result;
  }
}

function readBranchConclusions(
  body: Record<string, unknown>,
  db: Database,
): Partial<Record<string, string>> {
  const fromBody = asStringMap(body.branchConclusions);
  if (Object.keys(fromBody).length) return fromBody;
  const refs = asStringMap(body.sourceOutputRefs);
  const rebuilt: Partial<Record<string, string>> = {};
  for (const [stepId, outputRef] of Object.entries(refs)) {
    const stored = readForgeRunResult(db, outputRef);
    if (!stored) continue;
    try {
      const artifact = JSON.parse(stored.finalText) as Record<string, unknown>;
      const written = typeof artifact.conclusionZh === "string" ? artifact.conclusionZh.trim() : "";
      if (written.length >= 40 && /[\u4e00-\u9fff]/.test(written)) {
        rebuilt[stepId] = written;
        continue;
      }
      const claims = Array.isArray(artifact.claims) ? artifact.claims : [];
      const facts = claims.filter((entry) =>
        entry && typeof entry === "object" && (entry as { classification?: string }).classification === "fact",
      ).length;
      const unknownClaims = claims.filter((entry) =>
        entry && typeof entry === "object" && (entry as { classification?: string }).classification === "unknown",
      ).length;
      const unknowns = Array.isArray(artifact.unknowns) ? artifact.unknowns.length : 0;
      const gap = unknowns + unknownClaims;
      rebuilt[stepId] = gap > 0
        ? `判断：本分支有方向但仍不足以直接开工。理由：已收集 ${claims.length} 条论断（事实 ${facts}），仍有 ${gap} 项关键未知。缺口：先补齐未知项与一手验证。`
        : `判断：本分支依据相对完整，可作决策参考。理由：已收集 ${claims.length} 条论断（事实 ${facts}）。缺口：需与其他分支交叉核对。`;
    } catch {
      // skip broken branch artifact
    }
  }
  return rebuilt;
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.trim()) out[key] = entry.trim();
  }
  return out;
}

function toClaimViews(raw: unknown): CompanyResearchClaimView[] {
  if (!Array.isArray(raw)) return [];
  const views: CompanyResearchClaimView[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) continue;
    const classification = CLAIM_CLASSES.find((value) => value === record.classification) ?? "unknown";
    const evidenceIds = Array.isArray(record.evidenceIds)
      ? record.evidenceIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : Array.isArray(record.evidenceRefs)
        ? record.evidenceRefs.flatMap((ref) => {
            if (typeof ref === "string" && ref) return [ref];
            if (ref && typeof ref === "object" && typeof (ref as { id?: unknown }).id === "string") {
              return [(ref as { id: string }).id];
            }
            return [];
          })
        : [];
    views.push({
      id: typeof record.id === "string" && record.id ? record.id : `claim-${views.length}`,
      text,
      classification,
      evidenceIds,
    });
  }
  return views;
}

function firstFailureReason(
  deps: { db: Database },
  runId: string,
  steps: Array<{ id: string }>,
): string | null {
  for (const step of steps) {
    const row = deps.db
      .prepare(
        `SELECT error_json AS errorJson FROM core_attempts
         WHERE run_id = ? AND step_id = ? AND state = 'failed' AND error_json IS NOT NULL
         ORDER BY attempt_number DESC, rowid DESC LIMIT 1`,
      )
      .get(runId, step.id) as { errorJson: string } | undefined;
    if (!row?.errorJson) continue;
    try {
      const err = JSON.parse(row.errorJson) as Record<string, unknown> | string;
      if (typeof err === "string" && err.trim()) return err.trim().slice(0, 240);
      if (!err || typeof err !== "object") continue;
      const code = typeof err.code === "string" ? err.code : "";
      const reason = typeof err.reason === "string"
        ? err.reason
        : typeof err.message === "string"
          ? err.message
          : "";
      const text = [code, reason].filter(Boolean).join(": ");
      if (text) return text.slice(0, 240);
    } catch {
      if (row.errorJson.trim()) return row.errorJson.trim().slice(0, 240);
    }
  }
  return "research run failed";
}

function recommendationLabel(value: CompanyResearchRecommendation): string {
  switch (value) {
    case "enter_product_definition":
      return "调研结论支持进入需求设计";
    case "continue_research":
      return "建议继续补充调研";
    case "stop":
      return "建议暂缓或停止";
    default:
      return value;
  }
}
