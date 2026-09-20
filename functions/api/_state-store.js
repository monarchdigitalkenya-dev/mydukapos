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
export async function shopMode(env, clientId) {
  if (!env.SHOP_STORE || !clientId) return 'kv';
  const v = await env.mydukapos_kv.get(MODE_PREFIX + clientId);
  return v === 'do' || v === 'migrating' ? v : 'kv';      // 'migrating' = the owner is moving the shop; pushes wait a moment
}
export const migratingResponse = (cors = {}) => new Response(JSON.stringify({ error: 'This shop is being upgraded — please try again in a moment.', code: 'migrating' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5', ...cors } });
export function shopCall(env, clientId, op, payload) {
  const stub = env.SHOP_STORE.get(env.SHOP_STORE.idFromName(clientId));
  return stub.fetch('https://shop-store/' + op, { method: 'POST', body: JSON.stringify(payload || {}) });
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
  const meta = { bytes, stored: value.length, gz, at: now };
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

// Convenience for callers that just have an object (owner-lock, branches, cross-branch-sale, restore).
// Keeps a compressed shop compressed.
export async function writeState(env, key, obj, opts = {}) {
  const id = idFromStateKey(key);
  if (id && (await shopMode(env, id)) === 'do') {            // merged in by record, exactly like a device push
    await shopCall(env, id, 'push', { body: obj, serverNow: Date.now() });
    return { db: true };
  }
  const cur = await getWithMeta(env, key);
  return writeStateText(env, key, JSON.stringify(obj), {
    keepCompressed: isCompressed(cur.raw), prevMeta: cur.meta, updatedAt: obj && obj.updatedAt, ...opts,
  });
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
export const ARCHIVE_LOG_FIELDS = ['salesLog', 'stockMovementLog', 'returns', 'expenses', 'tradeCredits', 'attendanceLog', 'adminActivityLog', 'dispatchLog'];

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

// Splits a state object into { keep, old } where `old` holds { field: [records older than cutoff] }.
export function splitOldHistory(state, cutoffMs) {
  const keep = { ...state };
  const old = {};
  let moved = 0;
  for (const f of ARCHIVE_LOG_FIELDS) {
    const arr = state[f];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const stay = [], go = [];
    for (const r of arr) { const t = recordTime(r); (Number.isFinite(t) && t < cutoffMs ? go : stay).push(r); }
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
export async function addToArchiveIndex(env, clientId, fields) {
  const idx = await readIndexRaw(env, clientId);
  for (const [f, records] of Object.entries(fields)) {
    const set = new Set(idx[f] || []);
    for (const r of records) { const k = recordKeyOf(r); if (k) set.add(k); }
    idx[f] = [...set];
  }
  await writeIndexRaw(env, clientId, idx);
}
export async function removeFromArchiveIndex(env, clientId, fields) {
  const idx = await readIndexRaw(env, clientId);
  for (const [f, records] of Object.entries(fields)) {
    const drop = new Set(records.map(recordKeyOf).filter(Boolean));
    if (idx[f]) idx[f] = idx[f].filter((k) => !drop.has(k));
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

// Drops incoming log records that were already archived (see above). Reads the index only when there is something old to check.
export async function dropArchivedIncoming(env, clientId, body, cutoff) {
  if (!cutoff) return body;
  let idx = null;
  let out = body;
  for (const f of ARCHIVE_LOG_FIELDS) {
    const arr = body[f];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    if (!arr.some((r) => { const t = recordTime(r); return Number.isFinite(t) && t < cutoff && recordKeyOf(r); })) continue;
    if (idx === null) idx = await readIndexRaw(env, clientId);
    const known = new Set(idx[f] || []);
    const kept = arr.filter((r) => { const t = recordTime(r); const k = recordKeyOf(r); return !(Number.isFinite(t) && t < cutoff && k && known.has(k)); });
    if (kept.length !== arr.length) out = { ...out, [f]: kept };
  }
  return out;
}
