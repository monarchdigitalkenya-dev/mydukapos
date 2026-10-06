// functions/api/_payroll-schema.js — Create Payroll (zip 216). The D1 schema of the payroll module. Single source of truth:
//   * the server creates any missing table on first use (ensurePayrollSchema in _payroll.js), so a deploy never meets an empty database;
//   * migrations/0010_payroll.sql is GENERATED from this list by `npm run gen:migration` (a test fails if the two ever differ).
// Rules the DATABASE itself enforces (not only the app / API):
//   * a payroll run that is Approved or Paid can never be edited, re-opened or deleted — not its totals, not its lines, not its people.
//     A correction is a NEW run of kind 'adjustment' that points at the original (a reversal, or hand-entered lines);
//   * the payroll audit trail is append-only (no UPDATE, no DELETE);
//   * every table carries client_id (the shop / branch link): one branch can never read or write another branch's payroll.
export const PAYROLL_SCHEMA_VERSION = 2;

export const PAYROLL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pr_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) WITHOUT ROWID`,

  // Counters: employee numbers (EMP-001), run references (PR-202610-001) — one atomic upsert each, so two admins never get the same number.
  `CREATE TABLE IF NOT EXISTS pr_seq (
  client_id TEXT NOT NULL,
  k TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (client_id, k)
) WITHOUT ROWID`,

  // The staff register. pos_staff_id links a person to their POS sign-in (so they can open their OWN payslips and nothing else).
  `CREATE TABLE IF NOT EXISTS pr_employees (
  client_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  emp_no TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  id_number TEXT,
  dob TEXT,
  address TEXT,
  emergency_name TEXT,
  emergency_phone TEXT,
  job_title TEXT,
  department TEXT,
  branch_id TEXT NOT NULL,
  branch_name TEXT,
  start_date TEXT,
  employment_type TEXT NOT NULL DEFAULT 'permanent',
  pay_frequency TEXT NOT NULL DEFAULT 'monthly',
  rate_unit TEXT NOT NULL DEFAULT 'period',
  basic_pay REAL NOT NULL DEFAULT 0,
  pay_method TEXT,
  pay_account TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  pos_staff_id TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, emp_id)
) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pr_employees_no ON pr_employees (client_id, emp_no)`,
  `CREATE INDEX IF NOT EXISTS ix_pr_employees_pos ON pr_employees (client_id, pos_staff_id)`,

  // Earning and deduction TYPES the owner configures (house allowance, bonus, PAYE ...). Nothing here is applied to anyone unless the owner
  // gives it to an employee (pr_pay_lines) or switches auto_apply on for the type.
  `CREATE TABLE IF NOT EXISTS pr_types (
  client_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  calc TEXT NOT NULL DEFAULT 'fixed',
  rate REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  cfg TEXT,
  statutory INTEGER NOT NULL DEFAULT 0,
  auto_apply INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, type_id)
) WITHOUT ROWID`,

  // What an employee gets / loses EVERY pay period (a fixed allowance, a loan instalment ...). balance is for advances and loans: it counts
  // down when a run is paid, and the line switches itself off at zero.
  `CREATE TABLE IF NOT EXISTS pr_pay_lines (
  client_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  type_id TEXT,
  label TEXT NOT NULL,
  calc TEXT NOT NULL DEFAULT 'fixed',
  rate REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  cfg TEXT,
  balance REAL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, emp_id, line_id)
) WITHOUT ROWID`,

  // Documents: the row is here, the file is in R2 (key shop/<client>/staffdoc/<id>) — never in the page.
  `CREATE TABLE IF NOT EXISTS pr_documents (
  client_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  file_name TEXT,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  storage_key TEXT,
  doc_date TEXT,
  expiry_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  uploaded_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, doc_id)
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_pr_documents_emp ON pr_documents (client_id, emp_id, status)`,

  // A payroll run: one pay period for a group of employees. draft -> reviewed -> approved -> paid.
  `CREATE TABLE IF NOT EXISTS pr_runs (
  client_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'regular',
  adjusts_run_id TEXT,
  label TEXT NOT NULL,
  frequency TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  total_basic REAL NOT NULL DEFAULT 0,
  total_additions REAL NOT NULL DEFAULT 0,
  total_deductions REAL NOT NULL DEFAULT 0,
  total_net REAL NOT NULL DEFAULT 0,
  employee_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by TEXT, created_at INTEGER NOT NULL,
  reviewed_by TEXT, reviewed_at INTEGER,
  approved_by TEXT, approved_at INTEGER,
  paid_by TEXT, paid_at INTEGER,
  pay_date TEXT, pay_method TEXT, pay_reference TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, run_id)
) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pr_runs_ref ON pr_runs (client_id, ref)`,
  `CREATE INDEX IF NOT EXISTS ix_pr_runs_period ON pr_runs (client_id, period_start, status)`,

  // One row per employee per run. The employee's name / number / title are COPIED here, so an old payslip never changes when the register does.
  `CREATE TABLE IF NOT EXISTS pr_items (
  client_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  payslip_no TEXT NOT NULL,
  emp_no TEXT,
  emp_name TEXT NOT NULL,
  job_title TEXT,
  department TEXT,
  branch_name TEXT,
  rate_unit TEXT NOT NULL DEFAULT 'period',
  rate REAL NOT NULL DEFAULT 0,
  units REAL NOT NULL DEFAULT 1,
  basic REAL NOT NULL DEFAULT 0,
  additions REAL NOT NULL DEFAULT 0,
  deductions REAL NOT NULL DEFAULT 0,
  net REAL NOT NULL DEFAULT 0,
  note TEXT,
  PRIMARY KEY (client_id, run_id, emp_id)
) WITHOUT ROWID`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pr_items_slip ON pr_items (client_id, payslip_no)`,
  `CREATE INDEX IF NOT EXISTS ix_pr_items_emp ON pr_items (client_id, emp_id)`,

  `CREATE TABLE IF NOT EXISTS pr_item_lines (
  client_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  type_id TEXT,
  pay_line_id TEXT,
  label TEXT NOT NULL,
  calc TEXT NOT NULL DEFAULT 'fixed',
  rate REAL NOT NULL DEFAULT 0,
  cfg TEXT,
  amount REAL NOT NULL DEFAULT 0,
  manual INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  PRIMARY KEY (client_id, run_id, emp_id, line_no)
) WITHOUT ROWID`,

  // Who may do what in payroll (the Admin always may everything). Checked by the SERVER on every request.
  `CREATE TABLE IF NOT EXISTS pr_access (
  client_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  staff_name TEXT,
  perms TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, staff_id)
) WITHOUT ROWID`,

  `CREATE TABLE IF NOT EXISTS pr_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT
)`,
  `CREATE INDEX IF NOT EXISTS ix_pr_audit_client ON pr_audit (client_id, ts)`,

  // ---------- the database refuses what the API must never do ----------
  `CREATE TRIGGER IF NOT EXISTS pr_audit_no_update BEFORE UPDATE ON pr_audit BEGIN SELECT RAISE(ABORT, 'payroll_audit_is_append_only'); END`,
  `CREATE TRIGGER IF NOT EXISTS pr_audit_no_delete BEFORE DELETE ON pr_audit BEGIN SELECT RAISE(ABORT, 'payroll_audit_is_append_only'); END`,

  // A run only moves forward: draft -> reviewed -> approved -> paid (reviewed may be sent back to draft). Once approved, nothing about it changes
  // except that it becomes paid (and the pay date / method / reference are filled in).
  `CREATE TRIGGER IF NOT EXISTS pr_runs_guard BEFORE UPDATE ON pr_runs
WHEN (OLD.status = 'paid')
  OR (OLD.status = 'approved' AND (NEW.status NOT IN ('approved', 'paid') OR NEW.total_basic IS NOT OLD.total_basic OR NEW.total_additions IS NOT OLD.total_additions OR NEW.total_deductions IS NOT OLD.total_deductions OR NEW.total_net IS NOT OLD.total_net OR NEW.period_start IS NOT OLD.period_start OR NEW.period_end IS NOT OLD.period_end OR NEW.employee_count IS NOT OLD.employee_count))
  OR (OLD.status = 'reviewed' AND NEW.status NOT IN ('reviewed', 'draft', 'approved'))
  OR (OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'reviewed'))
BEGIN SELECT RAISE(ABORT, 'payroll_run_is_final'); END`,
  `CREATE TRIGGER IF NOT EXISTS pr_runs_no_delete BEFORE DELETE ON pr_runs WHEN OLD.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'payroll_run_is_final'); END`,

  `CREATE TRIGGER IF NOT EXISTS pr_items_no_insert BEFORE INSERT ON pr_items
WHEN COALESCE((SELECT status FROM pr_runs WHERE client_id = NEW.client_id AND run_id = NEW.run_id), 'draft') <> 'draft'
BEGIN SELECT RAISE(ABORT, 'payroll_run_is_final'); END`,
  `CREATE TRIGGER IF NOT EXISTS pr_items_no_update BEFORE UPDATE ON pr_items
WHEN COALESCE((SELECT status FROM pr_runs WHERE client_id = OLD.client_id AND run_id = OLD.run_id), 'draft') <> 'draft'
BEGIN SELECT RAISE(ABORT, 'payroll_run_is_final'); END`,
  `CREATE TRIGGER IF NOT EXISTS pr_items_no_delete BEFORE DELETE ON pr_items
WHEN COALESCE((SELECT status FROM pr_runs WHERE client_id = OLD.client_id AND run_id = OLD.run_id), 'draft') <> 'draft'
BEGIN SELECT RAISE(ABORT, 'payroll_run_is_final'); END`,
  `CREATE TRIGGER IF NOT EXISTS pr_lines_no_insert BEFORE INSERT ON pr_item_lines
WHEN COALESCE((SELECT status FROM pr_runs WHERE client_id = NEW.client_id AND run_id = NEW.run_id), 'draft') <> 'draft'
BEGIN SELECT RAISE(ABORT, 'payroll_run_is_final'); END`,
  `CREATE TRIGGER IF NOT EXISTS pr_lines_no_update BEFORE UPDATE ON pr_item_lines
WHEN COALESCE((SELECT status FROM pr_runs WHERE client_id = OLD.client_id AND run_id = OLD.run_id), 'draft') <> 'draft'
BEGIN SELECT RAISE(ABORT, 'payroll_run_is_final'); END`,
  `CREATE TRIGGER IF NOT EXISTS pr_lines_no_delete BEFORE DELETE ON pr_item_lines
WHEN COALESCE((SELECT status FROM pr_runs WHERE client_id = OLD.client_id AND run_id = OLD.run_id), 'draft') <> 'draft'
BEGIN SELECT RAISE(ABORT, 'payroll_run_is_final'); END`,

  // zip 221: the saved PDF of a payslip. One row per payslip (saving again replaces it). Recent files sit in `data` (base64); once older than the
  // archive age they move to R2 (r2_key) and `data` is emptied, so the database never grows without limit. The row itself is always kept.
  `CREATE TABLE IF NOT EXISTS pr_slip_files (
  client_id TEXT NOT NULL,
  payslip_no TEXT NOT NULL,
  run_id TEXT NOT NULL,
  emp_id TEXT NOT NULL,
  file_name TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  data TEXT,
  r2_key TEXT,
  saved_by TEXT,
  saved_at INTEGER NOT NULL,
  archived_at INTEGER,
  PRIMARY KEY (client_id, payslip_no)
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS ix_pr_slip_files_age ON pr_slip_files (client_id, saved_at)`,
];
