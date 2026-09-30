// functions/api/_write-fence.js — zip 159. The D1 "write fence" for shops stored as a single KV record (see _efficiency-schema.js).
//
//   const f = await fenceOpen(env, clientId);           // null when there is no D1 (or the fence is off / broken): legacy behaviour
//   ... read the record; if (f) await fenceWaitVisible(env, f, () => readStateRaw(...))   // until the record's version >= what the last writer produced
//   ... merge ...
//   if (f && !(await fenceClaim(env, f, stored)))  -> another device won the slot: start again from a fresh read
//   writeStateText(..., { ver: f.nextVer })
//
// Why it is safe: the claim is a single conditional upsert in D1 (strongly consistent, one winner). The winner's KV version is recorded
// BEFORE it writes, and every later writer refuses to merge from a copy older than that version. So no writer ever merges from a stale
// copy of an acknowledged write, which is exactly how sales used to go missing. Failure handling is deliberately forgiving:
//   * D1 unreachable  -> no fence, legacy path (the ledger, which is written first, already holds every sale);
//   * a winner that crashed before its KV write -> its claim is ignored once it is FENCE_ORPHAN_MS (120 s) old;
//   * a copy that will not catch up within FENCE_WAIT_MS -> 503 "busy" (the till keeps the sale and retries; Retry-After 2).
import { ledgerDb, ensureLedgerSchema } from './_ledger.js';
import { EFFICIENCY_SCHEMA, EFFICIENCY_SCHEMA_VERSION } from './_efficiency-schema.js';
import { withRetry } from './_retry.js';

const ready = new WeakMap();
export async function ensureEfficiencySchema(db) {
  if (!db) return false;
  if (ready.get(db)) return true;
  await ensureLedgerSchema(db);                                   // creates ledger_meta
  let ok = false;
  try { const r = await db.prepare(`SELECT v FROM ledger_meta WHERE k = 'eff'`).first(); ok = !!(r && Number(r.v) >= EFFICIENCY_SCHEMA_VERSION); } catch (e) { ok = false; }
  if (!ok) {
    await db.batch(EFFICIENCY_SCHEMA.map((s) => db.prepare(s)));
    await db.prepare(`INSERT INTO ledger_meta (k, v) VALUES ('eff', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(EFFICIENCY_SCHEMA_VERSION)).run();
  }
  ready.set(db, true);
  return true;
}

const num = (v, d) => { const n = v != null && v !== '' ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? n : d; };
export const fenceWaitMs = (env) => num(env && env.FENCE_WAIT_MS, 4000);
export const fenceOrphanMs = (env) => num(env && env.FENCE_ORPHAN_MS, 120000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -> { db, clientId, seq, kvVer, at } | null
export async function fenceOpen(env, clientId) {
  if (!env || env.WRITE_FENCE === '0') return null;
  const db = ledgerDb(env);
  if (!db) return null;
  try {
    await ensureEfficiencySchema(db);
    const row = await withRetry(() => db.prepare(`SELECT seq, kv_ver, at FROM shop_write_fence WHERE client_id = ?`).bind(clientId).first(), { tries: 2, baseMs: 30, env });
    return { db, clientId, seq: row ? Number(row.seq) : 0, kvVer: row ? Number(row.kv_ver) : 0, at: row ? Number(row.at) : 0, nextVer: 0 };
  } catch (e) { return null; }
}

// The record we read must be at least as new as the last fenced write. `read()` re-reads KV (-> { meta } | null). Returns the (re)read value,
// or throws an Error with .code = 'fence_busy' when it stays behind past the wait budget and the claim is not an orphan.
export async function fenceWaitVisible(env, fence, read, first) {
  let cur = first !== undefined ? first : await read();
  const seen = () => Number((cur && cur.meta && cur.meta.ver) || 0);
  if (!fence || fence.kvVer <= 0 || seen() >= fence.kvVer) return cur;
  const deadline = Date.now() + fenceWaitMs(env);
  for (let i = 0; Date.now() < deadline; i++) {
    await sleep(Math.min(50 * 2 ** i, 800) + Math.floor(Math.random() * 40));
    cur = await read();
    if (seen() >= fence.kvVer) return cur;
  }
  if (Date.now() - fence.at > fenceOrphanMs(env)) return cur;      // the claimant never wrote: do not block the shop forever
  const e = new Error('shop copy is catching up'); e.code = 'fence_busy'; throw e;
}

// Claim the next write slot. true = this writer won and must write `fence.nextVer`; false = somebody else won: re-read and merge again.
export async function fenceClaim(env, fence, stored) {
  const base = Math.max(Number((stored && stored.meta && stored.meta.ver) || 0), fence.kvVer);
  fence.nextVer = base + 1; fence.prevKvVer = fence.kvVer;
  try {
    const r = await fence.db.prepare(`INSERT INTO shop_write_fence (client_id, seq, kv_ver, at) VALUES (?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET seq = excluded.seq, kv_ver = excluded.kv_ver, at = excluded.at WHERE shop_write_fence.seq = ? RETURNING seq`)
      .bind(fence.clientId, fence.seq + 1, fence.nextVer, Date.now(), fence.seq).all();
    return !!(r && r.results && r.results.length);
  } catch (e) {
    fence.nextVer = 0;
    return 'error';                                                // D1 failed at the claim: caller falls back to the legacy checks
  }
}

// The claimed write could not be made (KV refused it every time): hand the slot back so the next writer is not left waiting for a version
// that will never appear. Conditional on our own claim still being the latest.
export async function fenceRelease(env, fence) {
  if (!fence || !fence.nextVer) return;
  try { await fence.db.prepare(`UPDATE shop_write_fence SET kv_ver = ? WHERE client_id = ? AND seq = ?`).bind(fence.prevKvVer || 0, fence.clientId, fence.seq + 1).run(); } catch (e) { /* the orphan timeout covers it */ }
}
