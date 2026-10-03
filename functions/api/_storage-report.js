// functions/api/_storage-report.js — shared helper, NOT a route. (zip 194)
//
// Backs the Owner Console "Databases" card (Storage tab) and its endpoint /api/owner-databases: MONITOR every database the system uses and CLEAN UP.
//
//  * buildReport(env)      one JSON report: for each store (D1 ledger, audit D1, owner D1, KV, per-shop Durable Object databases, R2 buckets) its size,
//                          tables with row counts, the configured limit, percent used. Anything that cannot be measured is null WITH a reason - never a guess.
//  * settings              { limitGb, retention: {<category>: days}, autoCleanup, autoBackup }. Stored in ledger_meta of the main ledger D1 (the one place the
//                          Pages project AND the router Worker both reach) and mirrored in KV when that is bound; the newer copy wins.
//  * runCleanup(env)       archive-then-delete of CLEARLY DISPOSABLE data only (see CATEGORIES). Never touches sales, payments, bills, inventory, customers,
//                          stock movements or any other ledger record: those tables are not named anywhere in this file's DELETE statements.
//  * backupNow(env)        copies the SMALL databases (ledger / owner) to R2 as gzip NDJSON, verified by head size, last 8 runs kept. A database too big to copy
//                          inside one request is skipped with the reason (use `npm run db:backup` / D1 Time Travel for those).
//  * scheduledStorageJobs  called from the router's cron: automatic cleanup at most once a day, weekly backup on Sundays. Never throws.
import { auditDb, auditMaintenance, auditArchiveStatus } from './_audit-db.js';
import { isStorageFull } from './_retry.js';

export const GB = 1000 * 1000 * 1000;                                   // same unit as _ledger-health.js (D1 cap 10 * 1000^3)
export const DAY = 86400000;
export const SETTINGS_KEY = 'storage_settings';
export const CLEANUP_KEY = 'storage_cleanup_state';
export const CLAIM_KEY = 'storage_cleanup_claim';
export const BACKUP_KEY = 'storage_backup_state';
const KV_MIRROR = (k) => 'owner-storage:' + k;
export const BACKUP_PREFIX = 'db-backups/';
export const BACKUP_KEEP = 8;
export const ARCHIVE_PREFIX = 'db-archive/';

const ledgerDb = (env) => (env && (env.LEDGER_DB || env.DB)) || null;
const ownerDb = (env) => (env && env.OWNER_DB) || null;
const archiveBucket = (env) => { const b = env && env.AUDIT_ARCHIVE; return b && typeof b.put === 'function' ? b : null; };
const backupBucket = (env) => { const b = (env && env.DB_BACKUPS) || (env && env.AUDIT_ARCHIVE); return b && typeof b.put === 'function' ? b : null; };
const backupBucketName = (env) => (env && env.DB_BACKUPS && typeof env.DB_BACKUPS.put === 'function' ? 'DB_BACKUPS' : env && env.AUDIT_ARCHIVE && typeof env.AUDIT_ARCHIVE.put === 'function' ? 'AUDIT_ARCHIVE' : null);
const errText = (e) => (isStorageFull(e) ? 'storage_full' : String((e && e.message) || e).slice(0, 200));

