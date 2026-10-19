CREATE TABLE company_research_results (
  run_id TEXT NOT NULL REFERENCES core_runs(id),
  output_ref TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, output_ref, report_hash, schema_version)
);
