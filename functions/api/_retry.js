// functions/api/_retry.js — shared helper, NOT a route. (zip 159)
//
// Retry with exponential backoff + full jitter, for the storage calls on a hot path (KV get, D1 batch) that fail for a moment now and then
// (a network blip between the Worker and the storage, a D1 primary that is briefly overloaded, a Durable Object that was just restarted).
// Only for calls that are SAFE TO REPEAT: a read, or a write that is an idempotent upsert keyed by the record's own id (the D1 ledger).
//
//   await withRetry(() => db.batch(stmts), { tries: 3, baseMs: 40 })
//
// A permanent failure (a constraint, a missing table, a trigger refusing a DELETE) is never retried: it would fail the same way, and retrying
// a refused write only delays the answer.
// zip 186: a FULL database (D1 caps one database at 10 GB: SQLITE 7500 / "Exceeded maximum DB size") fails identically on every attempt, and every attempt
// is a write the full database cannot take: never retried here, answered 507 by the callers (see isStorageFull) so the till pauses instead of looping.
const STORAGE_FULL = /\[7500\]|\b7500:|SQLITE[_ ]?7500|exceeded maximum db(?:atabase)? size|maximum database size|SQLITE_FULL|database or disk is full|storage limit exceeded/i;
export function isStorageFull(e) { return STORAGE_FULL.test(String((e && e.message) || e || '')); }
const PERMANENT = /constraint|unique|not null|check failed|foreign key|syntax error|no such (table|column)|never deleted|append-only|cannot be edited|too many (sql )?variables|statement too long|SQLITE_TOOBIG/i;

export function isTransient(e) {
  const msg = String((e && e.message) || e || '');
  if (PERMANENT.test(msg) || STORAGE_FULL.test(msg)) return false;
  return true;                                                       // unknown / network / overloaded / "Durable Object reset": worth another try
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// baseMs: first wait (doubles each time, full jitter: a random wait between 0 and the cap, so several callers do not retry in step).
// env.RETRY_BASE_MS overrides baseMs (0 = no waiting, used by tests). Returns fn's value, or throws the LAST error.
export async function withRetry(fn, { tries = 3, baseMs = 40, maxMs = 400, env = null, transient = isTransient, onRetry = null } = {}) {
  const base = env && env.RETRY_BASE_MS != null && Number.isFinite(Number(env.RETRY_BASE_MS)) ? Number(env.RETRY_BASE_MS) : baseMs;
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await fn(attempt); }
    catch (e) {
      last = e;
      if (attempt >= tries || !transient(e)) throw e;
      if (onRetry) { try { onRetry(e, attempt); } catch (x) { /* observer only */ } }
      const cap = Math.min(maxMs, base * 2 ** (attempt - 1));
      if (cap > 0) await sleep(Math.floor(Math.random() * cap) + Math.min(cap, 5));
    }
  }
  throw last;
}
