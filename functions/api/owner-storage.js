// functions/api/owner-storage.js — Cloudflare Pages Function (owner only)
//
// Backs the 💾 Storage tab in the Owner Console: how big is every shop's synced data, which ones are close to the
// limit, and one-click LOSSLESS compression (gzip at rest) of a shop's data — remotely, no access to the shop needed.
//
// GET   -> { policy, shops:[...largest first], rateLimited:[...], serverNow }
//          Sizes come from KV *metadata* attached at write time (see _state-store.js), so this is a few list calls,
//          not one download per shop. A shop that hasn't synced since this feature shipped has no size yet
//          (level 'unknown') until its next push, or until you press Measure on it.
// POST  -> { action: 'measure',    clientId }  read that shop and report its true size + what is taking the space
//          { action: 'compress',   clientId }  store it gzipped (typically 5-10x smaller); reversible
//          { action: 'uncompress', clientId }  store it as plain JSON again
//          { action: 'dbSelfTest' }           run the database through its whole life on a throw-away copy, on the real runtime
//          { action: 'migrate',   clientId }  move the shop into its own database (see wildcard-router/shop-store.js): no size ceiling,
//                                             nothing archived away. Verified before it takes effect; the old record is kept as a rollback.
//          { action: 'unmigrate', clientId }  bring a database shop back to a single record (refused if it no longer fits)
//          { action: 'archive',    clientId, keepDays }  move sales / stock-movement / expense ... records OLDER than
//                                              keepDays out of the live shop into a gzipped archive (kept, downloadable,
//                                              restorable). THIS is what shrinks a shop: compression only shrinks the disk copy.
//          { action: 'archives',   clientId }  list a shop's archives
//          { action: 'restoreArchive', clientId, archiveId }  merge an archive's records back into the live shop
//          { action: 'downloadArchive', clientId, archiveId } the archive as JSON (for the owner to keep)
//
// Compression never changes what the till or any device sees — pos-sync decompresses on read. The rewrite is
// compare-then-write: if a device pushed while we were compressing, we retry once and otherwise refuse rather than
// risk overwriting that push.

import { requireOwnerAuth, getOwnerAccount } from './_owner-auth.js';
import { listClientSummaries } from './_license.js';
import { RL_HIT_PREFIX } from './_ratelimit.js';
import {
  sizePolicy, sizeLevel, listStateSizes, readStateRaw, writeStateText, byteLength, fieldBreakdown,
  SIZE_ALERT_PREFIX, ARCHIVE_PREFIX, decodeStateText, splitOldHistory, writeArchive, removeFromArchiveIndex,
  MODE_PREFIX, shopMode, shopCall,
} from './_state-store.js';
import { migrateShopToDatabase } from './_migrate.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stateKey = (id) => `pos-data:state:${id}`;

