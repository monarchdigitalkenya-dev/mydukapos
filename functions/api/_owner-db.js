// functions/api/_owner-db.js — the small shared OWNER database (zip 187). NOT a route.
//
// WHAT. A D1 database `mydukapos-owner` (binding OWNER_DB) that holds a READ MODEL of what the Owner Console list shows: one row per client SUMMARY
// (owner_clients) and one row per person of the quote/payment ledger (owner_group_income). Until now the whole client list was ONE KV key
// (`license-index:v1`, an array of every summary, rewritten on every change) and the ledger ONE KV doc: a write race, and a read that gets heavier with
// every shop. With this database each change touches one row, and the console list is one SQL query.
//
// KV STAYS THE SOURCE OF TRUTH. Nothing that a shop needs ever reads this database: licence checks, login (online and offline), device pairing and shop
// sync read KV exactly as before and never import this file. The ONLY reader is the Owner Console list (owner-clients.js GET) and the owner-db route.
//
// RULES.
//  * WRITE-THROUGH, best effort, never throws: right AFTER the KV write succeeded the changed row is upserted/deleted here. A failure (or a hang past
//    OWNER_DB_TIMEOUT_MS, default 2 s) never fails or undoes the KV write. It pauses further attempts for 5 minutes in this isolate (like audit-db) and
//    sets a small KV flag `owner-db:dirty:v1`, because from then on this database may be behind KV.
//  * READ-THROUGH only when the mirror is HEALTHY: bound, its tables answer, `owner_meta.synced_at` is set (a rebuild finished and its row count matched the
//    KV index), and the dirty flag is absent. On ANY problem the caller reads KV exactly as before. When in doubt: KV.
//  * NO SECRETS. Only the non-secret summary fields the console list already shows are stored (never a password hash, token, PIN or the owner account
//    record — those live in KV only). As a second line of defence any top-level key that looks like a secret is dropped before a row is written.
//  * No OWNER_DB binding (or OWNER_DB_DISABLED) = today's behaviour, byte for byte.
import { isStorageFull } from './_retry.js';

export const ownerDb = (env) => (env && env.OWNER_DB) || null;

export const OWNER_INDEX_KEY = 'license-index:v1';                       // the same keys _license.js / owner-lock.js use (not imported: no cycle)
export const OWNER_GROUP_INCOME_KEY = 'owner-group-income:v1';
export const OWNER_DIRTY_KEY = 'owner-db:dirty:v1';

export const OWNER_SCHEMA_VERSION = 1;
export const OWNER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS owner_clients (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  business_name TEXT NOT NULL DEFAULT '',
  product TEXT,
  type TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER,
  updated_at INTEGER NOT NULL,
  summary_json TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS ix_owner_clients_slug ON owner_clients (slug)`,
  `CREATE INDEX IF NOT EXISTS ix_owner_clients_trashed ON owner_clients (trashed_at)`,
  `CREATE INDEX IF NOT EXISTS ix_owner_clients_updated ON owner_clients (updated_at)`,
  `CREATE TABLE IF NOT EXISTS owner_group_income (
  person_key TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS owner_meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`,
];

const ready = new WeakMap();
export async function ensureOwnerSchema(db) {
  if (!db) return false;
  if (ready.get(db)) return true;
  let ok = false;
  try { const r = await db.prepare(`SELECT v FROM owner_meta WHERE k = 'schema'`).first(); ok = !!(r && Number(r.v) >= OWNER_SCHEMA_VERSION); } catch (e) { ok = false; }
  if (!ok) {
    await db.batch(OWNER_SCHEMA.map((s) => db.prepare(s)));
    await db.prepare(`INSERT INTO owner_meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(OWNER_SCHEMA_VERSION)).run();
  }
  ready.set(db, true);
  return true;
}

/* ---------- row building ---------- */

const SECRET_KEY = /(hash|pin|token|password|passwd|secret|salt|otp|proof)/i;
export function scrubSummary(entry) {
  const out = {};
  for (const k of Object.keys(entry || {})) if (!SECRET_KEY.test(k)) out[k] = entry[k];
  return out;
}
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// -> the 12 bound values of UPSERT_*, in column order
function rowArgs(entry, now) {
  const s = scrubSummary(entry);
  return [
    String(s.id), String(s.slug || ''), String(s.label || ''), String(s.businessName || ''), s.product == null ? null : String(s.product), s.type == null ? null : String(s.type),
    s.locked ? 1 : 0,
    s.deleted ? (numOrNull(s.deletedAt) || 0) : null,                    // NULL = live, a number (even 0) = in Trash: the same test the KV list uses (!!deleted)
    numOrNull(s.expiresAt), numOrNull(s.createdAt), now, JSON.stringify(s),
  ];
}
const COLS = `id, slug, label, business_name, product, type, locked, trashed_at, expires_at, created_at, updated_at, summary_json`;
const SET = `slug = excluded.slug, label = excluded.label, business_name = excluded.business_name, product = excluded.product, type = excluded.type, locked = excluded.locked, trashed_at = excluded.trashed_at, expires_at = excluded.expires_at, created_at = excluded.created_at, updated_at = excluded.updated_at, summary_json = excluded.summary_json`;
const UPSERT = `INSERT INTO owner_clients (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ${SET}`;
// a rebuild must never overwrite a row that a live write touched after the rebuild started
const UPSERT_IF_OLDER = `${UPSERT} WHERE owner_clients.updated_at <= excluded.updated_at`;
const UPSERT_INCOME = `INSERT INTO owner_group_income (person_key, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(person_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`;
const UPSERT_INCOME_IF_OLDER = `${UPSERT_INCOME} WHERE owner_group_income.updated_at <= excluded.updated_at`;
const META_SET = `INSERT INTO owner_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`;

