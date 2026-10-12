-- zip 259: Till Payments — money paid straight to the M-PESA Till, awaiting a cashier to link it to a sale or bill. Additive; safe to run more than once.
-- The server also creates these lazily (functions/api/_till-store.js), so a deploy never depends on this migration having run.
CREATE TABLE IF NOT EXISTS till_payments (
  client_id TEXT NOT NULL,
  code TEXT NOT NULL,
  amount REAL NOT NULL,
  paid_at INTEGER NOT NULL,
  name TEXT,
  ref TEXT,
  phone_hint TEXT,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNLINKED',
  target_type TEXT,
  target_id TEXT,
  target_label TEXT,
  applied_by TEXT,
  applied_at INTEGER,
  PRIMARY KEY (client_id, code)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_till_recent ON till_payments (client_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS ix_till_status ON till_payments (client_id, status, paid_at DESC);
CREATE INDEX IF NOT EXISTS ix_till_target ON till_payments (client_id, target_type, target_id);
CREATE TABLE IF NOT EXISTS mpesa_code_claims (client_id TEXT NOT NULL, code TEXT NOT NULL, sale_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (client_id, code)) WITHOUT ROWID;
