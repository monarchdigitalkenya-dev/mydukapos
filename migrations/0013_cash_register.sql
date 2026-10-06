-- GENERATED from functions/api/_cash-schema.js by tools/gen-migration.mjs — do not edit by hand.
-- Cash Register (zip 234). Safe to run more than once (IF NOT EXISTS) and never drops anything.

CREATE TABLE IF NOT EXISTS cash_sessions (
  client_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  site_id TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL,
  device_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by TEXT NOT NULL,
  opened_by_id TEXT,
  opened_at INTEGER NOT NULL,
  opening_float_cents INTEGER NOT NULL CHECK (opening_float_cents >= 0),
  closed_by TEXT,
  closed_by_id TEXT,
  closed_at INTEGER,
  cash_sales_cents INTEGER,
  noncash_sales_cents INTEGER,
  sales_count INTEGER,
  refunds_cents INTEGER,
  expenses_cents INTEGER,
  cash_in_cents INTEGER,
  cash_out_cents INTEGER,
  expected_cents INTEGER,
  counted_cents INTEGER,
  difference_cents INTEGER,
  close_note TEXT,
  PRIMARY KEY (client_id, session_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open ON cash_sessions (client_id, site_id, device_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS cash_sessions_by_day ON cash_sessions (client_id, opened_at);

CREATE TRIGGER IF NOT EXISTS cash_sessions_closed_final BEFORE UPDATE ON cash_sessions WHEN OLD.status = 'closed' BEGIN SELECT RAISE(ABORT, 'a closed cash session can not be changed'); END;

CREATE TRIGGER IF NOT EXISTS cash_sessions_no_delete BEFORE DELETE ON cash_sessions BEGIN SELECT RAISE(ABORT, 'cash sessions are kept permanently'); END;

CREATE TABLE IF NOT EXISTS cash_movements (
  client_id TEXT NOT NULL,
  move_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cash_in','refund','expense','payout')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  note TEXT,
  by_name TEXT,
  by_id TEXT,
  PRIMARY KEY (client_id, move_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS cash_movements_by_session ON cash_movements (client_id, session_id, ts);

CREATE TRIGGER IF NOT EXISTS cash_movements_no_update BEFORE UPDATE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash movements are append-only'); END;

CREATE TRIGGER IF NOT EXISTS cash_movements_no_delete BEFORE DELETE ON cash_movements BEGIN SELECT RAISE(ABORT, 'cash movements are append-only'); END;

CREATE TABLE IF NOT EXISTS cash_audit (
  client_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,
  by_name TEXT,
  by_id TEXT,
  detail TEXT,
  PRIMARY KEY (client_id, audit_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS cash_audit_by_session ON cash_audit (client_id, session_id, ts);

CREATE TRIGGER IF NOT EXISTS cash_audit_no_update BEFORE UPDATE ON cash_audit BEGIN SELECT RAISE(ABORT, 'the cash audit trail is append-only'); END;

CREATE TRIGGER IF NOT EXISTS cash_audit_no_delete BEFORE DELETE ON cash_audit BEGIN SELECT RAISE(ABORT, 'the cash audit trail is append-only'); END;

CREATE TABLE IF NOT EXISTS cash_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) WITHOUT ROWID;
