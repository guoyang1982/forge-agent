import type Database from "better-sqlite3";
import type {
  StageGateDecision,
  StageGateKind,
  StageGateNextAction,
  StageGateOutcome,
} from "./types.js";

export type { StageGateNextAction } from "./types.js";
export type DecidedStageGate = StageGateDecision;
export type DecideStageGateInput = Omit<StageGateDecision, "nextAction"> & {
  companyId: string;
  projectId?: string;
};

type StoredGateRow = {
  decisionJson: string;
};

export class StageGateService {
  constructor(private readonly db: Database.Database) {}

  decide(
    input: DecideStageGateInput,
    currentInputVersionRefs: string[],
  ): StageGateDecision {
    if (!sameRefs(input.inputVersionRefs, currentInputVersionRefs)) {
      throw new Error("gate inputs changed");
    }

    const decision = freezeDecision({
      id: input.id,
      gate: input.gate,
      outcome: input.outcome,
      inputVersionRefs: [...input.inputVersionRefs],
      decidedBy: { ...input.decidedBy },
      rationale: input.rationale,
      impact: input.impact,
      decidedAt: input.decidedAt,
      nextAction: nextAction(input.gate, input.outcome),
    });

    this.db.prepare(
      `INSERT INTO company_stage_gates (
        id, company_id, project_id, gate_kind, outcome,
        input_version_refs_json, decision_json, impact, decided_at
      ) VALUES (
        @id, @companyId, @projectId, @gate, @outcome,
        @inputVersionRefsJson, @decisionJson, @impact, @decidedAt
      )`,
    ).run({
      id: decision.id,
      companyId: input.companyId,
      projectId: input.projectId ?? null,
      gate: decision.gate,
      outcome: decision.outcome,
      inputVersionRefsJson: JSON.stringify(decision.inputVersionRefs),
      decisionJson: JSON.stringify(decision),
      impact: decision.impact,
      decidedAt: decision.decidedAt,
    });

    return decision;
  }

  getLatest(projectId: string, gate: StageGateKind): StageGateDecision | null {
    const row = this.db.prepare(
      `SELECT decision_json AS decisionJson
      FROM company_stage_gates
      WHERE project_id = ? AND gate_kind = ?
      ORDER BY decided_at DESC, rowid DESC
      LIMIT 1`,
    ).get(projectId, gate) as StoredGateRow | undefined;
    if (!row) return null;
    return freezeDecision(JSON.parse(row.decisionJson) as StageGateDecision);
  }
}

function sameRefs(expected: string[], current: string[]): boolean {
  const expectedSet = new Set(expected);
  const currentSet = new Set(current);
  return expectedSet.size === currentSet.size
    && [...expectedSet].every((ref) => currentSet.has(ref));
}

function nextAction(
  gate: StageGateKind,
  outcome: StageGateOutcome,
): StageGateNextAction {
  if (gate === "research" && outcome === "stopped") {
    return "close_research_project";
  }
  if (outcome !== "approved") return "none";
  if (gate === "research") return "enter_product_definition";
  if (gate === "scope" || gate === "technical") {
    return "create_development_work_items";
  }
  return "call_deployment_connector";
}

function freezeDecision(decision: StageGateDecision): StageGateDecision {
  Object.freeze(decision.inputVersionRefs);
  Object.freeze(decision.decidedBy);
  return Object.freeze(decision);
}
