ALTER TABLE company_projects ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'completed'));
