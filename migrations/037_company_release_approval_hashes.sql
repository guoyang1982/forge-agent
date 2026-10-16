ALTER TABLE company_release_candidates
  ADD COLUMN checkpoint_hash TEXT NOT NULL DEFAULT '';

ALTER TABLE company_release_candidates
  ADD COLUMN candidate_hash TEXT NOT NULL DEFAULT '';

ALTER TABLE company_release_candidates
  ADD COLUMN approval_candidate_hash TEXT;

ALTER TABLE company_release_candidates
  ADD COLUMN approval_checkpoint_hash TEXT;
