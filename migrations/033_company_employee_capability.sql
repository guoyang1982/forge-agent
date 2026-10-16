ALTER TABLE company_employee_profiles ADD COLUMN agent_profile_id TEXT;
ALTER TABLE company_employee_profiles ADD COLUMN agent_profile_version_id TEXT;
ALTER TABLE company_employee_profiles ADD COLUMN system_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE company_employee_profiles ADD COLUMN methodology_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE company_employee_profiles ADD COLUMN quality_gates_json TEXT NOT NULL DEFAULT '[]';
