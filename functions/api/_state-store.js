// functions/api/_state-store.js — shared helper, NOT a route.
//
// Every read and write of a shop's synced state (KV key `pos-data:state:<id>`) goes through here, so:
//
//  1. SIZE IS ALWAYS KNOWN. Each write attaches KV *metadata* { bytes, stored, gz, at, writers }.
//     KV `list()` returns metadata without reading any value, so the Owner Console's 💾 Storage tab can
//     rank every shop by size in a handful of calls instead of downloading every shop's data.
//  2. A shop can be stored GZIPPED (lossless). KV values are capped at 25 MiB; JSON compresses ~5-10x.
//     The stored text is `gz1:` + base64(gzip(json)). Readers accept BOTH formats, so nothing changes for
//     a shop until it is compressed — by the Owner Console button, or automatically once its raw JSON
//     reaches the auto-compress threshold. A compressed shop stays compressed on later pushes.
//  3. THE SIZE GUARD lives in pos-sync.js and uses the numbers from here (see sizePolicy()).
//
// Limits are on the RAW (uncompressed) JSON size, because that is what a Worker must parse, merge and
// re-serialise on every push. Tune with environment variables, no redeploy of code needed:
//   SYNC_WARN_BYTES          default  4 MiB — shop shows "Large" in the Owner Console
//   SYNC_MAX_BYTES           default 12 MiB — pushes above this are refused (HTTP 413) instead of failing
//   SYNC_AUTO_COMPRESS_BYTES default  8 MiB — pushes at/above this are stored gzipped; "off" disables
//
// WHY 12 MiB, not the 25 MiB KV cap: measured on the real push code (Node/V8 as a stand-in for a Worker), one push of a
// shop needs roughly 6-8x its raw size in memory — ~45 MB extra at 4 MiB, ~65 MB at 8 MiB, ~130 MB at 16 MiB — and a
// Worker has 128 MB in total. So the ceiling that really bites is memory, well before KV's 25 MiB. Gzip-at-rest helps
// KV storage and the KV cap, NOT that memory ceiling; only shrinking the shop (archiving old history) does.
// These defaults are conservative; measure on staging (STAGING_SETUP.md, step 4) and raise them if you can.

import { mergeIncomingState, CLOCK_DRIFT_MIN_MS } from './_merge.js';
import { withRetry } from './_retry.js';
import { fenceOpen, fenceWaitVisible, fenceClaim, fenceRelease } from './_write-fence.js';

export const GZ_PREFIX = 'gz1:';
export const MIB = 1024 * 1024;

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function sizePolicy(env) {
  const e = env || {};
  const auto = String(e.SYNC_AUTO_COMPRESS_BYTES == null ? '' : e.SYNC_AUTO_COMPRESS_BYTES).toLowerCase();
  return {
    warn: num(e.SYNC_WARN_BYTES, 4 * MIB),
    max: num(e.SYNC_MAX_BYTES, 12 * MIB),
    autoCompress: auto === 'off' || auto === 'false' || auto === '0' ? Infinity : num(e.SYNC_AUTO_COMPRESS_BYTES, 8 * MIB),
  };
}

// 'ok' | 'warn' | 'critical' — critical = within 20% of the refuse limit.
export function sizeLevel(bytes, policy) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes >= policy.max * 0.8) return 'critical';
  if (bytes >= policy.warn) return 'warn';
  return 'ok';
}

