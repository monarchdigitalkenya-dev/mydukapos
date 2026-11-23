// functions/api/_atomic-counter.js — shared helper, NOT a route (zip 273).
//
// An ATOMIC counter in the ledger D1 database: one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement, so a burst of parallel requests
// each get a different number and exactly `limit` of them pass. The KV counters this complements (read, then write) let a burst through, because
// every parallel request reads the same value. Used for the abuse-sensitive routes (PIN / password / OTP guessing, payment-prompt spam, sign-up).
//
// Everything degrades safely: no D1 binding, a D1 error or a missing table returns null and the caller falls back to its KV counter, so a
// database hiccup can never lock a shop out. The table is created on first use (and by migrations/0014_rate_counters.sql), so a deploy never
// depends on a migration having run. Expired rows are swept now and then.

const DDL = 'CREATE TABLE IF NOT EXISTS rate_counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)';

function db(env) { return env && (env.LEDGER_DB || null); }

// -> the new count for `key` after adding `cost`, or null when no atomic counter is available.
export async function atomicHit(env, key, cost = 1, ttlSec = 7200) {
  const d = db(env);
  if (!d) return null;
  const exp = Date.now() + ttlSec * 1000;
  const sql = 'INSERT INTO rate_counters (k, n, exp) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET n = n + ?2 RETURNING n';
  try {
    let row;
    try { row = await d.prepare(sql).bind(key, cost, exp).first(); }
    catch (e) {
      if (!/no such table/i.test(String(e && e.message))) throw e;
      await d.exec(DDL); row = await d.prepare(sql).bind(key, cost, exp).first();
    }
    if (Math.random() < 0.02) { try { await d.prepare('DELETE FROM rate_counters WHERE exp < ?1').bind(Date.now()).run(); } catch (e) { /* swept next time */ } }
    return row && Number.isFinite(Number(row.n)) ? Number(row.n) : null;
  } catch (e) { return null; }
}

// -> the current count (0 when none), or null when no atomic counter is available. Does not change anything.
export async function atomicPeek(env, key) {
  const d = db(env);
  if (!d) return null;
  try {
    const row = await d.prepare('SELECT n FROM rate_counters WHERE k = ?1 AND exp > ?2').bind(key, Date.now()).first();
    return row ? Number(row.n) || 0 : 0;
  } catch (e) { return /no such table/i.test(String(e && e.message)) ? 0 : null; }
}

// Forget a counter (a claim that did not lead to a sent prompt is released so the caller may try again at once). Best effort.
export async function atomicRelease(env, key) {
  const d = db(env);
  if (!d) return;
  try { await d.prepare('DELETE FROM rate_counters WHERE k = ?1').bind(key).run(); } catch (e) { /* it simply expires */ }
}
