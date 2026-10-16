import type Database from "better-sqlite3";
import type { Clock } from "./clock.js";
import { newCompanyId } from "./ids.js";

export type EmployeeMemoryKind = "lesson" | "gate" | "standing";

export type EmployeeMemory = {
  id: string;
  companyId: string;
  employeeId: string;
  kind: EmployeeMemoryKind;
  content: string;
  evidenceRefs: string[];
  sourceWorkItemId?: string;
  createdAt: string;
};

export function rememberEmployeeMemory(
  db: Database.Database,
  clock: Clock,
  input: {
    companyId: string;
    employeeId: string;
    kind: EmployeeMemoryKind;
    content: string;
    evidenceRefs?: string[];
    sourceWorkItemId?: string;
  },
): EmployeeMemory {
  const content = input.content.trim();
  if (!content) {
    throw new Error("memory content is required");
  }
  const memory: EmployeeMemory = {
    id: newCompanyId("emp_mem"),
    companyId: input.companyId,
    employeeId: input.employeeId,
    kind: input.kind,
    content,
    evidenceRefs: [...(input.evidenceRefs || [])],
    ...(input.sourceWorkItemId ? { sourceWorkItemId: input.sourceWorkItemId } : {}),
    createdAt: clock.now(),
  };
  db.prepare(
    `INSERT INTO company_employee_memories
      (id, company_id, employee_id, kind, content, evidence_json,
        source_work_item_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    memory.id,
    memory.companyId,
    memory.employeeId,
    memory.kind,
    memory.content,
    JSON.stringify(memory.evidenceRefs),
    memory.sourceWorkItemId ?? null,
    memory.createdAt,
  );
  return memory;
}

export function recallEmployeeMemories(
  db: Database.Database,
  companyId: string,
  employeeId: string,
  limit = 5,
): EmployeeMemory[] {
  const rows = db
    .prepare(
      `SELECT id, company_id AS companyId, employee_id AS employeeId, kind,
        content, evidence_json AS evidenceJson,
        source_work_item_id AS sourceWorkItemId, created_at AS createdAt
      FROM company_employee_memories
      WHERE company_id = ? AND employee_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    )
    .all(companyId, employeeId, limit) as Array<{
    id: string;
    companyId: string;
    employeeId: string;
    kind: EmployeeMemoryKind;
    content: string;
    evidenceJson: string;
    sourceWorkItemId: string | null;
    createdAt: string;
  }>;
  return rows.map(mapMemoryRow);
}

export function listRecentEmployeeMemories(
  db: Database.Database,
  companyId: string,
  perEmployee = 5,
): Map<string, EmployeeMemory[]> {
  const rows = db
    .prepare(
      `SELECT id, company_id AS companyId, employee_id AS employeeId, kind,
        content, evidence_json AS evidenceJson,
        source_work_item_id AS sourceWorkItemId, created_at AS createdAt
      FROM company_employee_memories
      WHERE company_id = ?
      ORDER BY created_at DESC, id DESC`,
    )
    .all(companyId) as Array<{
    id: string;
    companyId: string;
    employeeId: string;
    kind: EmployeeMemoryKind;
    content: string;
    evidenceJson: string;
    sourceWorkItemId: string | null;
    createdAt: string;
  }>;
  const byEmployee = new Map<string, EmployeeMemory[]>();
  for (const row of rows) {
    const list = byEmployee.get(row.employeeId) || [];
    if (list.length >= perEmployee) continue;
    list.push(mapMemoryRow(row));
    byEmployee.set(row.employeeId, list);
  }
  return byEmployee;
}

function mapMemoryRow(row: {
  id: string;
  companyId: string;
  employeeId: string;
  kind: EmployeeMemoryKind;
  content: string;
  evidenceJson: string;
  sourceWorkItemId: string | null;
  createdAt: string;
}): EmployeeMemory {
  return {
    id: row.id,
    companyId: row.companyId,
    employeeId: row.employeeId,
    kind: row.kind,
    content: row.content,
    evidenceRefs: parseStringArray(row.evidenceJson),
    ...(row.sourceWorkItemId ? { sourceWorkItemId: row.sourceWorkItemId } : {}),
    createdAt: row.createdAt,
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