export async function onRequestGet(context) {
  const { env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);

  const policy = sizePolicy(env);
  const [sizes, summaries] = await Promise.all([listStateSizes(env), listClientSummaries(env, {})]);
  const byId = new Map(summaries.map((s) => [s.id, s]));
  // Only real, paying (PERMANENT) links are listed here. Demo links, links that were deleted (their leftover data), and the owner's own
  // account are not shops anyone needs to watch, so they never appear — not in the list, the alerts, the totals or "Move all".
  const ownerAccount = await getOwnerAccount(env).catch(() => null);
  const ownerClientId = ownerAccount && ownerAccount.ownerClientId;
  const listed = (id) => { const x = byId.get(id); return !!x && x.type === 'permanent' && id !== ownerClientId; };

  // Refused pushes (shop over the hard limit) — only relevant while no newer successful write exists.
  const alerts = new Map();
  try {
    let cursor;
    for (let i = 0; i < 20; i++) {
      const res = await env.mydukapos_kv.list({ prefix: SIZE_ALERT_PREFIX, cursor });
      for (const k of res.keys || []) {
        const raw = await env.mydukapos_kv.get(k.name);
        if (raw) alerts.set(k.name.slice(SIZE_ALERT_PREFIX.length), JSON.parse(raw));
      }
      if (res.list_complete || !res.cursor) break;
      cursor = res.cursor;
    }
  } catch (e) { /* alerts are best-effort */ }

  // shops that live in their own database
  const modes = new Map();
  try {
    let cursor;
    for (let i = 0; i < 20; i++) {
      const res = await env.mydukapos_kv.list({ prefix: MODE_PREFIX, cursor });
      for (const k of res.keys || []) modes.set(k.name.slice(MODE_PREFIX.length), k.metadata || {});
      if (res.list_complete || !res.cursor) break;
      cursor = res.cursor;
    }
  } catch (e) { /* best-effort */ }

  const shops = [];
  for (const [id, meta] of sizes) {
    const s = byId.get(id);
    if (!listed(id)) continue;
    const alert = alerts.get(id);
    const rejected = alert && (!meta || !meta.at || alert.at > meta.at) ? alert : null;
    const bytes = meta && Number.isFinite(meta.bytes) ? meta.bytes : null;
    const dbShop = modes.has(id) && env.SHOP_STORE;
    let db = null;
    if (dbShop) { try { db = await (await shopCall(env, id, 'stats', {})).json(); } catch (e) { db = null; } }
    shops.push({
      mode: dbShop ? 'db' : 'kv',
      db: db ? { bytes: db.bytes, records: (db.collections || []).reduce((n, c) => n + c.n, 0), collections: (db.collections || []).map((c) => ({ col: c.col, n: c.n })) } : null,
      id,
      label: s ? (s.businessName || s.label || s.slug || id) : '(deleted link)',
      slug: s ? s.slug || null : null,
      product: s ? s.product || null : null,
      bytes: db ? db.bytes : bytes,
      stored: meta && Number.isFinite(meta.stored) ? meta.stored : null,
      gz: !!(meta && meta.gz),
      at: meta && meta.at ? meta.at : null,
      writers: meta && Array.isArray(meta.writers) ? meta.writers : [],
      level: dbShop ? 'ok' : (rejected ? 'refused' : sizeLevel(bytes == null ? NaN : bytes, policy)),
      rejected,
    });
  }
  const rank = { refused: 0, critical: 1, warn: 2, ok: 3, unknown: 4 };
  shops.sort((a, b) => (rank[a.level] - rank[b.level]) || ((b.bytes || 0) - (a.bytes || 0)));

  // Shops that hit the SMS / M-Pesa hourly cap recently.
  const rateLimited = [];
  try {
    const res = await env.mydukapos_kv.list({ prefix: RL_HIT_PREFIX });
    for (const k of res.keys || []) {
      const raw = await env.mydukapos_kv.get(k.name);
      if (!raw) continue;
      const hit = JSON.parse(raw);
      if (!listed(hit.clientId)) continue;
      const s = byId.get(hit.clientId);
      rateLimited.push({ ...hit, label: s ? (s.businessName || s.label || s.slug || hit.clientId) : hit.clientId });
    }
    rateLimited.sort((a, b) => b.last - a.last);
  } catch (e) { /* best-effort */ }

  return json({ policy, shops, rateLimited, serverNow: Date.now() });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await requireOwnerAuth(context))) return json({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid request body.' }, 400); }
  if (body.action === 'dbSelfTest') {
    if (!env.SHOP_STORE) return json({ error: 'The shop database is not set up on this project yet (the SHOP_STORE binding is missing) — see STAGING_SETUP.md.' }, 409);
    // always a throw-away database, never a real shop's
    const scratch = 'selftest-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try {
      const res = await shopCall(env, scratch, 'selftest', {});
      return json(await res.json(), res.ok ? 200 : 500);
    } catch (e) { return json({ ok: false, steps: [{ name: 'reach the database', ok: false, detail: String(e && e.message ? e.message : e) }] }, 500); }
  }

  const clientId = String(body.clientId || '');
  if (!clientId || /[^A-Za-z0-9_-]/.test(clientId)) return json({ error: 'A valid clientId is required.' }, 400);
  const key = stateKey(clientId);

  if (body.action === 'measure') {
    const cur = await readStateRaw(env, key);
    if (!cur) return json({ error: 'No data stored for this shop yet.' }, 404);
    const obj = JSON.parse(cur.text);
    return json({
      clientId, bytes: byteLength(cur.text), stored: cur.raw.length, gz: cur.gz, updatedAt: obj.updatedAt || null,
      fields: fieldBreakdown(obj),
    });
  }

  if (body.action === 'compress' || body.action === 'uncompress') {
    const wantGz = body.action === 'compress';
    let cur = await readStateRaw(env, key);
    if (!cur) return json({ error: 'No data stored for this shop yet.' }, 404);
    if (cur.gz === wantGz) {
      return json({ clientId, changed: false, message: wantGz ? 'Already compressed.' : 'Already stored as plain data.', bytes: byteLength(cur.text), stored: cur.raw.length, gz: cur.gz });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = { bytes: byteLength(cur.text), stored: cur.raw.length };
      const fresh = await env.mydukapos_kv.get(key);
      if (fresh !== cur.raw) {                       // a device pushed while we were working — start again from its data
        cur = await readStateRaw(env, key);
        if (!cur) return json({ error: 'No data stored for this shop yet.' }, 404);
        if (cur.gz === wantGz) return json({ clientId, changed: false, message: 'Already ' + (wantGz ? 'compressed.' : 'plain.'), gz: cur.gz });
        continue;
      }
      let updatedAt = 0;
      try { updatedAt = JSON.parse(cur.text).updatedAt || 0; } catch (e) { return json({ error: 'That shop\'s stored data is unreadable, so it was left untouched.' }, 500); }
      const meta = await writeStateText(env, key, cur.text, { compress: wantGz, bytes: before.bytes, prevMeta: cur.meta, updatedAt });
      return json({
        clientId, changed: true, gz: meta.gz, bytes: before.bytes, storedBefore: before.stored, stored: meta.stored,
        ratio: before.stored > 0 ? Math.round((before.stored / meta.stored) * 10) / 10 : null,
      });
    }
    return json({ error: 'The shop was busy syncing — nothing was changed. Try again in a moment.' }, 409);
  }

  // ---- Product photos: the usual reason a shop is huge (a phone photo stored inside an item can be 500 KB+). The Owner Console shrinks
  // them in the browser (it has a canvas; a Worker does not) — these three actions just list, hand out and replace them. ----
  if (body.action === 'photosList' || body.action === 'photosGet' || body.action === 'photosSet') {
    const COLS = ['inventory', 'products'];
    const mode = await shopMode(env, clientId);
    const load = async () => {
      if (mode === 'do') return { state: await (await shopCall(env, clientId, 'state', { hotDays: 'all' })).json(), cur: null };
      const cur = await readStateRaw(env, key);
      return { state: cur ? JSON.parse(cur.text) : null, cur };
    };
    const { state, cur } = await load();
    if (!state) return json({ error: 'No data stored for this shop yet.' }, 404);
    // A photo-heavy shop can be ~24 MB, and a Worker has 128 MB in total: let go of the decoded copies as soon as the object exists.
    if (cur) { cur.text = null; if (cur.meta && cur.meta.at) cur.raw = null; }
    const recKey = (r) => String(r.code != null ? r.code : r.id);
    const isPhoto = (r) => r && typeof r.image === 'string' && r.image.startsWith('data:image/');

    if (body.action === 'photosList') {
      const min = Number(body.minChars) || 60000;                       // ~45 KB: anything smaller is already fine
      const items = [];
      for (const col of COLS) for (const r of state[col] || []) if (isPhoto(r) && r.image.length > min) items.push({ col, code: recKey(r), name: r.name || '', chars: r.image.length });
      items.sort((a, b) => b.chars - a.chars);
      return json({ items, totalChars: items.reduce((n, i) => n + i.chars, 0) });
    }

    if (body.action === 'photosGet') {
      const want = (Array.isArray(body.items) ? body.items : []).slice(0, 6);
      const images = [];
      for (const w of want) {
        const r = (state[w.col] || []).find((x) => isPhoto(x) && recKey(x) === String(w.code));
        if (r) images.push({ col: w.col, code: String(w.code), image: r.image });
      }
      return json({ images });
    }

    // photosSet: replace images with smaller ones. Each replaced record gets a NEW updatedAt so every device accepts it over its own copy.
    const incoming = (Array.isArray(body.images) ? body.images : []).slice(0, 12).filter((x) => x && COLS.includes(x.col) && typeof x.image === 'string' && x.image.startsWith('data:image/'));
    if (!incoming.length) return json({ clientId, updated: 0 });
    const now = Date.now();
    const changed = [];
    for (const inc of incoming) {
      const list = state[inc.col] || [];
      const i = list.findIndex((x) => isPhoto(x) && recKey(x) === String(inc.code));
      if (i < 0 || inc.image.length >= list[i].image.length * 0.9) continue;          // only ever make a photo SMALLER
      list[i] = { ...list[i], image: inc.image, updatedAt: now };
      changed.push({ col: inc.col, rec: list[i] });
    }
    if (!changed.length) return json({ clientId, updated: 0 });
    if (mode === 'do') {
      const byCol = {};
      for (const c of changed) (byCol[c.col] ||= []).push(c.rec);
      const res = await shopCall(env, clientId, 'push', { body: byCol, serverNow: now });
      if (!res.ok) return json({ error: 'The shop database refused the update.' }, 500);
      return json({ clientId, updated: changed.length });
    }
    // single-record shop: compare-then-write, so a device push that lands meanwhile is never overwritten. The check uses the write time KV keeps
    // in the value's metadata (one tiny list call) instead of downloading the whole shop a second time.
    let busy;
    if (cur.meta && cur.meta.at) {
      const l = await env.mydukapos_kv.list({ prefix: key, limit: 1 });
      const m = (l.keys || []).find((k) => k.name === key);
      busy = !m || !m.metadata || m.metadata.at !== cur.meta.at;
    } else {
      busy = (await env.mydukapos_kv.get(key)) !== cur.raw;
    }
    if (busy) return json({ error: 'The shop was busy syncing — nothing was changed. Try again.' }, 409);
    state.updatedAt = now;
    const text = JSON.stringify(state);
    // Plain when it fits under KV's 25 MiB value limit (no gzip = no extra copies in memory); gzipped only when it would not fit.
    await writeStateText(env, key, text, { compress: text.length >= 23 * 1048576, bytes: text.length, prevMeta: cur.meta, updatedAt: now });
    return json({ clientId, updated: changed.length });
  }

  if (body.action === 'migrate' || body.action === 'unmigrate') {
    if (!env.SHOP_STORE) return json({ error: 'The shop database is not set up on this project yet (the SHOP_STORE binding is missing) — see STAGING_SETUP.md.' }, 409);
    const modeKey = MODE_PREFIX + clientId;
    const current = await shopMode(env, clientId);
    if (current === 'migrating') return json({ error: 'A move is already in progress for this shop.' }, 409);
    const to = body.action === 'migrate' ? 'do' : 'kv';
    if ((current === 'do') === (to === 'do')) return json({ clientId, changed: false, message: to === 'do' ? 'Already in the database.' : 'Already a single record.' });
    // While the shop is moving, pushes are told to retry in a few seconds (503) — so nothing can land in the wrong place.
    await env.mydukapos_kv.put(modeKey, 'migrating', { expirationTtl: 300 });
    try {
      if (to === 'do') {
        // (the mode flag is already 'migrating'; the helper works from 'kv', so hand it back first)
        await env.mydukapos_kv.delete(modeKey);
        const r = await migrateShopToDatabase(env, clientId);
        return json({ clientId, changed: r.changed, mode: 'db', records: r.records, bytes: r.bytes });
      }
      const exp = await shopCall(env, clientId, 'export', {});
      const text = await exp.text();
      const cur = await readStateRaw(env, key);
      const policy = sizePolicy(env);
      if (byteLength(text) > policy.max) throw new Error(`the shop (${(byteLength(text) / 1048576).toFixed(1)} MB) is too big to go back to a single record`);
      await writeStateText(env, key, text, { keepCompressed: !!(cur && cur.gz), prevMeta: cur && cur.meta, updatedAt: JSON.parse(text).updatedAt });
      await env.mydukapos_kv.delete(modeKey);
      return json({ clientId, changed: true, mode: 'kv', bytes: byteLength(text) });
    } catch (e) {
      // leave the shop exactly as it was
      if (current === 'do') await env.mydukapos_kv.put(modeKey, 'do'); else await env.mydukapos_kv.delete(modeKey);
      return json({ error: `The move was cancelled and nothing was changed: ${e.message}` }, 500);
    }
  }

  if (body.action === 'archive') {
    const keepDays = Math.max(7, Math.min(3650, Math.floor(Number(body.keepDays) || 90)));
    const cutoff = Date.now() - keepDays * 86400000;
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await readStateRaw(env, key);
      if (!cur) return json({ error: 'No data stored for this shop yet.' }, 404);
      let state;
      try { state = JSON.parse(cur.text); } catch (e) { return json({ error: 'That shop\'s stored data is unreadable, so it was left untouched.' }, 500); }
      const { keep, old, moved } = splitOldHistory(state, cutoff);
      if (moved === 0) return json({ clientId, changed: false, message: `Nothing older than ${keepDays} days to archive.` });

      // 1. write the archive FIRST and read it back — the live data is only trimmed once the archive is proven readable
      let done;
      try { done = await writeArchive(env, clientId, { old, keepDays, cutoff, auto: false }); }
      catch (e) { return json({ error: 'The archive could not be verified, so nothing was changed.' }, 500); }
      const counts = done.counts, archiveId = done.archiveId;
      const archiveKey = ARCHIVE_PREFIX + clientId + ':' + archiveId;

      // 2. trim the live shop (compare-then-write). updatedAt moves forward so every device pulls the smaller shop.
      const fresh = await env.mydukapos_kv.get(key);
      if (fresh !== cur.raw) { await env.mydukapos_kv.delete(archiveKey); continue; }   // a device pushed meanwhile: redo from its data
      keep.updatedAt = Date.now();
      keep._archiveCutoff = Math.max(Number(state._archiveCutoff) || 0, cutoff);
      const before = byteLength(cur.text);
      const text = JSON.stringify(keep);
      const meta = await writeStateText(env, key, text, { keepCompressed: cur.gz, prevMeta: cur.meta, updatedAt: keep.updatedAt });
      return json({ clientId, changed: true, moved, counts, archiveId, bytesBefore: before, bytesAfter: meta.bytes, keepDays });
    }
    return json({ error: 'The shop was busy syncing — nothing was changed. Try again in a moment.' }, 409);
  }

  if (body.action === 'archives') {
    const prefix = ARCHIVE_PREFIX + clientId + ':';
    const list = await env.mydukapos_kv.list({ prefix });
    const archives = (list.keys || []).map((k) => ({ id: k.name.slice(prefix.length), ...(k.metadata || {}) })).sort((a, b) => Number(b.id) - Number(a.id));
    return json({ clientId, archives });
  }

  if (body.action === 'restoreArchive' || body.action === 'downloadArchive') {
    const archiveId = String(body.archiveId || '');
    if (!/^\d+$/.test(archiveId)) return json({ error: 'A valid archiveId is required.' }, 400);
    const raw = await env.mydukapos_kv.get(ARCHIVE_PREFIX + clientId + ':' + archiveId);
    if (!raw) return json({ error: 'Archive not found.' }, 404);
    const archive = JSON.parse(await decodeStateText(raw));
    if (body.action === 'downloadArchive') return json(archive);

    // merge the archived records back into the live shop, by id (records already there win)
    const cur = await readStateRaw(env, key);
    const state = cur ? JSON.parse(cur.text) : {};
    let restored = 0;
    for (const [field, records] of Object.entries(archive.fields || {})) {
      const have = new Set((state[field] || []).map((r) => (r && (r.id != null ? 'i:' + r.id : r.code != null ? 'c:' + r.code : null))));
      const add = records.filter((r) => { const k = r && (r.id != null ? 'i:' + r.id : r.code != null ? 'c:' + r.code : null); return k == null || !have.has(k); });
      state[field] = [...(state[field] || []), ...add];
      restored += add.length;
    }
    state.updatedAt = Date.now();
    await writeStateText(env, key, JSON.stringify(state), { keepCompressed: !!(cur && cur.gz), prevMeta: cur && cur.meta, updatedAt: state.updatedAt });
    await removeFromArchiveIndex(env, clientId, archive.fields || {});   // devices may now send these records again
    return json({ clientId, restored });
  }

  return json({ error: 'Unknown action.' }, 400);
}