/* ---------- categories (what the retention table lists) ---------- */
// Only data that is history or a copy. `temp` rows are listed for honesty but are NOT editable: they carry their own expiry in KV (expirationTtl), so there is
// nothing to prune - and nothing in them is ever kept.
export const CATEGORIES = [
  { id: 'audit', label: 'Audit log (who changed which money record)', store: 'audit', defaultDays: 90, minDays: 7, editable: true },
  { id: 'batches', label: 'Till push log (what each push of money records carried)', store: 'ledger', defaultDays: 365, minDays: 90, editable: true },
  { id: 'shop_backups', label: 'Daily shop backup copies (kept in KV)', store: 'kv', defaultDays: 30, minDays: 14, editable: true },
  { id: 'temp', label: 'Temporary data (password-reset links, pairing codes, M-Pesa pending, print queue)', store: 'kv', defaultDays: null, minDays: null, editable: false },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

/* ---------- small durable key/value: ledger_meta (D1) + KV mirror ---------- */
async function metaGet(env, key) {
  const out = [];
  const db = ledgerDb(env);
  if (db) { try { const r = await db.prepare(`SELECT v FROM ledger_meta WHERE k = ?`).bind(key).first(); if (r && r.v) out.push(JSON.parse(r.v)); } catch (e) { /* no table yet / unreachable: the KV copy may still answer */ } }
  const kv = env && env.mydukapos_kv;
  if (kv && typeof kv.get === 'function') { try { const raw = await kv.get(KV_MIRROR(key)); if (raw) out.push(JSON.parse(raw)); } catch (e) { /* mirror only */ } }
  out.sort((a, b) => (Number(b && b.at) || 0) - (Number(a && a.at) || 0));
  return out[0] || null;
}
// -> { saved: ['ledger_meta', 'kv'] } ; throws only when NOWHERE could be written
async function metaSet(env, key, value) {
  const text = JSON.stringify(value), saved = [], errs = [];
  const db = ledgerDb(env);
  if (db) {
    try {
      await db.prepare(`CREATE TABLE IF NOT EXISTS ledger_meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`).run();
      await db.prepare(`INSERT INTO ledger_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(key, text).run();
      saved.push('ledger_meta');
    } catch (e) { errs.push(errText(e)); }
  }
  const kv = env && env.mydukapos_kv;
  if (kv && typeof kv.put === 'function') { try { await kv.put(KV_MIRROR(key), text); saved.push('kv'); } catch (e) { errs.push(errText(e)); } }
  if (!saved.length) throw new Error(errs[0] || 'there is nowhere to save settings (no LEDGER_DB and no KV binding)');
  return { saved };
}

/* ---------- settings ---------- */
export function defaultSettings(env) {
  const retention = {};
  for (const c of CATEGORIES) if (c.editable) retention[c.id] = c.defaultDays;
  const a = env && env.AUDIT_RETAIN_DAYS != null && env.AUDIT_RETAIN_DAYS !== '' ? Number(env.AUDIT_RETAIN_DAYS) : NaN;
  if (Number.isFinite(a) && a >= CAT.audit.minDays) retention.audit = Math.floor(a);
  return { limitGb: 10, retention, autoCleanup: true, autoBackup: true, at: 0 };
}
export async function loadSettings(env) {
  const d = defaultSettings(env);
  let s = null;
  try { s = await metaGet(env, SETTINGS_KEY); } catch (e) { s = null; }
  if (!s || typeof s !== 'object') return d;
  const retention = { ...d.retention };
  for (const c of CATEGORIES) if (c.editable && s.retention && Number.isFinite(Number(s.retention[c.id])) && Number(s.retention[c.id]) >= c.minDays) retention[c.id] = Math.floor(Number(s.retention[c.id]));
  return {
    limitGb: Number.isFinite(Number(s.limitGb)) && Number(s.limitGb) > 0 ? Number(s.limitGb) : d.limitGb,
    retention, autoCleanup: s.autoCleanup !== false, autoBackup: s.autoBackup !== false, at: Number(s.at) || 0,
  };
}
// the audit retention the router's own cron must use (so a longer period chosen here is never cut back to the 90-day default). -> days | undefined
export async function configuredAuditDays(env) {
  try { const s = await loadSettings(env); return s.at ? s.retention.audit : undefined; } catch (e) { return undefined; }
}
// -> { settings } | { error }
export async function saveSettings(env, input, now = Date.now()) {
  const cur = await loadSettings(env);
  const next = { ...cur, retention: { ...cur.retention } };
  const body = input && typeof input === 'object' ? input : {};
  if (body.limitGb !== undefined) {
    const g = Number(body.limitGb);
    if (!Number.isFinite(g) || g < 0.1 || g > 1000) return { error: 'The size limit must be a number of GB between 0.1 and 1000.' };
    next.limitGb = Math.round(g * 100) / 100;
  }
  if (body.retention !== undefined) {
    if (!body.retention || typeof body.retention !== 'object') return { error: 'retention must be an object of category -> days.' };
    for (const [id, v] of Object.entries(body.retention)) {
      const c = CAT[id];
      if (!c) return { error: `Unknown category “${id}”.` };
      if (!c.editable) return { error: `“${c.label}” cannot be changed: it expires by itself.` };
      const n = Number(v);
      if (!Number.isInteger(n) || n < c.minDays || n > 3650) return { error: `“${c.label}”: keep it between ${c.minDays} and 3650 whole days.` };
      next.retention[id] = n;
    }
  }
  if (body.autoCleanup !== undefined) next.autoCleanup = !!body.autoCleanup;
  if (body.autoBackup !== undefined) next.autoBackup = !!body.autoBackup;
  next.at = now;
  try { const w = await metaSet(env, SETTINGS_KEY, next); return { settings: next, savedIn: w.saved }; }
  catch (e) { return { error: 'Settings could not be saved: ' + errText(e) }; }
}

/* ---------- measuring ---------- */
const pct = (bytes, limit) => (bytes == null || !limit ? null : Math.round((bytes / limit) * 1000) / 10);

async function d1Size(db) {
  try {
    const r = await db.prepare('SELECT 1 AS one').all();
    if (r && r.meta && Number(r.meta.size_after) > 0) return { bytes: Number(r.meta.size_after), source: 'Cloudflare D1 size_after' };
  } catch (e) { /* try the pragma */ }
  try {
    const pc = await db.prepare('PRAGMA page_count').first(), ps = await db.prepare('PRAGMA page_size').first();
    const n = Number(pc && (pc.page_count ?? Object.values(pc)[0])), s = Number(ps && (ps.page_size ?? Object.values(ps)[0]));
    if (n > 0 && s > 0) return { bytes: n * s, source: 'PRAGMA page_count * page_size' };
  } catch (e) { /* fall through */ }
  return { bytes: null, reason: 'this database did not report its size (neither size_after nor page_count answered)' };
}

// -> { tables: [{ name, rows, rowsIsEstimate, bytes }], bytesReason? , error? }
async function d1Tables(db, { budgetMs = 8000 } = {}) {
  const t0 = Date.now();
  let names;
  try {
    const r = await db.prepare(`SELECT name, tbl_name, type FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`).all();
    names = r.results || [];
  } catch (e) { return { tables: [], error: errText(e) }; }
  const tables = names.filter((x) => x.type === 'table').map((x) => ({ name: x.name, rows: null, rowsIsEstimate: false, bytes: null }));
  let bytesReason = null;
  try {
    const r = await db.prepare(`SELECT name, SUM(pgsize) AS b FROM dbstat GROUP BY name`).all();
    const owner = new Map(names.map((x) => [x.name, x.tbl_name]));
    const sum = new Map();
    for (const row of r.results || []) { const t = owner.get(row.name); if (t) sum.set(t, (sum.get(t) || 0) + Number(row.b || 0)); }
    for (const t of tables) if (sum.has(t.name)) t.bytes = sum.get(t.name);
  } catch (e) { bytesReason = 'D1 does not expose per-table sizes here (dbstat); row counts only'; }
  for (const t of tables) {
    if (Date.now() - t0 > budgetMs) { t.rowsReason = 'skipped: the count would take too long'; continue; }
    try {
      if (t.name === 'ledger_audit') {                                  // millions of rows: never COUNT(*) (zip 186) - the id range is an upper bound
        const r = await db.prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM ledger_audit`).first();
        t.rows = r && r.hi != null ? Number(r.hi) - Number(r.lo) + 1 : 0; t.rowsIsEstimate = true;
      } else {
        const r = await db.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).first();
        t.rows = Number(r && r.n);
      }
    } catch (e) { t.rowsReason = errText(e); }
  }
  return { tables, ...(bytesReason ? { bytesReason } : {}) };
}

