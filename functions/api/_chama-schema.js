// functions/api/_chama-schema.js — Chama (zip 217). The D1 schema of the Chama module. Single source of truth:
//   * the server creates any missing table on first use (ensureChamaSchema in _chama.js), so a deploy never meets an empty database;
//   * migrations/0012_chama.sql is GENERATED from this list by `npm run gen:migration` (a test fails if the two ever differ).
// Money is stored as WHOLE CENTS (integers) — never floating point.
// Rules the DATABASE itself enforces (not only the app / API):
//   * the ledger is APPEND-ONLY: no UPDATE and no DELETE, ever. A mistake is fixed by a REVERSAL row (kind keeps the original kind, the amount is negated,
//     reversal_of points at the original) followed by the correct entry. Every member balance is re-derived from these rows, never from a stored total;
//   * the same ledger entry can never be written twice (UNIQUE client_id + idem_key), and an entry can be reversed only once (UNIQUE reversal_of);
//   * the same M-Pesa transaction code can never be reported twice while a report is pending or verified (partial unique index);
//   * the audit trail is append-only too;
//   * every table carries client_id (the chama's link): one chama can never read or write another chama's data.
export const CHAMA_SCHEMA_VERSION = 2;
// zip 230: columns added after the first release. A fresh database gets them from CHAMA_SCHEMA below; a database created by zip 217-229 is upgraded in place
// by ensureChamaSchema (it checks the table first, so running it twice is harmless).
export const CHAMA_UPGRADES = [
  ['chama_member', 'roles', "TEXT NOT NULL DEFAULT '[]'"],            // extra roles beyond the main one (a person can be Member + Secretary + Chairperson)
  ['chama_report', 'reported_cents', 'INTEGER'],                      // what the member SAID they paid (amount_cents is what was verified)
  ['chama_report', 'received_by', 'TEXT'],                            // the official a cash payment was handed to
  ['chama_mgr', 'every_months', 'INTEGER NOT NULL DEFAULT 0'],
  ['chama_mgr', 'last_payout_date', 'TEXT'],
  ['chama_mgr', 'ongoing', 'INTEGER NOT NULL DEFAULT 0'],
  ['chama_mgr_turn', 'opening', 'INTEGER NOT NULL DEFAULT 0'],        // 1 = this turn was paid before the chama started using the system
  ['chama_mgr_turn', 'due_original', 'TEXT'],
  ['chama_mgr_turn', 'paid_date', 'TEXT'],
];

