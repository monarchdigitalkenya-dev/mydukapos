-- zip 273: atomic request counters for the abuse-sensitive routes (PIN / password / OTP guessing, payment-prompt spam, sign-up).
-- Additive; safe to run more than once. The server also creates this lazily (functions/api/_atomic-counter.js).
CREATE TABLE IF NOT EXISTS rate_counters (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  exp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_counters_exp ON rate_counters (exp);