async function inspectD1(env, { id, name, binding, db, role, limitBytes, lastCleanupNote }) {
  const out = { id, name, kind: 'd1', binding, role, bound: !!db, sizeBytes: null, sizeSource: null, sizeReason: null, limitBytes, pctUsed: null, tables: [], notes: [] };
  if (!db) { out.sizeReason = `not bound on this project (${binding})`; return out; }
  const s = await d1Size(db);
  out.sizeBytes = s.bytes; out.sizeSource = s.source || null; out.sizeReason = s.bytes == null ? s.reason : null;
  out.pctUsed = pct(s.bytes, limitBytes);
  const t = await d1Tables(db);
  out.tables = t.tables;
  if (t.error) out.error = t.error;
  if (t.bytesReason) out.tablesBytesReason = t.bytesReason;
  const total = t.tables.reduce((n, x) => n + (Number.isFinite(x.rows) ? x.rows : 0), 0);
  out.totalRows = t.tables.some((x) => Number.isFinite(x.rows)) ? total : null;
  if (lastCleanupNote) out.notes.push(lastCleanupNote);
  return out;
}

async function kvGroup(kv, prefix, label, { maxPages = 5 } = {}) {
  const g = { prefix, label, keys: 0, keysComplete: true, bytesKnown: null, bytesKnownKeys: 0 };
  let cursor, sum = 0;
  try {
    for (let i = 0; i < maxPages; i++) {
      const res = await kv.list({ prefix, cursor, limit: 1000 });
      for (const k of res.keys || []) { g.keys++; const b = k.metadata && Number(k.metadata.bytes); if (Number.isFinite(b)) { sum += b; g.bytesKnownKeys++; } }
      if (res.list_complete || !res.cursor) { cursor = null; break; }
      cursor = res.cursor;
      if (i === maxPages - 1) g.keysComplete = false;
    }
  } catch (e) { g.error = errText(e); g.keys = null; g.keysComplete = false; }
  if (g.bytesKnownKeys) g.bytesKnown = sum;
  return g;
}
async function inspectKv(env) {
  const out = { id: 'kv', name: 'Settings & shop records (KV)', kind: 'kv', binding: 'mydukapos_kv', bound: !!(env && env.mydukapos_kv), sizeBytes: null, sizeReason: 'Cloudflare does not tell a Worker how much a KV namespace holds (only key counts can be listed)', limitBytes: null, pctUsed: null, tables: [], groups: [], notes: ['Counts stop at 5,000 keys per group (“at least”).'] };
  if (!out.bound) { out.sizeReason = 'not bound on this project (mydukapos_kv)'; return out; }
  const kv = env.mydukapos_kv;
  out.groups = await Promise.all([
    kvGroup(kv, 'pos-data:state:', 'Shop records (one per shop kept as a single record)'),
    kvGroup(kv, 'pos-data:backup:', 'Daily shop backup copies'),
    kvGroup(kv, 'pos-data:mode:', 'Shops that live in their own database'),
    kvGroup(kv, 'license:', 'Licences (shop links)'),
  ]);
  return out;
}

