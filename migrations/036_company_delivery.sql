CREATE TABLE IF NOT EXISTS company_research_briefs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  work_item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  normalized_problem TEXT NOT NULL,
  target_user TEXT NOT NULL DEFAULT '',
  expected_outcome TEXT NOT NULL DEFAULT '',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  research_questions_json TEXT NOT NULL DEFAULT '[]',
  stop_conditions_json TEXT NOT NULL DEFAULT '[]',
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id),
  UNIQUE (company_id, work_item_id, version),
  FOREIGN KEY (company_id, work_item_id)
    REFERENCES company_work_items(company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_company_research_briefs_work_item
  ON company_research_briefs(company_id, work_item_id, version);

CREATE TABLE IF NOT EXISTS company_research_questions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  brief_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dropped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, brief_id)
    REFERENCES company_research_briefs(company_id, id)
);

CREATE TABLE IF NOT EXISTS company_research_claims (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  brief_id TEXT NOT NULL,
  text TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('fact','inference','hypothesis','unknown')),
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  contradictions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, brief_id)
    REFERENCES company_research_briefs(company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_company_research_claims_brief
  ON company_research_claims(company_id, brief_id);

CREATE TABLE IF NOT EXISTS company_stage_gates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  project_id TEXT,
  gate_kind TEXT NOT NULL CHECK (gate_kind IN ('research','scope','technical','release')),
  outcome TEXT NOT NULL CHECK (outcome IN ('approved','rejected','changes_requested','stopped')),
  input_version_refs_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  impact TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id)
    REFERENCES company_projects(company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_company_stage_gates_company
  ON company_stage_gates(company_id, decided_at);

CREATE INDEX IF NOT EXISTS idx_company_stage_gates_lookup
  ON company_stage_gates(company_id, project_id, gate_kind, decided_at);

CREATE TABLE IF NOT EXISTS company_release_candidates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  project_id TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  validation_ids_json TEXT NOT NULL DEFAULT '[]',
  rollback_plan_artifact_id TEXT NOT NULL,
  approval_id TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('draft','validating','waiting_approval','approved','released','rejected')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id)
    REFERENCES company_projects(company_id, id),
  FOREIGN KEY (company_id, rollback_plan_artifact_id)
    REFERENCES company_work_artifacts(company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_company_release_candidates_project
  ON company_release_candidates(company_id, project_id, state);

CREATE TABLE IF NOT EXISTS company_feedback_items (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES company_companies(id),
  project_id TEXT,
  release_candidate_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('release_review','post_release','customer')),
  summary TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id)
    REFERENCES company_projects(company_id, id),
  FOREIGN KEY (company_id, release_candidate_id)
    REFERENCES company_release_candidates(company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_company_feedback_items_project
  ON company_feedback_items(company_id, project_id, created_at);
