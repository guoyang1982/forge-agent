CREATE TABLE IF NOT EXISTS company_employee_profiles (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  employee_id TEXT NOT NULL,
  talent_template_id TEXT NOT NULL,
  talent_role TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, employee_id),
  FOREIGN KEY (company_id, employee_id)
    REFERENCES company_employees(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_employee_workspaces (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  employee_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
  is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (company_id, employee_id, workspace_id),
  FOREIGN KEY (company_id, employee_id)
    REFERENCES company_employees(company_id, id)
);