async function inspectShopStore(env) {
  const out = { id: 'shop_store', name: 'Per-shop databases (Durable Objects)', kind: 'do', binding: 'SHOP_STORE', bound: !!(env && env.SHOP_STORE), sizeBytes: null, sizeReason: null, limitBytes: null, pctUsed: null, tables: [], notes: [], shops: [] };
  if (!out.bound) { out.sizeReason = 'not bound on this project (SHOP_STORE)'; return out; }
  const kv = env.mydukapos_kv;
  if (!kv) { out.sizeReason = 'cannot list which shops use a database: mydukapos_kv is not bound'; return out; }
  const ids = [];
  let cursor, complete = true;
  try {
    for (let i = 0; i < 5; i++) {
      const res = await kv.list({ prefix: 'pos-data:mode:', cursor, limit: 1000 });
      for (const k of res.keys || []) ids.push(k.name.slice('pos-data:mode:'.length));
      if (res.list_complete || !res.cursor) { cursor = null; break; }
      cursor = res.cursor;
      if (i === 4) complete = false;
    }
  } catch (e) { out.sizeReason = 'could not list the shops: ' + errText(e); return out; }
  out.shopsInOwnDb = ids.length;
  const MAX = 30, pick = ids.slice(0, MAX);
  let total = 0, got = 0;
  for (let i = 0; i < pick.length; i += 6) {
    await Promise.all(pick.slice(i, i + 6).map(async (id) => {
      try {
        const stub = env.SHOP_STORE.get(env.SHOP_STORE.idFromName(id));
        const res = await stub.fetch('https://shop-store/stats', { method: 'POST', body: '{}' });
        const j = res.ok ? await res.json() : null;
        if (j && Number.isFinite(Number(j.bytes))) { total += Number(j.bytes); got++; out.shops.push({ id, bytes: Number(j.bytes), records: (j.collections || []).reduce((n, c) => n + (Number(c.n) || 0), 0) }); }
      } catch (e) { /* that shop did not answer: it is simply not counted */ }
    }));
  }
  out.shops.sort((a, b) => b.bytes - a.bytes);
  out.shops = out.shops.slice(0, 10);
  out.measured = got;
  if (got) out.sizeBytes = total; else out.sizeReason = ids.length ? 'no shop database answered the size request' : 'no shop has been moved to its own database yet';
  if (ids.length > MAX || !complete) out.notes.push(`Only the first ${MAX} shop databases were measured, so the size is “at least” this much.`);
  return out;
}

