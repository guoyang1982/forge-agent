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
  parent_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, parent_id)
    REFERENCES company_departments(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_position_templates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  name TEXT NOT NULL,
  charter TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS company_positions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  department_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, department_id)
    REFERENCES company_departments(company_id, id),
  FOREIGN KEY (company_id, template_id)
    REFERENCES company_position_templates(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_employees (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  display_name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS company_employments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  employee_id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'ended')),
  autonomy_level INTEGER NOT NULL CHECK (autonomy_level BETWEEN 0 AND 4),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id, employee_id)
    REFERENCES company_employees(company_id, id),
  FOREIGN KEY (company_id, position_id)
    REFERENCES company_positions(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_reporting_lines (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  employee_id TEXT NOT NULL,
  manager_employee_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id, employee_id)
    REFERENCES company_employees(company_id, id),
  FOREIGN KEY (company_id, manager_employee_id)
    REFERENCES company_employees(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_goals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, owner_id)
    REFERENCES company_employees(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_projects (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  goal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, goal_id)
    REFERENCES company_goals(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_project_teams (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  project_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id, project_id)
    REFERENCES company_projects(company_id, id),
  FOREIGN KEY (company_id, employee_id)
    REFERENCES company_employees(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_work_items (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  goal_id TEXT,
  project_id TEXT,
  parent_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('intent', 'implementation', 'fix', 'research')),
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  expected_outcome TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  assignee_id TEXT,
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
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, goal_id)
    REFERENCES company_goals(company_id, id),
  FOREIGN KEY (company_id, project_id)
    REFERENCES company_projects(company_id, id),
  FOREIGN KEY (company_id, parent_id)
    REFERENCES company_work_items(company_id, id),
  FOREIGN KEY (company_id, owner_id)
    REFERENCES company_employees(company_id, id),
  FOREIGN KEY (company_id, assignee_id)
    REFERENCES company_employees(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_work_dependencies (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  work_item_id TEXT NOT NULL,
  depends_on_work_item_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id, work_item_id)
    REFERENCES company_work_items(company_id, id),
  FOREIGN KEY (company_id, depends_on_work_item_id)
    REFERENCES company_work_items(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_handoffs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  work_item_id TEXT NOT NULL,
  from_employee_id TEXT NOT NULL,
  to_employee_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id, work_item_id)
    REFERENCES company_work_items(company_id, id),
  FOREIGN KEY (company_id, from_employee_id)
    REFERENCES company_employees(company_id, id),
  FOREIGN KEY (company_id, to_employee_id)
    REFERENCES company_employees(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_work_artifacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  work_item_id TEXT NOT NULL,
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
  UNIQUE (company_id, id),
  UNIQUE (work_item_id, kind, version),
  FOREIGN KEY (company_id, work_item_id)
    REFERENCES company_work_items(company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_company_work_artifacts_item
  ON company_work_artifacts(work_item_id, kind, status);

CREATE TABLE IF NOT EXISTS company_decisions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  work_item_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (company_id, work_item_id)
    REFERENCES company_work_items(company_id, id),
  FOREIGN KEY (company_id, employee_id)
    REFERENCES company_employees(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_run_links (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  work_item_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  plan_artifact_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (company_id, work_item_id)
    REFERENCES company_work_items(company_id, id),
  FOREIGN KEY (company_id, plan_artifact_id)
    REFERENCES company_work_artifacts(company_id, id)
);
