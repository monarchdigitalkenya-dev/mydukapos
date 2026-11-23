-- GENERATED from HR_SCHEMA_0018 in functions/api/_hr-schema.js by tools/gen-migration.mjs — do not edit by hand.
-- Staff registration numbers (zip 334): any number of labelled numbers per person. Needs 0017_hr.sql applied first. Safe to run more than once (IF NOT EXISTS); changes no existing table and no existing row.

CREATE TABLE IF NOT EXISTS pr_emp_numbers (
  client_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  num_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  label TEXT,
  value TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, emp_id, num_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_pr_emp_numbers_emp ON pr_emp_numbers (client_id, emp_id, sort);

INSERT INTO pr_meta (k, v) VALUES ('hr_schema', '2') ON CONFLICT (k) DO UPDATE SET v = excluded.v;