/* ---------- pause / dirty flag / kill switch ---------- */

const pausedUntil = new WeakMap();                                    // OWNER_DB binding -> time before which no mirror write is attempted
const pauseMs = (env) => { const n = env && env.OWNER_DB_PAUSE_MS != null && env.OWNER_DB_PAUSE_MS !== '' ? Number(env.OWNER_DB_PAUSE_MS) : 300000; return Number.isFinite(n) && n >= 0 ? n : 300000; };
const timeoutMs = (env) => { const n = env && env.OWNER_DB_TIMEOUT_MS != null && env.OWNER_DB_TIMEOUT_MS !== '' ? Number(env.OWNER_DB_TIMEOUT_MS) : 2000; return Number.isFinite(n) && n > 0 ? n : 2000; };
const flag = (v) => v === '1' || v === 'true' || v === true;
export const ownerDbDisabled = (env) => flag(env && env.OWNER_DB_DISABLED);
export const ownerReadsDisabled = (env) => ownerDbDisabled(env) || flag(env && env.OWNER_DB_READS_DISABLED);
export const ownerPausedUntil = (db) => pausedUntil.get(db) || 0;
export const clearOwnerPause = (db) => { if (db) pausedUntil.delete(db); };

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('owner db timeout')), ms); })]).finally(() => clearTimeout(t));
}

async function markDirty(env) {
  try { if (env && env.mydukapos_kv) await env.mydukapos_kv.put(OWNER_DIRTY_KEY, String(Date.now())); } catch (e) { /* nothing more can be done: reads also require synced_at */ }
}

// Runs one mirror write. Never throws. -> { written?, skipped?, error? }
async function guarded(env, db, fn, now = Date.now()) {
  if (ownerDbDisabled(env)) { await markDirty(env); return { written: 0, skipped: 'disabled' }; }
  if (now < ownerPausedUntil(db)) { await markDirty(env); return { written: 0, skipped: 'paused' }; }
  try {
    return await withTimeout((async () => { await ensureOwnerSchema(db); return fn(); })(), timeoutMs(env));
  } catch (e) {
    pausedUntil.set(db, now + pauseMs(env));
    await markDirty(env);
    try { console.error('owner db write failed (paused ' + Math.round(pauseMs(env) / 1000) + ' s):', e && e.message); } catch (x) { /* logging only */ }
    return { written: 0, error: isStorageFull(e) ? 'storage_full' : String((e && e.message) || e).slice(0, 120) };
  }
}

/* ---------- write-through (called AFTER the KV write succeeded) ---------- */

// entry = the exact summary object just written to the KV index
export async function mirrorClient(env, entry, now = Date.now()) {
  const db = ownerDb(env);
  if (!db) return { written: 0, skipped: 'no_db' };
  if (!entry || !entry.id) return { written: 0, skipped: 'no_id' };
  return guarded(env, db, async () => { await db.prepare(UPSERT).bind(...rowArgs(entry, now)).run(); return { written: 1 }; }, now);
}
export async function mirrorRemove(env, clientId, now = Date.now()) {
  const db = ownerDb(env);
  if (!db) return { written: 0, skipped: 'no_db' };
  if (!clientId) return { written: 0, skipped: 'no_id' };
  return guarded(env, db, async () => { await db.prepare(`DELETE FROM owner_clients WHERE id = ?`).bind(String(clientId)).run(); return { written: 1 }; }, now);
}
export async function mirrorGroupIncome(env, personKey, data, now = Date.now()) {
  const db = ownerDb(env);
  if (!db) return { written: 0, skipped: 'no_db' };
  if (!personKey) return { written: 0, skipped: 'no_key' };
  return guarded(env, db, async () => { await db.prepare(UPSERT_INCOME).bind(String(personKey), JSON.stringify(data), now).run(); return { written: 1 }; }, now);
}
export async function mirrorGroupIncomeClear(env, now = Date.now()) {
  const db = ownerDb(env);
  if (!db) return { written: 0, skipped: 'no_db' };
  return guarded(env, db, async () => { await db.prepare(`DELETE FROM owner_group_income`).run(); return { written: 1 }; }, now);
}