async function inspectR2(env, binding, label) {
  const b = env && env[binding];
  const out = { id: 'r2:' + binding, name: label, kind: 'r2', binding, bound: !!(b && typeof b === 'object'), sizeBytes: null, sizeReason: null, limitBytes: null, pctUsed: null, tables: [], notes: [] };
  if (!out.bound) { out.sizeReason = `not bound on this project (${binding})`; return out; }
  if (typeof b.list !== 'function') { out.sizeReason = 'this bucket binding cannot list objects'; return out; }
  let cursor, objs = 0, bytes = 0, complete = true;
  try {
    for (let i = 0; i < 5; i++) {
      const res = await b.list({ cursor, limit: 1000 });
      for (const o of res.objects || []) { objs++; bytes += Number(o.size) || 0; }
      if (!res.truncated || !res.cursor) { complete = true; break; }
      cursor = res.cursor; complete = false;
    }
  } catch (e) { out.sizeReason = 'listing failed: ' + errText(e); return out; }
  out.sizeBytes = bytes; out.objects = objs; out.objectsComplete = complete;
  if (!complete) out.notes.push('Counted the first 5,000 objects only, so this is “at least”.');
  return out;
}

/* ---------- backups: state + what is in R2 ---------- */
async function listBackupRuns(bucket) {
  if (!bucket || typeof bucket.list !== 'function') return null;
  const runs = new Map();
  let cursor;
  for (let i = 0; i < 5; i++) {
    const res = await bucket.list({ prefix: BACKUP_PREFIX, cursor, limit: 1000 });
    for (const o of res.objects || []) { const run = String(o.key).slice(BACKUP_PREFIX.length).split('/')[0]; const r = runs.get(run) || { runId: run, files: 0, bytes: 0, keys: [] }; r.files++; r.bytes += Number(o.size) || 0; r.keys.push(o.key); runs.set(run, r); }
    if (!res.truncated || !res.cursor) break;
    cursor = res.cursor;
  }
  return [...runs.values()].sort((a, b) => (a.runId < b.runId ? 1 : -1));
}

export async function backupStatus(env) {
  const bucket = backupBucket(env);
  const state = await metaGet(env, BACKUP_KEY).catch(() => null);
  const out = { bucket: backupBucketName(env), configured: !!bucket, last: state, runs: null, runsReason: null, keep: BACKUP_KEEP, schedule: 'every Sunday (router cron)', timeTravel: 'Cloudflare D1 also keeps its own point-in-time history (Time Travel, restorable with wrangler); it is a Cloudflare feature and is not measured here.' };
  if (!bucket) { out.runsReason = 'no R2 bucket is bound for backups (DB_BACKUPS or AUDIT_ARCHIVE)'; return out; }
  try { out.runs = (await listBackupRuns(bucket)).map((r) => ({ runId: r.runId, files: r.files, bytes: r.bytes })); } catch (e) { out.runsReason = 'listing failed: ' + errText(e); }
  return out;
}

