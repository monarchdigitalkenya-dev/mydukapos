// functions/api/_audit-db.js — the SEPARATE audit database (zip 187). NOT a route.
//
// WHY. In the zip 186 incident the append-only `ledger_audit` table grew to 21.8M rows and filled the 10 GB D1 cap of the ONE database that also
// holds every sale, so selling stopped. The audit trail is useful history, not something a sale may depend on. It now lives in its own D1
// (binding LEDGER_AUDIT_DB, database `mydukapos-audit`): if that database ever fills up, sales keep saving in the main ledger.
//
// HOW. A D1 trigger cannot write into another database, so the server writes the audit rows itself, in ONE batch right AFTER the main ledger batch
// committed, only for records that really changed (the upsert said changes > 0). Rules:
//  * best effort, never throws: a failure here can never fail, delay (beyond one small write) or roll back a sale;
//  * a full audit database (SQLITE 7500) or any other failure pauses audit writes for AUDIT_PAUSE_MS (5 min) in this isolate, then tries again;
//  * the kill switch (ledger_meta audit_disabled, env AUDIT_WRITES_DISABLED, KV audit:disabled) is honoured by the caller;
//  * with no LEDGER_AUDIT_DB binding nothing changes: the old triggers in the main ledger keep writing (they are only removed when this is bound).
import { isStorageFull } from './_retry.js';

export const auditDb = (env) => (env && env.LEDGER_AUDIT_DB) || null;

export const AUDIT_SCHEMA_VERSION = 1;
// Same columns as the main ledger's ledger_audit, so old tools and queries read it unchanged. No delete guard here: pruning is a plain DELETE.
export const AUDIT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ledger_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  rec_id TEXT NOT NULL,
  action TEXT NOT NULL,
  version INTEGER,
  amount REAL,
  status TEXT,
  actor TEXT,
  source TEXT,
  at INTEGER NOT NULL,
  snapshot TEXT
)`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_audit_rec ON ledger_audit (client_id, kind, rec_id)`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_audit_at ON ledger_audit (at)`,
  `CREATE TABLE IF NOT EXISTS ledger_meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`,
];

const ready = new WeakMap();
export async function ensureAuditSchema(db) {
  if (!db) return false;
  if (ready.get(db)) return true;
  let ok = false;
  try { const r = await db.prepare(`SELECT v FROM ledger_meta WHERE k = 'schema'`).first(); ok = !!(r && Number(r.v) >= AUDIT_SCHEMA_VERSION); } catch (e) { ok = false; }
  if (!ok) {
    await db.batch(AUDIT_SCHEMA.map((s) => db.prepare(s)));
    await db.prepare(`INSERT INTO ledger_meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(AUDIT_SCHEMA_VERSION)).run();
  }
  ready.set(db, true);
  return true;
}

// The history copy is the record itself, except a huge one gets a small valid-JSON stub (same limits as the old trigger: 2000 chars for a stock
// movement, 16000 for every money kind); the full current record is always in the main ledger.
export function snapshotOf(kind, data, status, amount, version) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const max = kind === 'stock_move' ? 2000 : 16000;
  if (text.length <= max) return text;
  return JSON.stringify({ truncated: 1, len: text.length, kind, status, amount, version });
}

const pausedUntil = new WeakMap();                                    // audit D1 binding -> time before which no audit write is attempted
const pauseMs = (env) => { const n = env && env.AUDIT_PAUSE_MS != null && env.AUDIT_PAUSE_MS !== '' ? Number(env.AUDIT_PAUSE_MS) : 300000; return Number.isFinite(n) && n >= 0 ? n : 300000; };
export const auditPausedUntil = (db) => pausedUntil.get(db) || 0;
export const clearAuditPause = (db) => { if (db) pausedUntil.delete(db); };