/* ---------- read-through (Owner Console only) ---------- */

async function metaMap(db) {
  const r = await db.prepare(`SELECT k, v FROM owner_meta WHERE k IN ('synced_at', 'kv_rows', 'income_rows')`).all();
  const m = {};
  for (const row of (r && r.results) || []) m[row.k] = row.v;
  return m;
}

// Is the mirror safe to read from? Two cheap reads: one small KV key (the dirty flag) and one 3-row meta query. false on ANY doubt or error.
export async function mirrorHealthy(env) {
  const db = ownerDb(env);
  if (!db || ownerReadsDisabled(env)) return false;
  if (Date.now() < ownerPausedUntil(db)) return false;
  try {
    if (await env.mydukapos_kv.get(OWNER_DIRTY_KEY)) return false;
    const m = await metaMap(db);
    return !!(m.synced_at && Number.isFinite(Number(m.synced_at)) && Number(m.synced_at) > 0 && m.kv_rows != null && Number.isFinite(Number(m.kv_rows)));
  } catch (e) { return false; }
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

// -> { summaries, groupIncome } read from D1 (same content and order as the KV path would give), or null = "use KV".
// q/trashOnly mean exactly what they mean in listClientSummaries(): trash vs live, newest first (Trash: newest deleted first), q = case-insensitive
// substring of label or slug. A needle with non-ASCII letters is left to KV (SQLite's LIKE only folds ASCII case; JS folds everything).
export async function ownerDbRead(env, { q, trashOnly } = {}) {
  const db = ownerDb(env);
  if (!db) return null;
  try {
    const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
    if (needle && /[^\x00-\x7f]/.test(needle)) return null;
    if (!(await mirrorHealthy(env))) return null;
    const where = [trashOnly ? 'trashed_at IS NOT NULL' : 'trashed_at IS NULL'];
    const args = [];
    if (needle) { where.push(`(label LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\')`); const p = '%' + likeEscape(needle) + '%'; args.push(p, p); }
    const order = trashOnly ? 'COALESCE(trashed_at, 0) DESC' : 'COALESCE(created_at, 0) DESC';
    const rows = (await db.prepare(`SELECT summary_json FROM owner_clients WHERE ${where.join(' AND ')} ORDER BY ${order}, id`).bind(...args).all()).results || [];
    const summaries = rows.map((r) => JSON.parse(r.summary_json));
    if (summaries.some((s) => !s || typeof s !== 'object' || !s.id)) return null;
    const inc = (await db.prepare(`SELECT person_key, data_json FROM owner_group_income ORDER BY rowid`).all()).results || [];
    const groupIncome = {};
    for (const r of inc) groupIncome[r.person_key] = JSON.parse(r.data_json);
    return { summaries, groupIncome };
  } catch (e) { return null; }
}

/* ---------- rebuild / status (owner route) ---------- */

async function readKvIndex(env) {
  const raw = await env.mydukapos_kv.get(OWNER_INDEX_KEY);
  const list = raw ? JSON.parse(raw) : [];
  return list.map((e) => (typeof e === 'string' ? { id: e } : e));
}
async function readKvIncome(env) {
  const raw = await env.mydukapos_kv.get(OWNER_GROUP_INCOME_KEY);
  const o = raw ? JSON.parse(raw) : {};
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}
const CHUNK = 50;
const chunks = (arr, n = CHUNK) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));