/* ---------- the report ---------- */
export async function buildReport(env, { now = Date.now() } = {}) {
  const settings = await loadSettings(env);
  const limitBytes = Math.round(settings.limitGb * GB);
  const lastCleanup = await metaGet(env, CLEANUP_KEY).catch(() => null);
  const adb = auditDb(env);
  const stores = await Promise.all([
    inspectD1(env, { id: 'ledger', name: 'Sales ledger (D1)', binding: 'LEDGER_DB', db: ledgerDb(env), role: 'Every sale, payment, bill, stock movement, QR order. Never cleaned.', limitBytes }),
    inspectD1(env, { id: 'audit', name: 'Audit database (D1)', binding: 'LEDGER_AUDIT_DB', db: adb, role: 'History of changes to money records. Old rows are archived to R2 and removed.', limitBytes }),
    inspectD1(env, { id: 'owner', name: 'Owner database (D1)', binding: 'OWNER_DB', db: ownerDb(env), role: 'Read model of the Owner Console list (KV is the source of truth).', limitBytes }),
    inspectKv(env),
    inspectShopStore(env),
    inspectR2(env, 'AUDIT_ARCHIVE', 'Archive bucket (R2)'),
    inspectR2(env, 'DB_BACKUPS', 'Backups bucket (R2)'),
    inspectR2(env, 'MEDIA', 'Pictures bucket (R2)'),
  ]);
  const archive = archiveBucket(env);
  let auditState = null;
  try { auditState = adb ? await auditArchiveStatus(env) : null; } catch (e) { auditState = null; }
  const cats = CATEGORIES.map((c) => {
    const row = { id: c.id, label: c.label, store: c.store, editable: c.editable, days: c.editable ? settings.retention[c.id] : null, defaultDays: c.defaultDays, minDays: c.minDays, available: true, archivedFirst: null, note: null };
    if (c.id === 'audit') {
      row.available = !!adb; row.archivedFirst = !!archive;
      row.note = !adb ? 'The audit database (LEDGER_AUDIT_DB) is not bound; the audit rows in the main ledger are guarded and are only pruned with tools/prune-audit.mjs.' : archive ? 'Archived to R2 first (verified), then removed.' : 'No archive bucket is bound on this project, so old rows are REMOVED WITHOUT an archive.';
    } else if (c.id === 'batches') {
      row.available = !!ledgerDb(env); row.archivedFirst = true;
      row.note = !archive ? 'Needs the archive bucket (AUDIT_ARCHIVE): without it this is not pruned.' : 'Archived to R2 first (verified), then removed.';
    } else if (c.id === 'shop_backups') {
      row.available = !!(env && env.mydukapos_kv); row.archivedFirst = false;
      row.note = 'These are already copies of shop data, so nothing is archived first.';
    } else if (c.id === 'temp') {
      row.archivedFirst = false; row.note = 'Expires by itself (each entry carries its own time-to-live); not editable.';
    }
    return row;
  });
  const d1s = stores.filter((s) => s.kind === 'd1' && s.bound);
  const totalD1 = d1s.every((s) => s.sizeBytes != null) && d1s.length ? d1s.reduce((n, s) => n + s.sizeBytes, 0) : null;
  return {
    ok: true, serverNow: now, settings: { limitGb: settings.limitGb, retention: settings.retention, autoCleanup: settings.autoCleanup, autoBackup: settings.autoBackup, savedAt: settings.at || null },
    limit: { gb: settings.limitGb, bytes: limitBytes, note: 'Cloudflare D1: 0.5 GB per database on the free plan (5 GB per account), 10 GB per database on the paid plan. Set this to your plan.' },
    totalD1Bytes: totalD1, stores, categories: cats, lastCleanup, auditArchive: auditState, backups: await backupStatus(env),
  };
}

/* ---------- cleanup ---------- */
async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const BATCH_ROWS = 5000, BATCH_MAX_FILES = 4, KV_MAX_PAGES = 10, KV_MAX_DELETES = 2000;

// ledger_batches (client_id, batch_id, at, records, source): a log of pushes; no record depends on it. Archive to R2 (verified), then delete exactly the rows archived.
async function pruneBatches(env, days, now) {
  const db = ledgerDb(env), r2 = archiveBucket(env);
  if (!db) return { skipped: 'the sales ledger is not bound' };
  if (!r2) return { skipped: 'no archive bucket (AUDIT_ARCHIVE) is bound, so this log is left alone' };
  const cutoff = now - days * DAY, month = new Date(now).toISOString().slice(0, 7);
  let archived = 0, removed = 0, files = 0;
  for (let i = 0; i < BATCH_MAX_FILES; i++) {
    const res = await db.prepare(`SELECT client_id, batch_id, at, records, source FROM ledger_batches WHERE at < ? ORDER BY at LIMIT ?`).bind(cutoff, BATCH_ROWS).all();
    const got = (res && res.results) || [];
    if (!got.length) break;
    const bytes = await gzipText(got.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const key = `${ARCHIVE_PREFIX}ledger_batches/${month}/ledger_batches_${got[0].at}-${got[got.length - 1].at}_${now}_${i}.ndjson.gz`;
    await r2.put(key, bytes, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { rows: String(got.length) } });
    const head = typeof r2.head === 'function' ? await r2.head(key) : null;
    if (!head || Number(head.size) !== bytes.length) throw new Error('archive verify failed for ' + key);
    for (let j = 0; j < got.length; j += 80) {
      const part = got.slice(j, j + 80);
      const out = await db.batch(part.map((x) => db.prepare(`DELETE FROM ledger_batches WHERE client_id = ? AND batch_id = ? AND at < ?`).bind(x.client_id, x.batch_id, cutoff)));
      removed += out.reduce((n, o) => n + (Number(o && o.meta && o.meta.changes) || 0), 0);
    }
    archived += got.length; files++;
    if (got.length < BATCH_ROWS) break;
  }
  return { archived, removed, files };
}