export function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function gzipText(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return GZ_PREFIX + bytesToBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export function isCompressed(raw) {
  return typeof raw === 'string' && raw.startsWith(GZ_PREFIX);
}

// Stored text (plain JSON or gz1:...) -> plain JSON text.
export async function decodeStateText(raw) {
  if (!isCompressed(raw)) return raw;
  const bytes = base64ToBytes(raw.slice(GZ_PREFIX.length));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

// One read that also returns the KV metadata when the runtime supports it.
async function getWithMeta(env, key) {
  const kv = env.mydukapos_kv;
  if (typeof kv.getWithMetadata === 'function') {
    const r = await kv.getWithMetadata(key);
    return { raw: r && r.value != null ? r.value : null, meta: (r && r.metadata) || null };
  }
  return { raw: await kv.get(key), meta: null };
}

// zip 156 — WHAT VERSION OF THE SHOP IS STORED. KV has no "write only if unchanged", so a writer that wants to know whether another save landed
// since it read the shop compares this stamp (the record's updatedAt, the time it was written and a per-write counter, all in the KV metadata)
// between its read and just before its write. It narrows the race to the moment of the write itself; it cannot close it (that needs the shop
// database — see autoMoveToDatabase in pos-sync.js).
export function stateStamp(meta) {
  return meta ? [meta.ua || 0, meta.at || 0, meta.ver || 0].join('|') : '0';
}
// Reads the shop's current stamp again (one more read of the record; the value itself is not parsed).
export async function readStateStamp(env, key) {
  const { raw, meta } = await getWithMeta(env, key);
  return raw == null ? '0' : stateStamp(meta);
}

// The stored value exactly as it sits in KV (NOT decoded) plus its metadata -> { raw, gz, meta } | null.
// The conditional GET uses this: metadata carries `ua` (the record's updatedAt), so "unchanged since you last
// asked" is answered without decompressing or parsing a large shop at all.
export async function readStateStored(env, key) {
  const { raw, meta } = await getWithMeta(env, key);
  return raw == null ? null : { raw, gz: isCompressed(raw), meta };
}

// -> { raw, text, gz, meta } or null when the key doesn't exist. `text` is always plain JSON.
export async function readStateRaw(env, key) {
  const { raw, meta } = await getWithMeta(env, key);
  if (raw == null) return null;
  return { raw, text: await decodeStateText(raw), gz: isCompressed(raw), meta };
}

// ---- Storage mode: 'kv' (one JSON blob per shop — the default) or 'do' (per-shop SQLite database, see wildcard-router/shop-store.js).
// Per shop, opt-in, and only when the SHOP_STORE binding exists. Flag key: pos-data:mode:<id> = 'do'.
export const MODE_PREFIX = 'pos-data:mode:';
// zip 159 — every request to a shop endpoint asked KV "is this shop in its database?" (one read per request, several per push). Only the answer 'do' is
// kept, and only for MODE_CACHE_MS in the memory of the Worker instance that read it: a shop leaves the database only by the owner's explicit
// "move back" (owner-storage 'unmigrate'), which flags the shop 'migrating' first and then waits out this window before it copies anything (see
// settleModeCache), so no instance can still be sending pushes to the database while the shop is being moved out. 'kv' and 'migrating' are never
// kept: an instance must notice the start of a move on its very next request. SHOP_MODE_CACHE_MS = 0 (environment variable) switches this off.
export const MODE_CACHE_MS = 10000;
const modeCaches = new WeakMap();                            // KV binding -> Map(clientId -> time it was read as 'do')
const modeCacheMs = (env) => { const n = env && env.SHOP_MODE_CACHE_MS != null && env.SHOP_MODE_CACHE_MS !== '' ? Number(env.SHOP_MODE_CACHE_MS) : MODE_CACHE_MS; return Number.isFinite(n) && n >= 0 ? n : MODE_CACHE_MS; };
function modeMap(env) { const kv = env && env.mydukapos_kv; if (!kv || typeof kv !== 'object') return null; let m = modeCaches.get(kv); if (!m) { m = new Map(); modeCaches.set(kv, m); } return m; }
// Call after this instance writes or deletes a shop's mode flag.
export function forgetShopMode(env, clientId) { const m = modeMap(env); if (m) m.delete(clientId); }
// After flagging a shop 'migrating' to move it OUT of the database: let every other instance's cached 'do' expire before reading its data.
export async function settleModeCache(env) {
  const ms = env && env.MIGRATE_SETTLE_MS != null ? Number(env.MIGRATE_SETTLE_MS) : modeCacheMs(env) + 250;
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}
export async function shopMode(env, clientId) {
  if (!env.SHOP_STORE || !clientId) return 'kv';
  const m = modeMap(env), ttl = modeCacheMs(env);
  if (m && ttl > 0) { const at = m.get(clientId); if (at && Date.now() - at < ttl) return 'do'; }
  const v = await withRetry(() => env.mydukapos_kv.get(MODE_PREFIX + clientId), { tries: 2, baseMs: 30, env });
  const mode = v === 'do' || v === 'migrating' ? v : 'kv';      // 'migrating' = the owner is moving the shop; pushes wait a moment
  if (m) { if (mode === 'do' && ttl > 0) m.set(clientId, Date.now()); else m.delete(clientId); }
  return mode;
}
export const migratingResponse = (cors = {}) => new Response(JSON.stringify({ error: 'This shop is being upgraded — please try again in a moment.', code: 'migrating' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5', ...cors } });
export function shopCall(env, clientId, op, payload) {
  const stub = env.SHOP_STORE.get(env.SHOP_STORE.idFromName(clientId));
  return stub.fetch('https://shop-store/' + op, { method: 'POST', body: JSON.stringify(payload || {}) });
}
// Is the per-shop database (the router Worker's ShopStore) running code from before zip 120? It then has no device list, no till
// numbers and no stock ledger — the Pages project was updated but `npm run deploy:router` was not run. (zip 125)
export async function shopDbOutdated(env, clientId) {
  try { const res = await shopCall(env, clientId, 'registry', {}); return res.status === 404; } catch (e) { return false; }
}
const idFromStateKey = (key) => (typeof key === 'string' && key.startsWith('pos-data:state:') ? key.slice('pos-data:state:'.length) : null);

// -> parsed object, or `fallback` when missing. In database mode: the shop as devices see it (recent window of the big logs).
export async function readState(env, key, fallback = null) {
  const id = idFromStateKey(key);
  if (id && (await shopMode(env, id)) === 'do') {
    const res = await shopCall(env, id, 'state', {});
    const obj = await res.json();
    return obj && (obj.updatedAt || Object.keys(obj).length > 1) ? obj : fallback;
  }
  const r = await readStateRaw(env, key);
  return r ? JSON.parse(r.text) : fallback;
}

// Writes JSON text with metadata. opts:
//   compress: true | false          force the format (owner "Compress" / "Uncompress")
//   keepCompressed: boolean         the previous value was gzipped -> stay gzipped
//   writer: { ip, cc }              who pushed (forensics) — appended to a short ring in the metadata
//   prevMeta                        previous metadata (for the writer ring)
//   ver                             explicit version to stamp (the D1 write fence, zip 159); default prevMeta.ver + 1
// Returns the metadata written.
export async function writeStateText(env, key, jsonText, opts = {}) {
  const bytes = opts.bytes != null ? opts.bytes : byteLength(jsonText);
  const policy = sizePolicy(env);
  let gz;
  if (opts.compress === true) gz = true;
  else if (opts.compress === false) gz = false;
  else gz = !!opts.keepCompressed || bytes >= policy.autoCompress;

  const value = gz ? await gzipText(jsonText) : jsonText;
  const now = Date.now();
  const meta = { bytes, stored: value.length, gz, at: now, ver: opts.ver != null ? Number(opts.ver) : (Number(opts.prevMeta && opts.prevMeta.ver) || 0) + 1 };
  if (opts.updatedAt) meta.ua = opts.updatedAt;
  if (opts.writer && (opts.writer.ip || opts.writer.cc)) {
    const prev = (opts.prevMeta && Array.isArray(opts.prevMeta.writers)) ? opts.prevMeta.writers : [];
    const w = { ip: String(opts.writer.ip || '').slice(0, 45), cc: String(opts.writer.cc || '').slice(0, 2), at: now };
    // keep the last 4 DISTINCT sources (newest first) — small enough for KV's 1 KB metadata limit
    const ring = [w, ...prev.filter((p) => p.ip !== w.ip || p.cc !== w.cc)].slice(0, 4);
    meta.writers = ring;
  } else if (opts.prevMeta && Array.isArray(opts.prevMeta.writers)) {
    meta.writers = opts.prevMeta.writers;
  }
  await env.mydukapos_kv.put(key, value, { metadata: meta });
  return meta;
}

// zip 160 - THE SAME D1 WRITE FENCE FOR EVERY OTHER WRITER OF A SINGLE-RECORD SHOP (owner restore / archive / compress / migrate-back / password
// reset / the demo seed). Before, only pos-sync and kvMergeUpdate claimed a slot in the fence; these writers stamped `prev.ver + 1` from their own read,
// which can be LOWER than the version the fence expects when that read was stale, so the next fenced push waited and answered 503 "busy".
//   const meta = await writeStateFenced(env, key, text, { keepCompressed, prevMeta: cur && cur.meta, updatedAt, ... });   // same opts as writeStateText
//   meta === null  -> somebody else wrote since the caller read `cur` (or the fence says the copy it read is stale): NOTHING was written; the caller
//                     re-reads and builds again (or answers "busy", as its own compare-then-write always did).
// No D1 / WRITE_FENCE=0 / a failing fence query -> exactly writeStateText (the caller's own compare-then-write checks still apply).
export async function writeStateFenced(env, key, jsonText, opts = {}) {
  const cid = idFromStateKey(key);
  const fence = cid ? await fenceOpen(env, cid) : null;
  if (!fence) return writeStateText(env, key, jsonText, opts);
  let cur;
  try { cur = await fenceWaitVisible(env, fence, () => readStateRaw(env, key)); }
  catch (e) { if (e && e.code === 'fence_busy') return null; throw e; }
  const pm = opts.prevMeta || null, cm = (cur && cur.meta) || null;
  // the record the caller built from must still be the record that is there now (same version, same write time)
  if (Number((pm && pm.ver) || 0) !== Number((cm && cm.ver) || 0) || Number((pm && pm.at) || 0) !== Number((cm && cm.at) || 0)) return null;
  const claim = await fenceClaim(env, fence, cur);
  if (claim === false) return null;
  if (claim !== true) return writeStateText(env, key, jsonText, opts);            // D1 failed at the claim: legacy behaviour
  try { return await withRetry(() => writeStateText(env, key, jsonText, { ...opts, ver: fence.nextVer }), { tries: 4, baseMs: 600, maxMs: 1600, env }); }
  catch (e) { await fenceRelease(env, fence); throw e; }
}

// Convenience for callers that just have an object (owner-lock, branches, cross-branch-sale, restore).
// Keeps a compressed shop compressed.
export async function writeState(env, key, obj, opts = {}) {
  const id = idFromStateKey(key);
  if (id && (await shopMode(env, id)) === 'do') {            // merged in by record, exactly like a device push
    await shopCall(env, id, 'push', { body: obj, serverNow: Date.now() });
    return { db: true };
  }
  const cur = await getWithMeta(env, key);
  const meta = await writeStateFenced(env, key, JSON.stringify(obj), {
    keepCompressed: isCompressed(cur.raw), prevMeta: cur.meta, updatedAt: obj && obj.updatedAt, ...opts,
  });
  if (!meta) { const e = new Error('the shop was busy syncing - nothing was changed'); e.code = 'fence_busy'; throw e; }      // zip 160: the caller retries from a fresh read
  return meta;
}

// zip 156 — A SERVER-SIDE CHANGE TO A SINGLE-RECORD SHOP THAT GOES THROUGH THE SAME MERGE AS A DEVICE'S PUSH (cross-branch sales).
// Reads the shop, lets `build(existing)` say what to add — { body } (merged exactly like a push, so stock movements are applied once by the
// ledger) or { abort: value } to stop without writing — re-checks that no other save landed meanwhile (retrying from a fresh read if one
// did), writes, and reads the shop back to confirm `body`'s log records are there (retrying if another write landed on top of them).
// Bounded: after `maxAttempts` it writes what it has (as pos-sync does). Returns { aborted } | { record, attempts, contended }.
export async function kvMergeUpdate(env, key, build, { maxAttempts = 5, verifyFields = ['salesLog', 'stockMovementLog'] } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let contended = false;
  for (let attempt = 0; ; attempt++) {
    const cid = idFromStateKey(key);
    const fence = cid ? await fenceOpen(env, cid) : null;                      // zip 159: the D1 write fence (see _write-fence.js); null = legacy behaviour
    let stored = await readStateRaw(env, key);
    if (fence) stored = await fenceWaitVisible(env, fence, () => readStateRaw(env, key), stored);
    const existing = stored ? JSON.parse(stored.text) : {};
    const built = await build(stored ? existing : null);
    if (built && built.abort !== undefined) return { aborted: built.abort };
    const body = built.body;
    const now = Date.now();
    const record = { ...mergeIncomingState(existing, structuredClone(body)), updatedAt: now };
    let fenced = false;
    if (fence) {
      const claim = await fenceClaim(env, fence, stored);
      if (claim === true) fenced = true;
      else if (claim === false) { contended = true; if (attempt < maxAttempts + 3) { await sleep(15 + Math.floor(Math.random() * 60)); continue; } throw new Error('shop write slot kept changing'); }
    }
    if (!fenced && attempt < maxAttempts - 1 && (await readStateStamp(env, key)) !== stateStamp(stored && stored.meta)) {
      contended = true; await sleep(20 + Math.floor(Math.random() * 80)); continue;             // another save landed since the read: merge again
    }
    const put = () => writeStateText(env, key, JSON.stringify(record), { keepCompressed: !!(stored && stored.gz), prevMeta: stored && stored.meta, updatedAt: now, ver: fenced ? fence.nextVer : undefined });
    if (fenced) { try { await withRetry(put, { tries: 4, baseMs: 600, maxMs: 1600, env }); } catch (e) { await fenceRelease(env, fence); throw e; } } else await put();
    if (!fenced && attempt < maxAttempts - 1 && env.SYNC_VERIFY_WRITE !== '0') {
      await sleep(120 + Math.floor(Math.random() * 180));
      const after = await readStateRaw(env, key);
      const cur = after ? JSON.parse(after.text) : {};
      const missing = verifyFields.some((f) => (Array.isArray(body[f]) ? body[f] : []).some((r) => r && r.id != null && r._deleted !== true
        && !(Array.isArray(cur[f]) ? cur[f] : []).some((x) => x && String(x.id) === String(r.id))));
      if (missing) { contended = true; continue; }
    }
    return { record, attempts: attempt + 1, contended };
  }
}

// Sizes for every shop in one pass (KV list metadata, no value reads). -> Map(clientId -> meta|null)
export async function listStateSizes(env, { maxPages = 60 } = {}) {
  const prefix = 'pos-data:state:';
  const out = new Map();
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const res = await env.mydukapos_kv.list({ prefix, cursor });
    for (const k of res.keys || []) out.set(k.name.slice(prefix.length), k.metadata || null);
    if (res.list_complete || !res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}

// Top-level fields ranked by serialised size — shows WHAT is making a shop big.
export function fieldBreakdown(obj, top = 12) {
  const rows = [];
  for (const [name, value] of Object.entries(obj || {})) {
    let bytes = 0;
    try { bytes = byteLength(JSON.stringify(value)); } catch (e) { /* ignore */ }
    rows.push({ name, bytes, items: Array.isArray(value) ? value.length : undefined });
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  return rows.slice(0, top);
}

// Recorded when a push is REFUSED for size, so the Owner Console can show it even though no state was written.
export const SIZE_ALERT_PREFIX = 'pos-data:sizealert:';
export async function noteOversize(env, clientId, bytes, policy) {
  try {
    await env.mydukapos_kv.put(SIZE_ALERT_PREFIX + clientId, JSON.stringify({ bytes, limit: policy.max, at: Date.now() }), { expirationTtl: 30 * 24 * 3600 });
  } catch (e) { /* alerting must never break the response */ }
}

// ---- Archiving old history ------------------------------------------------------------------------------------------
// The append-only logs are what make a busy shop grow (~1.7 KB per sale). Archiving moves records OLDER than a cutoff out of
// the live state into a gzipped archive record (kept, downloadable, restorable), leaving a "hot window" of recent history.
export const ARCHIVE_PREFIX = 'pos-data:archive:';
export const ARCHIVE_LOG_FIELDS = ['salesLog', 'stockMovementLog', 'returns', 'expenses', 'tradeCredits', 'attendanceLog', 'adminActivityLog', 'dispatchLog',
  // Services engine (SERVICES_ARCHITECTURE.md 3.4): a busy car wash adds ~4 KB per vehicle, so finished jobs / appointments must be archivable.
  // Open ones (closedAt == null) are never archived: see isOpenRecord.
  'svcJobs', 'svcAppointments'];

// Best-effort time of a log record (ms epoch), or NaN when it has none we recognise (such records always stay live).
export function recordTime(r) {
  if (!r || typeof r !== 'object') return NaN;
  for (const f of ['timestamp', 'date', 'createdAt', 'clockIn', 'at']) {
    if (r[f] == null) continue;
    const t = typeof r[f] === 'number' ? r[f] : Date.parse(r[f]);
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}

// zip 158: a record that is still OPEN is live data, not history, whatever its date: a trade credit nobody has settled (it is what the Trade
// Credits tab lists and what the shop still owes / is owed), a staff member still clocked in. Archiving one made it vanish from every device
// while the money / the shift was still running. Shared by the client's own archive (src/shared/blocks/storage-and-photos.html).
export function isOpenRecord(field, r) {
  if (!r || typeof r !== 'object') return false;
  if (field === 'tradeCredits') return !r._deleted && r.status !== 'settled' && !r.settledAt;
  if (field === 'attendanceLog') return !r._deleted && r.clockIn != null && (r.clockOut == null || r.clockOut === '');
  // Services engine: a job / appointment that has not been closed yet is live work, whatever its date. Keep identical to isOpen() in storage-and-photos.html.
  if (field === 'svcJobs' || field === 'svcAppointments') return !r._deleted && r.closedAt == null;
  return false;
}

// Splits a state object into { keep, old } where `old` holds { field: [records older than cutoff] }.
export function splitOldHistory(state, cutoffMs) {
  const keep = { ...state };
  const old = {};
  let moved = 0;
  for (const f of ARCHIVE_LOG_FIELDS) {
    const arr = state[f];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const stay = [], go = [];
    for (const r of arr) { const t = recordTime(r); (Number.isFinite(t) && t < cutoffMs && !isOpenRecord(f, r) ? go : stay).push(r); }
    if (go.length) { keep[f] = stay; old[f] = go; moved += go.length; }
  }
  return { keep, old, moved };
}

// ---- Automatic archiving ------------------------------------------------------------------------------------------------
// When a push would leave a shop at 80% or more of the size limit, the server archives old history BY ITSELF, in the same
// request (the normal read-merge-write, so nothing can race it): it keeps the newest N days live (N = 90, then 60, 30, 14, 7 —
// the largest that brings the shop under 60% of the limit), writes the rest to a verified gzipped archive, and records
// `_archiveCutoff` in the shop so devices that still hold (and re-send) those old records can be recognised.
//
// To make sure a re-sent old record is never archived twice — and a NEW record that merely has an old date (a back-dated
// import) is never thrown away — the ids of everything archived are kept in an index. An incoming record older than the
// cutoff is dropped only when its id is in that index.
export const ARCHIVE_INDEX_PREFIX = 'pos-data:archive-ids:';
export const AUTO_KEEP_STEPS = [90, 60, 30, 14, 7];
export const AUTO_ARCHIVE_AT = 0.8;      // start archiving at this share of the size limit
export const AUTO_ARCHIVE_TARGET = 0.6;  // ...and archive enough to get back under this share

export function recordKeyOf(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.id != null) return 'i:' + r.id;
  if (r.code != null) return 'c:' + r.code;
  if (r.token != null) return 't:' + r.token;
  return null;
}

async function readIndexRaw(env, clientId) {
  const raw = await env.mydukapos_kv.get(ARCHIVE_INDEX_PREFIX + clientId);
  return raw ? JSON.parse(await decodeStateText(raw)) : {};
}
async function writeIndexRaw(env, clientId, idx) {
  await env.mydukapos_kv.put(ARCHIVE_INDEX_PREFIX + clientId, await gzipText(JSON.stringify(idx)));
}
// `_at[field][key]` = when that record was archived (zip 156): an edit made AFTER that time is a real change, not a re-sent old copy.
export async function addToArchiveIndex(env, clientId, fields, at = Date.now()) {
  const idx = await readIndexRaw(env, clientId);
  for (const [f, records] of Object.entries(fields)) {
    const set = new Set(idx[f] || []);
    const times = { ...((idx._at && idx._at[f]) || {}) };
    for (const r of records) { const k = recordKeyOf(r); if (k) { set.add(k); times[k] = at; } }
    idx[f] = [...set];
    idx._at = { ...(idx._at || {}), [f]: times };
  }
  await writeIndexRaw(env, clientId, idx);
}
export async function removeFromArchiveIndex(env, clientId, fields) {
  const idx = await readIndexRaw(env, clientId);
  for (const [f, records] of Object.entries(fields)) {
    const drop = new Set(records.map(recordKeyOf).filter(Boolean));
    if (idx[f]) idx[f] = idx[f].filter((k) => !drop.has(k));
    if (idx._at && idx._at[f]) drop.forEach((k) => { delete idx._at[f][k]; });
  }
  await writeIndexRaw(env, clientId, idx);
}

// Picks how much history to keep so `record` lands under the target. -> { keepDays, cutoff, keep, old, moved } | null
export function chooseAutoCutoff(record, policy, nowMs = Date.now()) {
  const target = policy.max * AUTO_ARCHIVE_TARGET;
  let chosen = null;
  for (const keepDays of AUTO_KEEP_STEPS) {
    const cutoff = nowMs - keepDays * 86400000;
    const split = splitOldHistory(record, cutoff);
    if (split.moved === 0) continue;
    chosen = { keepDays, cutoff, ...split };
    if (byteLength(JSON.stringify(split.keep)) <= target) break;
  }
  return chosen;
}

// Writes the archive (gzipped, read back and checked) and updates the id index. -> { archiveId, counts }
export async function writeArchive(env, clientId, { old, keepDays, cutoff, auto }) {
  const counts = Object.fromEntries(Object.entries(old).map(([f, a]) => [f, a.length]));
  const archiveId = String(Date.now());
  const text = JSON.stringify({ archivedAt: Date.now(), keepDays, cutoff, counts, auto: !!auto, fields: old });
  const packed = await gzipText(text);
  const key = ARCHIVE_PREFIX + clientId + ':' + archiveId;
  await env.mydukapos_kv.put(key, packed, { metadata: { archivedAt: Date.now(), keepDays, counts, auto: !!auto, bytes: byteLength(text), stored: packed.length } });
  const check = JSON.parse(await decodeStateText(await env.mydukapos_kv.get(key)));
  if (Object.keys(counts).some((f) => !check.fields[f] || check.fields[f].length !== counts[f])) {
    await env.mydukapos_kv.delete(key);
    throw new Error('archive could not be verified');
  }
  await addToArchiveIndex(env, clientId, old);
  return { archiveId, counts };
}

// zip 158: the latest time this record says anything happened at (ms), whatever field carried it. A trade credit settled, a shift clocked out, a
// delivery marked delivered carry no `updatedAt` (only a handful of lists are stamped on edit), so "edited after it was archived" had no answer for
// them and the edit was dropped with a 200. Numbers that look like epoch milliseconds and ISO date strings count; amounts and quantities never do.
export function latestTouchMs(r) {
  if (!r || typeof r !== 'object') return 0;
  let best = 0;
  for (const [k, v] of Object.entries(r)) {
    if (v == null) continue;
    let t = NaN;
    if (typeof v === 'number') { if (v >= 1e12 && v < 4e12) t = v; }
    else if (typeof v === 'string' && /^\d{4}-\d\d-\d\d(T|\s|$)/.test(v)) t = Date.parse(v);
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best;
}

// Drops incoming log records that were already archived (see above). Reads the index only when there is something old to check.
// zip 156: a record that IS in the archive but carries an edit made AFTER it was archived (an old credit sale being paid, say) is a real
// change: it goes through (and lives in the shop again; the next archive moves it out again). Only copies that are as old as the archive are
// dropped. `updatedAt` is the device's own clock, so it is moved onto the server's clock first when the device is clearly off (the same
// offset correctClockDrift would use) — but the record's own time (`timestamp`) is compared as sent: call this BEFORE correctClockDrift.
//   opts.serverNow      the server's time of receipt (to work out the device's clock offset)
//   opts.lastArchiveAt  when the shop last archived (used for records whose own archive time was not written down: older archives)
export async function dropArchivedIncoming(env, clientId, body, cutoff, opts = {}) {
  if (!cutoff) return body;
  let idx = null;
  let out = body;
  const claimed = Number(body.updatedAt);
  let offset = 0;
  if (Number.isFinite(claimed) && claimed > 0 && opts.serverNow) { const o = opts.serverNow - claimed; if (Math.abs(o) >= CLOCK_DRIFT_MIN_MS) offset = o; }
  for (const f of ARCHIVE_LOG_FIELDS) {
    const arr = body[f];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    if (!arr.some((r) => { const t = recordTime(r); return Number.isFinite(t) && t < cutoff && recordKeyOf(r); })) continue;
    if (idx === null) idx = await readIndexRaw(env, clientId);
    const known = new Set(idx[f] || []);
    const times = (idx._at && idx._at[f]) || {};
    const kept = arr.filter((r) => {
      const t = recordTime(r), k = recordKeyOf(r);
      if (!(Number.isFinite(t) && t < cutoff && k && known.has(k))) return true;
      const archivedAt = Number(times[k]) || Number(opts.lastArchiveAt) || 0;
      if (!archivedAt) return false;
      if (typeof r.updatedAt === 'number') return r.updatedAt + offset >= archivedAt;     // edited after it was archived: keep
      // zip 158: a record that carries no `updatedAt` at all (trade credit settled, shift clocked out...) is judged by the latest time written on it. Those times
      // are the device's own clock, so they are moved onto the server's clock the same way; an old copy has none at or after the archive time.
      return latestTouchMs(r) + offset >= archivedAt;
    });
    if (kept.length !== arr.length) out = { ...out, [f]: kept };
  }
  return out;
}

// ---- Archived history, read back (zip 128) -------------------------------------------------------------------------------
// Old history that a shop moved into archive records (automatically at 80% of its size limit, or from the Owner Console) used to be
// invisible to every device: /api/history and the day check read only the live shop — and a shop later moved to its own database
// never took its archives along. These records are read back here, so Daily Sales / Reports / the missing-sales check show them.
// An archive only holds records older than its cutoff (archivedAt - keepDays), so a range after that never opens it.
const archiveCache = new Map();          // key -> { at, fields } (per isolate, short-lived)
export async function archivedLogRecords(env, clientId, col, from = 0, to = Number.MAX_SAFE_INTEGER) {
  const out = [];
  if (!env || !env.mydukapos_kv || typeof env.mydukapos_kv.list !== 'function') return out;
  let cursor;
  for (let guard = 0; guard < 200; guard++) {
    let page;
    try { page = await env.mydukapos_kv.list({ prefix: ARCHIVE_PREFIX + clientId + ':', cursor }); } catch (e) { return out; }
    for (const k of page.keys || []) {
      const meta = k.metadata || {};
      if (meta.counts && !meta.counts[col]) continue;
      if (meta.archivedAt && meta.keepDays && from >= meta.archivedAt - meta.keepDays * 86400000 + 86400000) continue;
      let fields;
      const hit = archiveCache.get(k.name);
      if (hit && Date.now() - hit.at < 60000) fields = hit.fields;
      else {
        try {
          const raw = await env.mydukapos_kv.get(k.name);
          if (!raw) continue;
          fields = (JSON.parse(await decodeStateText(raw)) || {}).fields || {};
          archiveCache.set(k.name, { at: Date.now(), fields });
          if (archiveCache.size > 20) archiveCache.delete(archiveCache.keys().next().value);
        } catch (e) { continue; }
      }
      for (const r of fields[col] || []) { const t = recordTime(r); if (Number.isFinite(t) && t >= from && t < to) out.push(r); }
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

