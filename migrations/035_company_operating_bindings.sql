ALTER TABLE company_employee_workspaces
  ADD COLUMN env TEXT NOT NULL DEFAULT 'dev';

ALTER TABLE company_employee_profiles
  ADD COLUMN knowledge_refs_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE company_employee_profiles
  ADD COLUMN connectors_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS company_budget_bindings (
  company_id TEXT PRIMARY KEY REFERENCES company_companies(id),
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_project_workspace_groups (
  project_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (company_id, project_id)
    REFERENCES company_projects(company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_company_project_workspace_groups_company
  ON company_project_workspace_groups(company_id);