// daily backup copies in KV: pos-data:backup:<clientId>:<YYYY-MM-DD> and ...:pre-restore-<ms>. Never the ':last-date' marker.
async function pruneShopBackups(env, days, now) {
  const kv = env && env.mydukapos_kv;
  if (!kv) return { skipped: 'KV is not bound' };
  const cutoff = now - days * DAY, cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
  let cursor, removed = 0, seen = 0;
  for (let p = 0; p < KV_MAX_PAGES && removed < KV_MAX_DELETES; p++) {
    const res = await kv.list({ prefix: 'pos-data:backup:', cursor, limit: 1000 });
    for (const k of res.keys || []) {
      seen++;
      const d = /:(\d{4}-\d{2}-\d{2})$/.exec(k.name), pr = /:pre-restore-(\d+)$/.exec(k.name);
      const old = d ? d[1] < cutoffDate : pr ? Number(pr[1]) < cutoff : false;
      if (old && removed < KV_MAX_DELETES) { await kv.delete(k.name); removed++; }
    }
    if (res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  return { archived: 0, removed, scanned: seen };
}

export async function runCleanup(env, { now = Date.now(), trigger = 'manual' } = {}) {
  const settings = await loadSettings(env);
  const results = [];
  const add = (id, r) => results.push({ id, label: CAT[id].label, archived: Number(r.archived) || 0, removed: Number(r.removed) || 0, ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.error ? { error: r.error } : {}), ...(r.note ? { note: r.note } : {}) });
  // 1. audit: the existing monthly archive-then-prune (needs the bucket; without it the existing plain bounded trim)
  try {
    if (!auditDb(env)) add('audit', { skipped: 'the audit database (LEDGER_AUDIT_DB) is not bound' });
    else { const r = await auditMaintenance(env, { now, days: settings.retention.audit, force: trigger === 'manual' }); add('audit', { archived: r.archived, removed: r.deleted, error: r.error, skipped: r.skipped === 'done_this_month' ? 'already done this month' : r.skipped, note: r.note === 'no_archive_bucket' ? 'no archive bucket bound: removed without an archive' : null }); }
  } catch (e) { add('audit', { error: errText(e) }); }
  // 2. the till push log
  try { add('batches', await pruneBatches(env, settings.retention.batches, now)); } catch (e) { add('batches', { error: errText(e) }); }
  // 3. old shop backup copies
  try { add('shop_backups', await pruneShopBackups(env, settings.retention.shop_backups, now)); } catch (e) { add('shop_backups', { error: errText(e) }); }
  // 4. temporary data: nothing to do, they expire by themselves
  add('temp', { skipped: 'expires by itself' });
  const errors = results.filter((r) => r.error).map((r) => `${r.label}: ${r.error}`);
  const state = { at: now, trigger, ok: errors.length === 0, archived: results.reduce((n, r) => n + r.archived, 0), removed: results.reduce((n, r) => n + r.removed, 0), results, errors };
  try { await metaSet(env, CLEANUP_KEY, state); } catch (e) { state.notSaved = errText(e); }
  return state;
}

/* ---------- backup ---------- */
function runIdOf(t) { return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }
export const BACKUP_SKIP_TABLES = new Set(['ledger_audit']);              // history with its own monthly archive; can be millions of rows
const backupMaxRows = (env) => { const n = env && env.BACKUP_MAX_ROWS != null && env.BACKUP_MAX_ROWS !== '' ? Number(env.BACKUP_MAX_ROWS) : 50000; return Number.isFinite(n) && n > 0 ? n : 50000; };

async function dumpDb(env, name, db, bucket, runId) {
  const t = await d1Tables(db, { budgetMs: 15000 });
  if (t.error) throw new Error(t.error);
  const tables = t.tables.filter((x) => !BACKUP_SKIP_TABLES.has(x.name));
  if (tables.some((x) => !Number.isFinite(x.rows))) return { name, skipped: 'some tables could not be counted, so the copy was not attempted' };
  const total = tables.reduce((n, x) => n + x.rows, 0), max = backupMaxRows(env);
  if (total > max) return { name, skipped: `${total.toLocaleString('en-US')} rows is more than one request can copy safely (limit ${max.toLocaleString('en-US')}); use npm run db:backup or D1 Time Travel for this database`, rows: total };
  const lines = [JSON.stringify({ meta: { db: name, at: Date.now(), tables: Object.fromEntries(tables.map((x) => [x.name, x.rows])) } })];
  for (const tb of tables) {
    const r = await db.prepare(`SELECT * FROM "${tb.name.replace(/"/g, '""')}"`).all();
    const rows = (r && r.results) || [];
    if (rows.length !== tb.rows && Math.abs(rows.length - tb.rows) > 50) throw new Error(`table ${tb.name} changed while copying`);
    for (const row of rows) lines.push(JSON.stringify({ t: tb.name, r: row }));
  }
  const bytes = await gzipText(lines.join('\n') + '\n');
  const key = `${BACKUP_PREFIX}${runId}/${name}.ndjson.gz`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { db: name, rows: String(total) } });
  const head = typeof bucket.head === 'function' ? await bucket.head(key) : null;
  if (!head || Number(head.size) !== bytes.length) throw new Error('backup verify failed for ' + key);
  return { name, rows: total, bytes: bytes.length, key };
}

