import type Database from "better-sqlite3";
import type { Clock } from "../clock.js";
import { newCompanyId } from "../ids.js";
import type { ResearchBrief } from "./types.js";

export type IntakeInput = {
  problem: string;
  targetUser: string;
  expectedOutcome: string;
  constraints?: string[];
};

export type IntakeAssessment = {
  ready: boolean;
  missingFields: Array<keyof IntakeInput>;
  normalizedProblem: string;
  researchQuestions: string[];
  suggestedStopConditions: string[];
};

export type AcceptBriefInput = IntakeInput & {
  companyId: string;
  workItemId: string;
};

const MAX_FIELD_LENGTH = 4000;

const MISSING_FIELD_QUESTIONS: Record<
  "problem" | "targetUser" | "expectedOutcome",
  string
> = {
  problem: "What problem should research address?",
  targetUser: "Who is the target user or audience?",
  expectedOutcome: "What measurable outcome defines success?",
};

const READY_STOP_CONDITIONS = [
  "Open research questions are answered or explicitly deferred",
  "Scope boundaries and constraints are agreed",
];

export function assessIntake(input: IntakeInput): IntakeAssessment {
  assertFieldSizes(input);

  const missingFields = requiredMissingFields(input);
  const normalizedProblem = collapseWhitespace(input.problem);
  const constraints = input.constraints ?? [];
  const conflict = hasConstraintConflict(constraints);

  const researchQuestions: string[] = [];
  for (const field of missingFields) {
    if (field === "problem" || field === "targetUser" || field === "expectedOutcome") {
      researchQuestions.push(MISSING_FIELD_QUESTIONS[field]);
    }
  }
  if (conflict) {
    researchQuestions.push(
      "Resolve conflicting constraints before research can proceed.",
    );
  }
  if (missingFields.length === 0 && !conflict) {
    researchQuestions.push(
      "What evidence would validate the expected outcome?",
    );
  }

  const ready = missingFields.length === 0 && !conflict;

  return {
    ready,
    missingFields,
    normalizedProblem,
    researchQuestions,
    suggestedStopConditions: ready ? [...READY_STOP_CONDITIONS] : [],
  };
}

export function acceptBrief(
  db: Database.Database,
  clock: Clock,
  input: AcceptBriefInput,
): ResearchBrief {
  const assessment = assessIntake(input);
  const version =
    (db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) AS max_version
         FROM company_research_briefs
         WHERE company_id = ? AND work_item_id = ?`,
      )
      .get(input.companyId, input.workItemId) as { max_version: number })
      .max_version + 1;

  const id = newCompanyId("brief");
  const now = clock.now();
  const constraints = input.constraints ?? [];

  db.prepare(
    `INSERT INTO company_research_briefs (
      id, company_id, work_item_id, version, normalized_problem,
      target_user, expected_outcome, constraints_json,
      research_questions_json, stop_conditions_json, ready,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.companyId,
    input.workItemId,
    version,
    assessment.normalizedProblem,
    input.targetUser.trim(),
    input.expectedOutcome.trim(),
    JSON.stringify(constraints),
    JSON.stringify(assessment.researchQuestions),
    JSON.stringify(assessment.suggestedStopConditions),
    assessment.ready ? 1 : 0,
    now,
    now,
  );

  return {
    id,
    companyId: input.companyId,
    workItemId: input.workItemId,
    version,
    normalizedProblem: assessment.normalizedProblem,
    targetUser: input.targetUser.trim(),
    expectedOutcome: input.expectedOutcome.trim(),
    constraints,
    researchQuestions: assessment.researchQuestions,
    stopConditions: assessment.suggestedStopConditions,
    ready: assessment.ready,
    createdAt: now,
    updatedAt: now,
  };
}

function requiredMissingFields(input: IntakeInput): Array<keyof IntakeInput> {
  const missing: Array<keyof IntakeInput> = [];
  if (!input.problem.trim()) missing.push("problem");
  if (!input.targetUser.trim()) missing.push("targetUser");
  if (!input.expectedOutcome.trim()) missing.push("expectedOutcome");
  return missing;
}

function assertFieldSizes(input: IntakeInput): void {
  for (const value of [
    input.problem,
    input.targetUser,
    input.expectedOutcome,
    ...(input.constraints ?? []),
  ]) {
    if (value.length > MAX_FIELD_LENGTH) {
      throw new Error("intake too large");
    }
  }
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function hasConstraintConflict(constraints: string[]): boolean {
  const must = new Set<string>();
  const mustNot = new Set<string>();

  for (const constraint of constraints) {
    const parsed = parseConstraintPolarity(constraint);
    if (!parsed) continue;
    if (parsed.polarity === "must") {
      if (mustNot.has(parsed.subject)) return true;
      must.add(parsed.subject);
    } else {
      if (must.has(parsed.subject)) return true;
      mustNot.add(parsed.subject);
    }
  }
  return false;
}

function parseConstraintPolarity(
  constraint: string,
): { polarity: "must" | "must_not"; subject: string } | null {
  const trimmed = constraint.trim();
  const mustNot = /^must\s+not\s+(.+)$/i.exec(trimmed);
  if (mustNot) {
    return {
      polarity: "must_not",
      subject: normalizeConstraintSubject(mustNot[1]),
    };
  }
  const must = /^must\s+(.+)$/i.exec(trimmed);
  if (must) {
    return {
      polarity: "must",
      subject: normalizeConstraintSubject(must[1]),
    };
  }
  return null;
}

function normalizeConstraintSubject(subject: string): string {
  return subject.trim().replace(/\s+/g, " ").toLowerCase();
}
