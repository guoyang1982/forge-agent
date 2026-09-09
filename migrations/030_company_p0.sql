CREATE TABLE IF NOT EXISTS company_companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_departments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES company_departments(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_position_templates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  name TEXT NOT NULL,
  charter TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_positions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  department_id TEXT NOT NULL REFERENCES company_departments(id),
  template_id TEXT NOT NULL REFERENCES company_position_templates(id),
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_employees (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  display_name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_employments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  employee_id TEXT NOT NULL REFERENCES company_employees(id),
  position_id TEXT NOT NULL REFERENCES company_positions(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'ended')),
  autonomy_level INTEGER NOT NULL CHECK (autonomy_level BETWEEN 0 AND 4),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_reporting_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  employee_id TEXT NOT NULL REFERENCES company_employees(id),
  manager_employee_id TEXT NOT NULL REFERENCES company_employees(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_goals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES company_employees(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_projects (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  goal_id TEXT NOT NULL REFERENCES company_goals(id),
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_project_teams (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  project_id TEXT NOT NULL REFERENCES company_projects(id),
  employee_id TEXT NOT NULL REFERENCES company_employees(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_work_items (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  goal_id TEXT REFERENCES company_goals(id),
  project_id TEXT REFERENCES company_projects(id),
  parent_id TEXT REFERENCES company_work_items(id),
  type TEXT NOT NULL CHECK (type IN ('intent', 'implementation', 'fix', 'research')),
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  expected_outcome TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES company_employees(id),
  assignee_id TEXT REFERENCES company_employees(id),
  state TEXT NOT NULL CHECK (
    state IN (
      'draft',
      'ready',
      'in_progress',
      'waiting_input',
      'waiting_approval',
      'blocked',
      'submitted',
      'verifying',
      'accepted',
      'rejected',
      'completed',
      'cancelled'
    )
  ),
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  autonomy_level INTEGER NOT NULL CHECK (autonomy_level BETWEEN 0 AND 4),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_work_dependencies (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  work_item_id TEXT NOT NULL REFERENCES company_work_items(id),
  depends_on_work_item_id TEXT NOT NULL REFERENCES company_work_items(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_handoffs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  work_item_id TEXT NOT NULL REFERENCES company_work_items(id),
  from_employee_id TEXT NOT NULL REFERENCES company_employees(id),
  to_employee_id TEXT NOT NULL REFERENCES company_employees(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_work_artifacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  work_item_id TEXT NOT NULL REFERENCES company_work_items(id),
  kind TEXT NOT NULL CHECK (kind IN ('intent', 'spec', 'plan')),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'accepted', 'superseded')),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  workspace_path TEXT,
  accepted_at TEXT,
  accepted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_item_id, kind, version)
);

CREATE INDEX IF NOT EXISTS idx_company_work_artifacts_item
  ON company_work_artifacts(work_item_id, kind, status);

CREATE TABLE IF NOT EXISTS company_decisions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  work_item_id TEXT NOT NULL REFERENCES company_work_items(id),
  employee_id TEXT NOT NULL REFERENCES company_employees(id),
  decision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_run_links (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  work_item_id TEXT NOT NULL REFERENCES company_work_items(id),
  run_id TEXT NOT NULL,
  plan_artifact_id TEXT REFERENCES company_work_artifacts(id),
  created_at TEXT NOT NULL
);
