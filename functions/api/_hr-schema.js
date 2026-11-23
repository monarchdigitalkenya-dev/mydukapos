// functions/api/_hr-schema.js — Staff & HR records (zip 328). The D1 schema of the HR extension of Create Payroll. Single source of truth, like _payroll-schema.js:
//   * the server creates any missing table on first use (ensureHrSchema in _hr.js);
//   * migrations/0017_hr.sql is GENERATED from this list by `npm run gen:migration` (a test fails if the two ever differ).
// Nothing here changes an existing table: the new facts about a person live in a one-to-one side table (pr_emp_hr), so every existing employee, run,
// payslip and audit row stays exactly as it was, and the migration can be run twice.
export const HR_SCHEMA_VERSION = 2;

export const HR_SCHEMA = [
  // One row per employee that has had HR details saved. No row = a legacy employee (treated as before: salary is "set").
  `CREATE TABLE IF NOT EXISTS pr_emp_hr (
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
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_pr_emp_hr_end ON pr_emp_hr (client_id, end_date)`,

  // What applied to a person at a given time: branch, role / title, cadre, department, employment terms, dates, status, salary. Append-only.
  `CREATE TABLE IF NOT EXISTS pr_emp_history (
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
)`,
  `CREATE INDEX IF NOT EXISTS ix_pr_emp_history_emp ON pr_emp_history (client_id, emp_id, at)`,
  `CREATE TRIGGER IF NOT EXISTS pr_emp_history_no_update BEFORE UPDATE ON pr_emp_history BEGIN SELECT RAISE(ABORT, 'employee_history_is_append_only'); END`,
  `CREATE TRIGGER IF NOT EXISTS pr_emp_history_no_delete BEFORE DELETE ON pr_emp_history BEGIN SELECT RAISE(ABORT, 'employee_history_is_append_only'); END`,

  // Extra facts about a recurring earning / deduction (pr_pay_lines): when it applies, why, and whether it is approved. No row = approved, always on (as before).
  `CREATE TABLE IF NOT EXISTS pr_line_meta (
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
) WITHOUT ROWID`,

  // Settings of the HR module for one business (timezone, report schedule, deduction approval ...).
  `CREATE TABLE IF NOT EXISTS pr_settings (
  client_id TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, k)
) WITHOUT ROWID`,

  // Staff reports: one per person per period per VERSION. The scheduled job only ever writes version 1 (INSERT OR IGNORE on the unique key), so the same
  // report is never made twice; a manual regeneration adds the next version and the older ones stay readable.
  `CREATE TABLE IF NOT EXISTS pr_reports (
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
) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pr_reports_version ON pr_reports (client_id, emp_id, period_kind, period_start, version)`,
  `CREATE INDEX IF NOT EXISTS ix_pr_reports_period ON pr_reports (client_id, period_kind, period_start)`,

  // One row per business per period kind per period: did the job run, did it fail, how many reports. Drives the dashboard and the safe retry.
  `CREATE TABLE IF NOT EXISTS pr_report_jobs (
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
) WITHOUT ROWID`,
];

// zip 334: any number of labelled registration numbers per person (ID, driving licence, employment ID, KRA PIN, NSSF, SHA, passport, phone numbers ...).
// All optional. One row per number; the person keeps as many as they like. Generated into migrations/0018_hr_numbers.sql.
export const HR_SCHEMA_0018 = [
  `CREATE TABLE IF NOT EXISTS pr_emp_numbers (
  client_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  num_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  label TEXT,
  value TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, emp_id, num_id)
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_pr_emp_numbers_emp ON pr_emp_numbers (client_id, emp_id, sort)`,
];
