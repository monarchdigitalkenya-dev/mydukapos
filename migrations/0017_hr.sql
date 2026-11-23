-- GENERATED from functions/api/_hr-schema.js by tools/gen-migration.mjs — do not edit by hand.
-- Staff & HR records (zip 328): a side table for employment details, employee history, deduction approval, staff reports. Needs 0010_payroll.sql applied first. Safe to run more than once (IF NOT EXISTS); changes no existing table and no existing row.

CREATE TABLE IF NOT EXISTS pr_emp_hr (
  client_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  cadre TEXT,
  designation TEXT,
  supervisor_emp_id TEXT,
  supervisor_name TEXT,
  employment_basis TEXT NOT NULL DEFAULT 'permanent' CHECK (employment_basis IN ('permanent','contract','intern')),
  work_schedule TEXT NOT NULL DEFAULT 'full_time' CHECK (work_schedule IN ('full_time','part_time')),
  end_date TEXT,
  internship_months INTEGER,
  salary_state TEXT NOT NULL DEFAULT 'unset' CHECK (salary_state IN ('unset','set')),
  salary_effective TEXT,
  branch_ids TEXT,
  end_note TEXT,
  deactivated_at INTEGER,
  deactivated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, emp_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_pr_emp_hr_end ON pr_emp_hr (client_id, end_date);

CREATE TABLE IF NOT EXISTS pr_emp_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  effective_date TEXT,
  actor_id TEXT,
  actor_name TEXT,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);

CREATE INDEX IF NOT EXISTS ix_pr_emp_history_emp ON pr_emp_history (client_id, emp_id, at);

CREATE TRIGGER IF NOT EXISTS pr_emp_history_no_update BEFORE UPDATE ON pr_emp_history BEGIN SELECT RAISE(ABORT, 'employee_history_is_append_only'); END;

CREATE TRIGGER IF NOT EXISTS pr_emp_history_no_delete BEFORE DELETE ON pr_emp_history BEGIN SELECT RAISE(ABORT, 'employee_history_is_append_only'); END;

CREATE TABLE IF NOT EXISTS pr_line_meta (
  client_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  effective_from TEXT,
  effective_to TEXT,
  period TEXT,
  reference TEXT,
  reason TEXT,
  approval TEXT NOT NULL DEFAULT 'approved' CHECK (approval IN ('approved','pending','rejected')),
  approved_by TEXT,
  approved_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, emp_id, line_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pr_settings (
  client_id TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, k)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS pr_reports (
  client_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  period_kind TEXT NOT NULL CHECK (period_kind IN ('weekly','monthly')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  generated_at INTEGER NOT NULL,
  generated_by TEXT NOT NULL,
  tz TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY (client_id, report_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_pr_reports_version ON pr_reports (client_id, emp_id, period_kind, period_start, version);

CREATE INDEX IF NOT EXISTS ix_pr_reports_period ON pr_reports (client_id, period_kind, period_start);

CREATE TABLE IF NOT EXISTS pr_report_jobs (
  client_id TEXT NOT NULL,
  period_kind TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','partial','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  generated INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (client_id, period_kind, period_start)
) WITHOUT ROWID;

INSERT INTO pr_meta (k, v) VALUES ('hr_schema', '1') ON CONFLICT (k) DO UPDATE SET v = excluded.v;