export const CHAMA_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS chama_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
)`,

  // one chama per link: its name and its configuration (rules, features, privacy) as JSON — configuration only, never money
  `CREATE TABLE IF NOT EXISTS chama_group (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
)`,

  `CREATE TABLE IF NOT EXISTS chama_member (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','secretary','treasurer','member')),
  perms TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  must_change_pin INTEGER NOT NULL DEFAULT 0,
  failed_pins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (client_id, id)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chama_member_phone ON chama_member (client_id, phone)`,

  // remembered devices: only a HASH of the token is stored; revoking sets revoked_at
  `CREATE TABLE IF NOT EXISTS chama_device (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (client_id, id)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chama_device_token ON chama_device (token_hash)`,
  `CREATE INDEX IF NOT EXISTS chama_device_member ON chama_device (client_id, member_id)`,

  `CREATE TABLE IF NOT EXISTS chama_fund (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (client_id, id)
)`,

  // a contribution period (for example 1 Oct - 30 Nov) and what each member owes for it
  `CREATE TABLE IF NOT EXISTS chama_cycle (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  fund_id TEXT NOT NULL,
  label TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  required_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, id)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chama_cycle_start ON chama_cycle (client_id, fund_id, start_date)`,

  `CREATE TABLE IF NOT EXISTS chama_obligation (
  client_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  required_cents INTEGER NOT NULL CHECK (required_cents >= 0),
  PRIMARY KEY (client_id, cycle_id, member_id)
)`,

  // a payment a member (or the treasurer) reports. The raw SMS is NEVER stored: only the fields needed to verify the money.
  `CREATE TABLE IF NOT EXISTS chama_report (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('contribution','loan','fundraiser','penalty','mgr')),
  target_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL DEFAULT 'mpesa',
  mpesa_code TEXT,
  tx_date TEXT,
  tx_time TEXT,
  recipient TEXT,
  anonymous INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','reversed')),
  reported_at INTEGER NOT NULL,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  note TEXT,
  reported_cents INTEGER,
  received_by TEXT,
  PRIMARY KEY (client_id, id)
)`,
  // the same M-Pesa transaction can be on only ONE live (pending / verified) report; a rejected one frees the code
  `CREATE UNIQUE INDEX IF NOT EXISTS chama_report_code ON chama_report (client_id, mpesa_code) WHERE mpesa_code IS NOT NULL AND status IN ('pending','verified')`,
  `CREATE INDEX IF NOT EXISTS chama_report_status ON chama_report (client_id, status, reported_at)`,
  `CREATE INDEX IF NOT EXISTS chama_report_member ON chama_report (client_id, member_id, reported_at)`,

  // THE LEDGER. amount_cents is signed: money INTO the chama is positive, money OUT is negative.
  `CREATE TABLE IF NOT EXISTS chama_ledger (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  entry_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('contribution','loan_disbursement','loan_repayment','mgr_contribution','mgr_payout','fundraising','expense','penalty','refund','transfer','adjustment')),
  fund_id TEXT NOT NULL,
  member_id TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  ref_type TEXT,
  ref_id TEXT,
  report_id TEXT,
  method TEXT,
  reference TEXT,
  note TEXT,
  created_by TEXT,
  reversal_of TEXT,
  idem_key TEXT NOT NULL,
  PRIMARY KEY (client_id, id)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chama_ledger_idem ON chama_ledger (client_id, idem_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chama_ledger_reversal ON chama_ledger (client_id, reversal_of) WHERE reversal_of IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS chama_ledger_pos ON chama_ledger (client_id, kind, ref_type, ref_id, member_id)`,
  `CREATE INDEX IF NOT EXISTS chama_ledger_member ON chama_ledger (client_id, member_id, ts)`,
  `CREATE INDEX IF NOT EXISTS chama_ledger_ts ON chama_ledger (client_id, ts)`,
  `CREATE TRIGGER IF NOT EXISTS chama_ledger_no_update BEFORE UPDATE ON chama_ledger BEGIN SELECT RAISE(ABORT, 'the chama ledger is append-only: record a reversal instead'); END`,
  `CREATE TRIGGER IF NOT EXISTS chama_ledger_no_delete BEFORE DELETE ON chama_ledger BEGIN SELECT RAISE(ABORT, 'the chama ledger is append-only: record a reversal instead'); END`,

  `CREATE TABLE IF NOT EXISTS chama_loan (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  principal_cents INTEGER NOT NULL CHECK (principal_cents > 0),
  interest_cents INTEGER NOT NULL DEFAULT 0,
  months INTEGER NOT NULL DEFAULT 1,
  purpose TEXT,
  loan_type TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','changes','approved','rejected','active','cleared','cancelled')),
  requested_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  disbursed_at INTEGER,
  disburse_date TEXT,
  PRIMARY KEY (client_id, id)
)`,
  `CREATE INDEX IF NOT EXISTS chama_loan_member ON chama_loan (client_id, member_id, status)`,

  `CREATE TABLE IF NOT EXISTS chama_guarantor (
  client_id TEXT NOT NULL,
  loan_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  responded_at INTEGER,
  PRIMARY KEY (client_id, loan_id, member_id)
)`,

  `CREATE TABLE IF NOT EXISTS chama_mgr (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  per_member_cents INTEGER NOT NULL CHECK (per_member_cents > 0),
  every_days INTEGER NOT NULL DEFAULT 7,
  start_date TEXT NOT NULL,
  order_mode TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at INTEGER NOT NULL,
  every_months INTEGER NOT NULL DEFAULT 0,
  last_payout_date TEXT,
  ongoing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, id)
)`,
  `CREATE TABLE IF NOT EXISTS chama_mgr_turn (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  mgr_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  due_date TEXT NOT NULL,
  expected_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid_out')),
  opening INTEGER NOT NULL DEFAULT 0,
  due_original TEXT,
  paid_date TEXT,
  PRIMARY KEY (client_id, id)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chama_mgr_turn_seq ON chama_mgr_turn (client_id, mgr_id, seq)`,

  `CREATE TABLE IF NOT EXISTS chama_fundraiser (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  note TEXT,
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  end_date TEXT,
  allow_anonymous INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, id)
)`,

  `CREATE TABLE IF NOT EXISTS chama_penalty (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT,
  ref_type TEXT,
  ref_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waived','void')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  waived_by TEXT,
  waived_at INTEGER,
  waive_reason TEXT,
  PRIMARY KEY (client_id, id)
)`,
  // an automatic penalty (missed meeting, late contribution) is raised once per member and occasion
  `CREATE UNIQUE INDEX IF NOT EXISTS chama_penalty_once ON chama_penalty (client_id, member_id, kind, ref_id) WHERE ref_id IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS chama_meeting (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  meeting_type TEXT NOT NULL DEFAULT 'normal',
  meet_date TEXT NOT NULL,
  meet_time TEXT,
  location TEXT,
  agenda TEXT,
  notes TEXT,
  attachment_url TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','held','cancelled')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, id)
)`,
  `CREATE TABLE IF NOT EXISTS chama_attendance (
  client_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','absent','excused','late')),
  marked_by TEXT,
  marked_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, meeting_id, member_id)
)`,
  `CREATE TABLE IF NOT EXISTS chama_minutes (
  client_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  chairperson TEXT,
  secretary TEXT,
  body TEXT,
  decisions TEXT,
  financial_decisions TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, meeting_id)
)`,
  `CREATE TABLE IF NOT EXISTS chama_action_item (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  action TEXT NOT NULL,
  assigned_to TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  PRIMARY KEY (client_id, id)
)`,

  // messages: member_id NULL = the whole group; reads are kept per member
  `CREATE TABLE IF NOT EXISTS chama_message (
  client_id TEXT NOT NULL,
  id TEXT NOT NULL,
  member_id TEXT,
  kind TEXT NOT NULL DEFAULT 'announcement',
  title TEXT NOT NULL,
  body TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, id)
)`,
  `CREATE INDEX IF NOT EXISTS chama_message_member ON chama_message (client_id, member_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS chama_message_read (
  client_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, message_id, member_id)
)`,

  `CREATE TABLE IF NOT EXISTS chama_audit (
  client_id TEXT NOT NULL,
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  record TEXT,
  before_json TEXT,
  after_json TEXT
)`,
  `CREATE INDEX IF NOT EXISTS chama_audit_ts ON chama_audit (client_id, ts)`,
  `CREATE TRIGGER IF NOT EXISTS chama_audit_no_update BEFORE UPDATE ON chama_audit BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS chama_audit_no_delete BEFORE DELETE ON chama_audit BEGIN SELECT RAISE(ABORT, 'the audit trail is append-only'); END`,
];