export async function backupNow(env, { now = Date.now(), trigger = 'manual' } = {}) {
  const bucket = backupBucket(env);
  if (!bucket) return { ok: false, notConfigured: true, error: 'No R2 bucket is bound for backups. Bind DB_BACKUPS (or AUDIT_ARCHIVE) — see docs/OWNER_STORAGE_194.md.' };
  const runId = runIdOf(now), dbs = [], errors = [];
  for (const [name, db] of [['ledger', ledgerDb(env)], ['owner', ownerDb(env)]]) {
    if (!db) { dbs.push({ name, skipped: 'not bound' }); continue; }
    try { dbs.push(await dumpDb(env, name, db, bucket, runId)); } catch (e) { const m = errText(e); dbs.push({ name, error: m }); errors.push(`${name}: ${m}`); }
  }
  const done = dbs.filter((d) => d.key);
  let kept = null;
  if (done.length) {                                                    // prune old runs only after this one is verified
    try {
      const runs = await listBackupRuns(bucket);
      kept = Math.min(BACKUP_KEEP, runs.length);
      for (const r of runs.slice(BACKUP_KEEP)) for (const k of r.keys) await bucket.delete(k);
    } catch (e) { errors.push('pruning old backups: ' + errText(e)); }
  }
  const skipped = dbs.filter((d) => d.skipped && d.skipped !== 'not bound');
  const state = { at: now, trigger, ok: errors.length === 0 && done.length > 0 && skipped.length === 0, partial: done.length > 0 && (skipped.length > 0 || errors.length > 0), runId, rows: done.reduce((n, d) => n + d.rows, 0), bytes: done.reduce((n, d) => n + d.bytes, 0), dbs, kept, errors, error: errors[0] || (!done.length ? 'nothing was backed up' + (skipped[0] ? ': ' + skipped[0].skipped : '') : skipped[0] ? `${skipped[0].name}: ${skipped[0].skipped}` : null) };
  try { await metaSet(env, BACKUP_KEY, state); } catch (e) { state.notSaved = errText(e); }
  return state;
}

/* ---------- the router's cron ---------- */
// At most one automatic cleanup per ~20 h (the last-run marker is the stored state's own timestamp, claimed BEFORE the work so two firings do not overlap), the weekly
// backup on Sundays (UTC). Never throws, never blocks the caller.
export async function scheduledStorageJobs(env, { now = Date.now() } = {}) {
  const out = {};
  try {
    const settings = await loadSettings(env);
    const last = await metaGet(env, CLEANUP_KEY), claim = await metaGet(env, CLAIM_KEY);
    const recent = (t) => t && now - Number(t) < 20 * 3600000;
    if (settings.autoCleanup && !recent(last && last.at) && !recent(claim && claim.at)) {
      try { await metaSet(env, CLAIM_KEY, { at: now }); } catch (e) { /* the state written below is the real marker */ }
      out.cleanup = await runCleanup(env, { now, trigger: 'automatic' });
      try { console.log('storage cleanup:', JSON.stringify({ archived: out.cleanup.archived, removed: out.cleanup.removed, errors: out.cleanup.errors })); } catch (e) { /* log only */ }
    } else out.cleanup = { skipped: settings.autoCleanup ? 'already ran in the last 20 hours' : 'automatic cleanup is switched off' };
    const lb = await metaGet(env, BACKUP_KEY);
    if (settings.autoBackup && backupBucket(env) && new Date(now).getUTCDay() === 0 && !(lb && now - Number(lb.at) < 6 * DAY)) {
      out.backup = await backupNow(env, { now, trigger: 'automatic' });
      try { console.log('storage backup:', JSON.stringify({ ok: out.backup.ok, rows: out.backup.rows, error: out.backup.error })); } catch (e) { /* log only */ }
    }
  } catch (e) { out.error = errText(e); try { console.error('storage jobs failed:', out.error); } catch (x) { /* log only */ } }
  return out;
}