const INSERT = `INSERT INTO ledger_audit (client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const BATCH_MAX = 80;

// rows: [{ clientId, kind, recId, action, version, amount, status, actor, source, at, snapshot }]. -> { written, skipped?: 'no_db' | 'paused', error? }. Never throws.
export async function writeAuditRows(env, rows, now = Date.now()) {
  const db = auditDb(env);
  if (!db) return { written: 0, skipped: 'no_db' };
  if (!rows || !rows.length) return { written: 0 };
  if (now < auditPausedUntil(db)) return { written: 0, skipped: 'paused' };
  try {
    await ensureAuditSchema(db);
    let written = 0;
    for (let i = 0; i < rows.length; i += BATCH_MAX) {
      const part = rows.slice(i, i + BATCH_MAX);
      await db.batch(part.map((r) => db.prepare(INSERT).bind(r.clientId, r.kind, r.recId, r.action || 'WRITE', r.version == null ? null : r.version, r.amount == null ? null : r.amount,
        r.status == null ? null : r.status, r.actor == null ? null : r.actor, r.source == null ? null : r.source, r.at, r.snapshot == null ? null : r.snapshot)));
      written += part.length;
    }
    return { written };
  } catch (e) {
    pausedUntil.set(db, now + pauseMs(env));
    try { console.error('audit write failed (paused ' + Math.round(pauseMs(env) / 1000) + ' s):', e && e.message); } catch (x) { /* logging only */ }
    return { written: 0, error: isStorageFull(e) ? 'storage_full' : String((e && e.message) || e).slice(0, 120) };
  }
}

// With the audit database bound, the main ledger's audit TRIGGERS are redundant (and are what filled it): remove them, once per isolate. Fails
// quietly (a full main database cannot take a DROP: the next cold start tries again); the audit rows are written by the server meanwhile.
const detached = new WeakMap();
export async function detachMainAuditTriggers(db) {
  if (!db || detached.get(db)) return false;
  try {
    await db.batch([db.prepare(`DROP TRIGGER IF EXISTS audit_ledger_records_ins`), db.prepare(`DROP TRIGGER IF EXISTS audit_ledger_records_upd`)]);
    detached.set(db, true);
    return true;
  } catch (e) { return false; }
}
export const clearDetached = (db) => { if (db) detached.delete(db); };

// RETENTION. The audit trail is kept AUDIT_RETAIN_DAYS (default 90) days; older rows are deleted a bounded amount at a time (default 20000 per call) so
// the audit database can never grow without limit again. Called by the router's cron (every 6 h). Never throws. -> { deleted, skipped? , error? }
export async function trimAudit(env, { now = Date.now(), days, limit } = {}) {
  const db = auditDb(env);
  if (!db) return { deleted: 0, skipped: 'no_db' };
  const d = days != null ? Number(days) : (env && env.AUDIT_RETAIN_DAYS != null && env.AUDIT_RETAIN_DAYS !== '' ? Number(env.AUDIT_RETAIN_DAYS) : 90);
  if (!Number.isFinite(d) || d <= 0) return { deleted: 0, skipped: 'off' };
  const lim = Math.max(100, Math.min(100000, Number(limit) || 20000));
  try {
    await ensureAuditSchema(db);
    const cutoff = now - d * 86400000;
    const r = await db.prepare(`DELETE FROM ledger_audit WHERE id IN (SELECT id FROM ledger_audit WHERE at < ? ORDER BY id LIMIT ?)`).bind(cutoff, lim).run();
    return { deleted: Number(r && r.meta && r.meta.changes) || 0 };
  } catch (e) { return { deleted: 0, error: isStorageFull(e) ? 'storage_full' : String((e && e.message) || e).slice(0, 120) }; }
}

// MONTHLY ARCHIVE + PRUNE (zip 188). With an R2 bucket bound as AUDIT_ARCHIVE (on the router Worker, which runs the cron), once a month the audit rows older
// than AUDIT_RETAIN_DAYS (default 90) are first written to R2 as gzip NDJSON (audit-archive/YYYY-MM/ledger_audit_<fromId>-<toId>.ndjson.gz, one row per line,
// all columns, same format as tools/archive-audit.mjs) and ONLY THEN deleted from the audit database - and only the exact id range that was archived and
// verified (R2 head: the stored size equals what was sent). Any failure (R2 down, size mismatch, D1 error) deletes nothing and is retried at the next firing.
// A big backlog is worked off a few files per firing (MAX_FILES x ARCHIVE_ROWS rows): the state row 'archive_state' keeps `backlog` true until it is empty, so
// the cron keeps going every 6 h until caught up, then sleeps until next month. Without the bucket this falls back to trimAudit (plain retention). Never throws.
export const ARCHIVE_ROWS = 5000;
export const ARCHIVE_MAX_FILES = 8;
const monthOf = (t) => new Date(t).toISOString().slice(0, 7);

async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function getState(db) {
  try { const r = await db.prepare(`SELECT v FROM ledger_meta WHERE k = 'archive_state'`).first(); return r && r.v ? JSON.parse(r.v) : {}; } catch (e) { return {}; }
}
async function putState(db, st) {
  try { await db.prepare(`INSERT INTO ledger_meta (k, v) VALUES ('archive_state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(JSON.stringify(st)).run(); } catch (e) { /* state is advisory */ }
}
export async function auditArchiveStatus(env) {
  const db = auditDb(env);
  if (!db) return { bound: false };
  try { await ensureAuditSchema(db); } catch (e) { return { bound: true, error: String((e && e.message) || e).slice(0, 120) }; }
  return { bound: true, bucket: !!(env && env.AUDIT_ARCHIVE), ...(await getState(db)) };
}

