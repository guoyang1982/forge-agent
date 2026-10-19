CREATE TABLE IF NOT EXISTS company_employee_memories (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  employee_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lesson', 'gate', 'standing')),
  content TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source_work_item_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (company_id, employee_id)
    REFERENCES company_employees(company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_company_employee_memories_employee
  ON company_employee_memories(company_id, employee_id, created_at);