// Copies the whole KV index and the person ledger into D1: batched, idempotent (run it as often as you like). Reads are served from KV while it runs
// (synced_at is cleared first) and only turn back on when the finished copy has exactly as many rows as the KV index has entries.
export async function rebuildOwnerDb(env) {
  const db = ownerDb(env);
  if (!db) return { ok: false, error: 'not_bound' };
  const t0 = Date.now();
  try {
    await ensureOwnerSchema(db);
    const dirtyBefore = await env.mydukapos_kv.get(OWNER_DIRTY_KEY);
    await db.prepare(`DELETE FROM owner_meta WHERE k IN ('synced_at', 'kv_rows', 'income_rows')`).run();
    const list = await readKvIndex(env);
    const income = await readKvIncome(env);
    const valid = list.filter((e) => e && e.id);
    for (const part of chunks(valid)) await db.batch(part.map((e) => db.prepare(UPSERT_IF_OLDER).bind(...rowArgs(e, t0))));
    const have = new Set(valid.map((e) => String(e.id)));
    const existing = ((await db.prepare(`SELECT id FROM owner_clients`).all()).results || []).map((r) => r.id);
    const extra = existing.filter((id) => !have.has(id));
    for (const part of chunks(extra)) await db.batch(part.map((id) => db.prepare(`DELETE FROM owner_clients WHERE id = ? AND updated_at < ?`).bind(id, t0)));
    const keys = Object.keys(income);
    for (const part of chunks(keys)) await db.batch(part.map((k) => db.prepare(UPSERT_INCOME_IF_OLDER).bind(k, JSON.stringify(income[k]), t0)));
    const haveKeys = new Set(keys);
    const existingKeys = ((await db.prepare(`SELECT person_key FROM owner_group_income`).all()).results || []).map((r) => r.person_key);
    for (const part of chunks(existingKeys.filter((k) => !haveKeys.has(k)))) await db.batch(part.map((k) => db.prepare(`DELETE FROM owner_group_income WHERE person_key = ? AND updated_at < ?`).bind(k, t0)));
    const rows = Number((await db.prepare(`SELECT count(*) AS n FROM owner_clients`).first()).n);
    const incomeRows = Number((await db.prepare(`SELECT count(*) AS n FROM owner_group_income`).first()).n);
    clearOwnerPause(db);
    if (rows !== list.length || incomeRows !== keys.length) return { ok: false, error: 'count_mismatch', rows, kvRows: list.length, incomeRows, kvIncomeKeys: keys.length, ms: Date.now() - t0 };
    const syncedAt = Date.now();
    await db.batch([db.prepare(META_SET).bind('kv_rows', String(list.length)), db.prepare(META_SET).bind('income_rows', String(keys.length)), db.prepare(META_SET).bind('synced_at', String(syncedAt))]);
    // the "behind KV" flag is cleared only if no mirror failure happened while this ran
    const dirtyNow = await env.mydukapos_kv.get(OWNER_DIRTY_KEY);
    let dirty = !!dirtyNow;
    if (dirtyNow && dirtyNow === dirtyBefore) { await env.mydukapos_kv.delete(OWNER_DIRTY_KEY); dirty = false; }
    return { ok: true, rows, kvRows: list.length, incomeRows, syncedAt, dirty, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160), ms: Date.now() - t0 };
  }
}

// -> { bound, ... } never throws. `drift` is the number of client rows that are missing, extra or different compared with the KV index (plus person-ledger differences).
export async function ownerDbStatus(env) {
  const db = ownerDb(env);
  if (!db) return { bound: false, healthy: false };
  const out = { bound: true, disabled: ownerDbDisabled(env), readsDisabled: ownerReadsDisabled(env), pausedUntil: ownerPausedUntil(db) || null };
  try {
    await ensureOwnerSchema(db);
    const m = await metaMap(db);
    out.syncedAt = m.synced_at ? Number(m.synced_at) : null;
    out.kvRowsAtRebuild = m.kv_rows != null ? Number(m.kv_rows) : null;
    out.dirty = !!(await env.mydukapos_kv.get(OWNER_DIRTY_KEY));
    const list = await readKvIndex(env);
    const income = await readKvIncome(env);
    const rows = (await db.prepare(`SELECT id, summary_json FROM owner_clients`).all()).results || [];
    const incRows = (await db.prepare(`SELECT person_key, data_json FROM owner_group_income`).all()).results || [];
    out.rows = rows.length; out.kvRows = list.length; out.incomeRows = incRows.length; out.kvIncomeKeys = Object.keys(income).length;
    const d = new Map(rows.map((r) => [r.id, r.summary_json]));
    const missing = [], different = [];
    const seen = new Set();
    for (const e of list) {
      if (!e || !e.id) continue;
      seen.add(String(e.id));
      if (!d.has(String(e.id))) missing.push(e.id);
      else { try { if (stable(JSON.parse(d.get(String(e.id)))) !== stable(scrubSummary(e))) different.push(e.id); } catch (x) { different.push(e.id); } }
    }
    const extra = [...d.keys()].filter((id) => !seen.has(id));
    const di = new Map(incRows.map((r) => [r.person_key, r.data_json]));
    let incomeDrift = 0;
    for (const k of Object.keys(income)) { if (!di.has(k)) incomeDrift++; else { try { if (stable(JSON.parse(di.get(k))) !== stable(income[k])) incomeDrift++; } catch (x) { incomeDrift++; } } }
    for (const k of di.keys()) if (!(k in income)) incomeDrift++;
    out.drift = missing.length + extra.length + different.length + incomeDrift;
    out.driftDetail = { missing: missing.slice(0, 20), extra: extra.slice(0, 20), different: different.slice(0, 20), income: incomeDrift };
    out.healthy = await mirrorHealthy(env);
    out.reading = out.healthy;                                          // true = the console list is being served from D1 right now
  } catch (e) {
    out.healthy = false; out.error = String((e && e.message) || e).slice(0, 160);
  }
  return out;
}