export async function auditMaintenance(env, { now = Date.now(), days, force = false, rows = ARCHIVE_ROWS, maxFiles = ARCHIVE_MAX_FILES } = {}) {
  const db = auditDb(env);
  if (!db) return { skipped: 'no_db', deleted: 0, archived: 0 };
  const r2 = env && env.AUDIT_ARCHIVE;
  if (!r2 || typeof r2.put !== 'function') return { ...(await trimAudit(env, { now, days })), archived: 0, note: 'no_archive_bucket' };
  const d = days != null ? Number(days) : (env.AUDIT_RETAIN_DAYS != null && env.AUDIT_RETAIN_DAYS !== '' ? Number(env.AUDIT_RETAIN_DAYS) : 90);
  if (!Number.isFinite(d) || d <= 0) return { skipped: 'off', deleted: 0, archived: 0 };
  try {
    await ensureAuditSchema(db);
    const st = await getState(db);
    const cur = monthOf(now);
    if (!force && st.month === cur && !st.backlog) return { skipped: 'done_this_month', deleted: 0, archived: 0 };
    const cutoff = now - d * 86400000;
    let archived = 0, deleted = 0, files = 0, backlog = false;
    for (let i = 0; i < maxFiles; i++) {
      const res = await db.prepare(`SELECT id, client_id, kind, rec_id, action, version, amount, status, actor, source, at, snapshot FROM ledger_audit WHERE at < ? ORDER BY id LIMIT ?`).bind(cutoff, rows).all();
      const got = (res && res.results) || [];
      if (!got.length) break;
      const from = Number(got[0].id), to = Number(got[got.length - 1].id);
      const bytes = await gzipText(got.map((x) => JSON.stringify(x)).join('\n') + '\n');
      const key = `audit-archive/${cur}/ledger_audit_${from}-${to}.ndjson.gz`;
      await r2.put(key, bytes, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { rows: String(got.length), from: String(from), to: String(to), sha256: await sha256Hex(bytes) } });
      const head = typeof r2.head === 'function' ? await r2.head(key) : null;
      if (!head || Number(head.size) !== bytes.length) throw new Error('archive verify failed for ' + key);
      const del = await db.prepare(`DELETE FROM ledger_audit WHERE id BETWEEN ? AND ? AND at < ?`).bind(from, to, cutoff).run();
      archived += got.length; files++; deleted += Number(del && del.meta && del.meta.changes) || 0;
      if (got.length < rows) break;
      if (i === maxFiles - 1) backlog = true;
    }
    await putState(db, { month: cur, at: now, backlog, archived, deleted, files, cutoff, error: null });
    return { archived, deleted, files, backlog };
  } catch (e) {
    const msg = isStorageFull(e) ? 'storage_full' : String((e && e.message) || e).slice(0, 160);
    try { await putState(db, { ...(await getState(db)), error: msg, errorAt: now, backlog: true }); } catch (x) { /* advisory */ }
    return { archived: 0, deleted: 0, error: msg };
  }
}
