-- zip 185: atomic claim of an M-Pesa code by ONE sale (functions/api/mpesa-verify.js). Additive; safe to run more than once.
CREATE TABLE IF NOT EXISTS mpesa_code_claims (
  client_id TEXT NOT NULL,
  code TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (client_id, code)
) WITHOUT ROWID;
