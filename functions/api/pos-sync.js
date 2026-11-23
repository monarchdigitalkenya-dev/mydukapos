// functions/api/pos-sync.js — Cloudflare Pages Function
//
// Shared-state sync endpoint backed by Cloudflare KV, one record PER CLIENT
// LINK (the `c` query param — see _license.js). Every device using the same
// link (?c=<token>) reads/writes the same record; different links never see
// each other's data.
//
// GET  -> returns the current stored state for this client (or an empty
//         placeholder if nothing saved yet)
// POST -> saves the state sent in the request body, stamping it with the
//         server's received time
//
// SCHEMA-LESS BY DESIGN, WITH ONE EXCEPTION: this endpoint doesn't know or
// care whether it's talking to the Shop POS, a future Hotel POS, or
// anything else — it just stores whatever JSON object the front-end sends
// and hands back whatever was last stored. Each product's own front-end is
// responsible for the shape of its own data (inventory/sales for the shop,
// rooms/bookings for a hotel, etc.). This means adding a new product later
// never requires touching this file. The exception is every array of
// id/code-bearing records listed in MERGE_BY_ID_FIELDS below (staff,
// inventory, customers, bills, sales log, etc.) — those get merged
// record-by-record instead of replaced wholesale — see mergeIncomingState()
// below for why.
//
// Blocked with 403 if the link's license isn't currently valid (expired demo,
// admin-locked, or unknown link) — see _license.js for how that's decided.
//
// Requires a KV namespace bound as `mydukapos_kv` on this Pages project.

import { requireValidLicense, updateIndexBusinessName } from './_license.js';
import { maybeSnapshotBackup } from './_backups.js';
import { corsHeadersFor } from './_cors.js';
import { mergeIncomingState, correctClockDrift, MERGE_BY_ID_FIELDS, stripTombstones, recordKey } from './_merge.js';
import {
  readStateRaw, readStateStored, decodeStateText, writeStateText, writeStateFenced, byteLength, sizePolicy, noteOversize, MIB,
  chooseAutoCutoff, writeArchive, dropArchivedIncoming, AUTO_ARCHIVE_AT, shopMode, shopCall, migratingResponse, stateStamp, readStateStamp,
} from './_state-store.js';
import { deviceGuard } from './_device-auth.js';
import { stampSales, readMode, staffTokenOf, verifyToken } from './_staff-auth.js';
import { guardPush, sanitizeMpesaPush } from './_perm-guard.js';
import { secEvent, callerIp as callerIpOf } from './_sec-events.js';
import { recordPush, ledgerReset } from './_ledger.js';
import { parseResetRequest, wipedState } from './_merge.js';
import { withRetry, isStorageFull } from './_retry.js';
import { fenceOpen, fenceWaitVisible, fenceClaim, fenceRelease } from './_write-fence.js';

// CORS is decided per request (see _cors.js): the apps call this on their own origin, so only the shop's own
// domain family is ever answered — no more `Access-Control-Allow-Origin: *`.
function busyResponse(cors, e) {
  try { console.error('pos-sync failed:', e && e.stack ? e.stack : e); } catch (x) { /* logging only */ }   // the real error, in the Worker logs (zip 147)
  return new Response(JSON.stringify({ error: 'The server is busy — this device keeps its changes and sends them again in a moment.', code: 'busy', retryAfter: 2, detail: String((e && e.message) || e || '').slice(0, 160) }), {
    status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '2', ...cors },
  });
}
// zip 186: what the ledger noticed about this push, ADDED to the reply (the apps ignore fields they do not know): duplicate (a pure re-send), rateLimited, rejected.
function ledgerHints(led) {
  return { ...(led.duplicate ? { duplicate: true } : {}), ...(led.rateLimited ? { rateLimited: led.rateLimited } : {}), ...(led.rejected ? { rejected: led.rejected } : {}) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// zip 147 — THE SHOP'S OWN DATABASE DID NOT ANSWER. Permanent shops keep their data in a per-shop database (the ShopStore Durable Object,
// defined in the separate router Worker). When that Worker is not deployed, is out of date, or cannot be reached, every call failed and
// was answered "the server is busy — sending again in a moment" (503 busy): the till retried for ever, showed "Syncing…" with working
// internet, and nothing anywhere said why (reproduced: every sync of a permanent shop 503 "busy" with an empty detail). It now answers
// with its own code, logs the real error, and leaves a note the Owner Console shows — the device keeps every sale and says what is wrong.
async function shopDbCall(env, clientId, op, payload) {
  try {
    const res = await shopCall(env, clientId, op, payload);
    const ct = String(res.headers.get('content-type') || '');
    if (res.status >= 500 && !ct.includes('application/json')) return { unavailable: true, why: `the shop database answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}` };
    return { res };
  } catch (e) {
    return { unavailable: true, why: String((e && e.message) || e || 'no answer').slice(0, 160) };
  }
}
async function shopDbUnavailable(env, clientId, why, cors) {
  try { console.error('pos-sync: shop database unavailable for', clientId, '-', why); } catch (x) { /* logging only */ }
  try { await env.mydukapos_kv.put('shopdb-fail:' + clientId, JSON.stringify({ at: Date.now(), why }), { expirationTtl: 2 * 86400 }); } catch (e) { /* the answer below is what matters */ }
  return new Response(JSON.stringify({
    error: 'This shop\'s database on the server is not responding, so it cannot sync yet. Nothing is lost — every sale stays on this device and is sent by itself once the server is fixed.',
    code: 'shop_db_unavailable', retryAfter: 30, detail: why,
  }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '30', ...cors } });
}

// Devices that synced this shop in the last day (from the device list the server keeps — see noteDevice in _merge.js).
function activeDevices(reg, now) {
  if (!reg || typeof reg !== 'object') return 0;
  return Object.values(reg).filter((d) => d && Number(d.lastSeen) > now - 86400000).length;
}

// zip 156 — A PERMANENT SHOP MOVES TO ITS OWN DATABASE FROM ITS FIRST PUSH when the database is bound (see handlePost). Storage has no "write only if
// unchanged", so a shop kept as one record can lose a save whenever two devices write within a few hundred ms of each other, and nothing
// on the server can see it happen. The database takes saves one after the other, so from the first push there is nothing to lose.
// A shop that cannot be moved (the database does not answer) simply stays a single record, as before, and is tried again after 6 hours.
// MULTI-DEVICE SHOPS MOVE TO THEIR OWN DATABASE BY THEMSELVES (zip 123). A shop kept as one storage record can only be written
// about once a second, and two devices saving at the same moment used to get "the server refused or was busy" (and could even
// overwrite each other). Its own database (wildcard-router/shop-store.js) takes every device's save one after the other, with no
// such limit. So a shop that has 2+ active devices, or whose save just had to wait for another one, is moved — verified, with the
// old record kept, exactly like the Owner Console's "Move to database" (see _migrate.js). Tried at most once every 6 hours; if it
// cannot be done the shop simply stays as it is.
async function autoMoveToDatabase(env, clientId, why) {
  const key = 'auto-db:' + clientId;
  try {
    if (await env.mydukapos_kv.get(key)) return;
    if (await env.mydukapos_kv.get('auto-db-off:' + clientId)) return;     // the owner moved this shop back to a single record on purpose (Owner Console > Storage)
    await env.mydukapos_kv.put(key, JSON.stringify({ at: Date.now(), why }), { expirationTtl: 6 * 3600 });
    const { migrateShopToDatabase } = await import('./_migrate.js');
    const r = await migrateShopToDatabase(env, clientId);
    await env.mydukapos_kv.put(key, JSON.stringify({ at: Date.now(), why, done: true, records: r.records || 0 }), { expirationTtl: 6 * 3600 });
  } catch (e) {
    try { await env.mydukapos_kv.put(key, JSON.stringify({ at: Date.now(), why, error: String(e && e.message || e).slice(0, 200) }), { expirationTtl: 6 * 3600 }); } catch (e2) { /* ignore */ }
  }
}

// How many of the log records (sales, stock changes, returns, expenses) a push carried are NOT in the stored shop — a later write
// from another till overwrote them. (zip 146)
const VERIFY_FIELDS = ['salesLog', 'stockMovementLog', 'returns', 'expenses'];
function pushLostRecords(pushBody, storedState) {
  let lost = 0;
  for (const f of VERIFY_FIELDS) {
    const sent = Array.isArray(pushBody && pushBody[f]) ? pushBody[f] : [];
    if (!sent.length) continue;
    const have = new Set((Array.isArray(storedState && storedState[f]) ? storedState[f] : []).map((r) => r && r.id != null ? String(r.id) : null));
    for (const r of sent) if (r && r.id != null && r._deleted !== true && !have.has(String(r.id))) lost++;
  }
  return lost;
}

function carriesLogRecords(pushBody) {
  return VERIFY_FIELDS.some((f) => Array.isArray(pushBody && pushBody[f]) && pushBody[f].some((r) => r && r.id != null && r._deleted !== true));
}

// Does the push carry any record of the merged lists (sales, stock, customers, bills ...)? Those are what a lost race erases.
function carriesRecords(pushBody) {
  return MERGE_BY_ID_FIELDS.some((f) => Array.isArray(pushBody && pushBody[f]) && pushBody[f].length > 0);
}

function jsonResponse(body, status = 200, cors = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export function stateKey(clientId) {
  return `pos-data:state:${clientId}`;
}

// Seeds (or merges into) this client's pos-sync record — used by
// demo-account.js at account-registration time so a link created via the
// public website already carries a real password the moment it exists,
// exactly the way a POS-side direct Sign Up would (see water/index.html's
// finishDirectAuth()/doPush()). This is what lets a brand-new device open
// that link and go straight to "who's logging in?" with just a password —
// no email, so nobody gets stranded just because they'd unlinked theirs
// (see account-recovery.js). Never touches fields it isn't given — only
// merges the patch in and stamps updatedAt.
export async function seedInitialState(env, clientId, patch) {
  if ((await shopMode(env, clientId)) === 'do') { await shopCall(env, clientId, 'push', { body: patch, serverNow: Date.now() }); return; }
  for (let i = 0; i < 5; i++) {                                    // zip 160: through the write fence; a save landing meanwhile = merge the patch into that one
    const cur = await readStateRaw(env, stateKey(clientId));
    const existing = cur ? JSON.parse(cur.text) : {};
    const merged = { ...existing, ...patch, updatedAt: Date.now() };
    if (await writeStateFenced(env, stateKey(clientId), JSON.stringify(merged), { keepCompressed: !!(cur && cur.gz), prevMeta: cur && cur.meta, updatedAt: merged.updatedAt })) return;
  }
  throw new Error('the shop kept changing while it was being set up');
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    if (isStorageFull(e)) return storageFullResponse(corsHeadersFor(context.request, context.env));      // zip 186: the 10 GB D1 cap is not "busy": the till pauses (see below)
    return busyResponse(corsHeadersFor(context.request, context.env), e);
  }
}

// zip 186: HTTP 507 {ok:false, code:'storage_full', retryAfter:300}. A full database fails identically on every try, so the till is told to PAUSE (5 minutes) and keep its
// data, instead of the 503 "busy, retry in 2 s" it answered before (which made every till hammer a database that could not accept anything).
function storageFullResponse(cors) {
  return new Response(JSON.stringify({ ok: false, code: 'storage_full', retryAfter: 300, error: 'The server storage is full - this device keeps every sale and will send it again later. Please tell support.' }), {
    status: 507, headers: { 'Content-Type': 'application/json', 'Retry-After': '300', ...cors },
  });
}

async function handleGet(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403, cors);
  }
  const clientId = license.clientId;
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, clientId, corsHeadersFor(request, env));
  if (deviceDenied) return deviceDenied;

  // DATABASE MODE (per shop, opt-in): the shop lives in its own SQLite Durable Object. The reply is the shop as devices expect it,
  // except that the big logs carry only their recent window (?hot=<days>, default 120, or ?hot=all) — older history stays in the
  // database and is fetched by date range from /api/history. ?since= still gets the tiny "unchanged" answer.
  const mode = await shopMode(env, clientId);
  if (mode === 'migrating') return migratingResponse(cors);
  if (mode === 'do') {
    const u = new URL(request.url);
    const hot = u.searchParams.get('hot');
    const got = await shopDbCall(env, clientId, 'state', {
      since: Number(u.searchParams.get('since')) || 0,
      hotDays: hot === 'all' ? 'all' : (Number(hot) || undefined),
      logsAfter: Number(u.searchParams.get('after')) || 0,          // zip 315: the device's change cursor (see stateText in wildcard-router/shop-store.js)
    });
    if (got.unavailable) return shopDbUnavailable(env, clientId, got.why, cors);
    const res = got.res;
    return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json', ...cors } });
  }

  let stored = await readStateStored(env, stateKey(clientId));
  // zip 279: a pull asked for because another device just saved (?fresh=1) must not be answered from a copy older than that save: KV can lag
  // behind the write fence for a moment. Wait (at most ~1.5 s, never an error) until the copy is at least as new as the last acknowledged write.
  if (new URL(request.url).searchParams.get('fresh') === '1') {
    try {
      const fence = await fenceOpen(env, clientId);
      const seen = () => Number((stored && stored.meta && stored.meta.ver) || 0);
      if (fence && fence.kvVer > 0 && seen() < fence.kvVer) {
        const deadline = Date.now() + 1500;
        for (let i = 0; Date.now() < deadline && seen() < fence.kvVer; i++) { await sleep(Math.min(60 * 2 ** i, 400)); stored = await readStateStored(env, stateKey(clientId)); }
      }
    } catch (e) { /* the copy already read is answered */ }
  }

  // Conditional pull: every open device asks for the state every few seconds,
  // and until now the answer was the WHOLE shop (inventory, photos, every sale)
  // even when nothing had changed — the device then threw it away because it
  // wasn't newer. A device that sends ?since=<the updatedAt it already has> now
  // gets a ~40-byte "unchanged" reply instead. Older app versions don't send
  // `since` and keep getting the full record exactly as before.
  const since = Number(new URL(request.url).searchParams.get('since')) || 0;
  // Fast path: the write's metadata carries the record's updatedAt, so an unchanged shop is answered without
  // decompressing or parsing it (matters for big/compressed shops polled by many devices).
  if (since > 0 && stored && stored.meta && stored.meta.ua && stored.meta.ua <= since) {
    return jsonResponse({ unchanged: true, updatedAt: stored.meta.ua }, 200, cors);
  }
  const payload = stored ? stripTombstones(JSON.parse(await decodeStateText(stored.raw))) : { updatedAt: 0 };
  payload._ledger = 1;   // this server applies stock movements exactly once (see applyStockLedger in _merge.js) — the apps switch their side on
  if (since > 0 && payload.updatedAt && payload.updatedAt <= since) {
    return jsonResponse({ unchanged: true, updatedAt: payload.updatedAt }, 200, cors);
  }
  return jsonResponse(payload, 200, cors);
}

// A sync must never fail with a crash. Anything unexpected (storage briefly busy, a timeout reaching the shop's database) is answered
// "busy, try again in a moment" (503 + Retry-After), which every app retries by itself within seconds (see trackPush). (zip 123)
export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return busyResponse(corsHeadersFor(context.request, context.env), e);
  }
}

async function handlePost(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request, env);

  const license = await requireValidLicense(request, env);
  if (!license.valid) {
    return jsonResponse({ error: 'This link is not active.', reason: license.reason }, 403, cors);
  }
  const clientId = license.clientId;
  // zip 262: the shared public demo is read-only on the server - a visitor's edits stay on their own device. Acknowledge so no device ever sees an
  // error loop, store nothing (no KV / D1 / Durable Object write at all).
  if (license.record && license.record.sharedDemo) return jsonResponse({ ok: true, demo: true, stored: false, updatedAt: Date.now() }, 200, cors);
  // PAIRED DEVICES ONLY when the shop has switched that on (see _device-auth.js); otherwise no change
  const deviceDenied = await deviceGuard(request, env, clientId, corsHeadersFor(request, env));
  if (deviceDenied) return deviceDenied;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400, cors);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'Request body must be a JSON object.' }, 400, cors);
  }

  // zip 326: no password is reserved any more - 0000 is stored like any other password (the old zip 262/322 rule that dropped it is gone).

  // WHO MADE EACH SALE (zip 141): check each sale's staff signature and stamp what was found (see _staff-auth.js). Never refuses or
  // drops a sale; if the check itself fails the push goes ahead unstamped (shown as "not checked").
  try { await stampSales(env, clientId, body); } catch (e) { /* never block a sale */ }

  // PERMISSIONS ON THE NEW LISTS (zip 292): when the shop requires staff sessions, a change to cash settings / cashier points, a cash approval,
  // exemption or correction, a voided cash movement, or a unit written off / damaged / re-identified is kept only if a manager (or the Admin) made it
  // (see _perm-guard.js). Anything else in the push goes through; a held record is reported back in `held`. Off by default (same switch as every staff action).
  let permAuth = { enforce: false, claims: null };
  try {
    if ((await readMode(env, clientId)) === 'enforce') { const tok = staffTokenOf(request); permAuth = { enforce: true, claims: tok ? await verifyToken(env, clientId, tok) : null }; }
  } catch (e) { permAuth = { enforce: false, claims: null }; }
  let heldNow = [];

  // RESET APP (zip 327): the server really forgets the shop. The typed business name is checked here against the stored one; with staff sessions required only
  // a manager may do it. Nothing else in the push is applied.
  if (body._wipeApp && typeof body._wipeApp === 'object') return await handleWipeApp(context, { clientId, body, permAuth, cors });

  // RESET EPOCH (zip 327): a deliberate reset of the sales / stock history. With staff sessions required only a manager may send it; anything
  // else in the push still goes through and the refused reset is reported back in `held`.
  let resetReq = parseResetRequest(body, Date.now());
  if (resetReq && permAuth.enforce && !(permAuth.claims && permAuth.claims.mgr)) {
    delete body._logsReset; resetReq = null;
    heldNow = heldNow.concat([{ col: '_logsReset', reason: 'manager_only' }]);
  }

  // THE D1 LEDGER (zip 153): every sale / payment / bill / expense / return ... in this push is written to Cloudflare D1 FIRST, one atomic
  // batch per record, idempotent on the record's id. If D1 does not accept it the push is NOT acknowledged (503, "busy"): the till keeps the
  // sale and sends it again, so a failed transaction never looks successful and nothing is lost. Without a D1 binding the push carries on
  // as before and the shop is flagged for the Owner Console (see health.js) — a missing binding must not stop a till trading.
  // zip 156: with the device's clock corrected (as the shop's own copy is), so a void made on a slow-clock till is not older than the sale it voids
  const led = await recordPush(env, clientId, correctClockDrift(body, Date.now()), { source: 'pos-sync' });
  if (!led.ok && led.code === 'storage_full') return storageFullResponse(cors);
  // zip 186: terminal / throttled answers the till must NOT treat as "busy": a record the server can never accept (422 permanent), or one record changed too often (429)
  if (!led.ok && (led.code === 'bad_record' || led.code === 'record_rate')) {
    const wait = Number(led.retryAfter) > 0 ? Math.ceil(led.retryAfter) : 0;
    return new Response(JSON.stringify({ ok: false, code: led.code, error: led.error, ...(led.permanent ? { permanent: true } : {}), ...(wait ? { retryAfter: wait } : {}), ...(led.rejected ? { rejected: led.rejected } : {}), ...(led.limited ? { limited: led.limited } : {}) }), {
      status: led.status || 422, headers: { 'Content-Type': 'application/json', ...(wait ? { 'Retry-After': String(wait) } : {}), ...cors },
    });
  }
  if (!led.ok) {
    return new Response(JSON.stringify({ error: 'The transaction database did not answer — this device keeps every sale and sends it again in a moment.', code: 'busy', ledger: 'unavailable', retryAfter: 2, detail: led.error }), {
      status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '2', ...cors },
    });
  }
 // zip 327: the D1 ledger is the money record - a reset marks the sales / payments it covers REMOVED / REVERSED (never deleted: the audit trail stays)
  if (resetReq && resetReq.fields.some((f) => f === 'salesLog' || f === 'bills')) {
    const lr = await ledgerReset(env, clientId, resetReq);
    if (!lr.ok) return new Response(JSON.stringify({ error: 'The transaction database did not answer — the reset is kept on this device and sent again in a moment.', code: 'busy', ledger: 'unavailable', retryAfter: 2 }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '2', ...cors } });
  }
  // Best-effort marker "this shop has no transaction database yet" (read by the health check). Written at most once every 6 hours per
  // worker instance, never awaited and never allowed to fail a push.
  if (led.skipped === 'no_db') {
    const now = Date.now();
    if (!(globalThis.__ledgerOffAt || (globalThis.__ledgerOffAt = new Map())).has(clientId) || now - globalThis.__ledgerOffAt.get(clientId) > 6 * 3600 * 1000) {
      globalThis.__ledgerOffAt.set(clientId, now);
      try { Promise.resolve(env.mydukapos_kv.put('ledger-off:' + clientId, String(now), { expirationTtl: 2 * 86400 })).catch(() => {}); } catch (e) { /* flag only */ }
    }
  }

  // DATABASE MODE: hand the push to the shop's own database. Its cost follows the size of THIS push, not of the shop, so there is
  // no size ceiling to guard (only a cap on one request, so a single push can't exhaust the Durable Object's memory).
  let pushMode = await shopMode(env, clientId);
  // (Permanent shops only: a demo / trial link stays a single record until it is made permanent — see owner-confirm.js — unless it shows the
  // signs of a multi-device shop below.)
  if (pushMode === 'kv' && env.SHOP_STORE && license.record && license.record.type === 'permanent') {
    await autoMoveToDatabase(env, clientId, 'first push');         // no-op inside the 6-hour guard; if it cannot be done the shop stays a single record
    pushMode = await shopMode(env, clientId);
  }
  if (pushMode === 'migrating') return migratingResponse(cors);
  if (pushMode === 'do') {
    const maxPush = Number(env.SYNC_MAX_PUSH_BYTES) || 24 * 1048576;
    if (Number(request.headers.get('content-length')) > maxPush) {
      return jsonResponse({ error: 'This push is too large to accept in one go.', code: 'push_too_large' }, 413, cors);
    }
    const doAuth = permAuth.enforce ? { enforce: true, claims: permAuth.claims ? { sid: permAuth.claims.sid, name: permAuth.claims.name, mgr: !!permAuth.claims.mgr, perms: permAuth.claims.perms, expired: !!permAuth.claims.expired } : null } : null;
    let got = await shopDbCall(env, clientId, 'push', { body, serverNow: Date.now(), auth: doAuth });
    if (got.unavailable || got.res.status >= 500) { await sleep(400 + Math.floor(Math.random() * 400)); got = await shopDbCall(env, clientId, 'push', { body, serverNow: Date.now(), auth: doAuth }); }   // one quick retry (zip 123)
    if (got.unavailable) return shopDbUnavailable(env, clientId, got.why, cors);
    const res = got.res;
    const out = await res.json().catch(() => ({}));
    if (!res.ok) return res.status >= 500 ? busyResponse(cors, out && out.error) : jsonResponse(out, res.status, cors);
    // Tell the shop's other devices to pull right now. A bare poke, NOT the data: a device that doesn't understand it (an older
    // cached app) sees no updatedAt and ignores it, and simply keeps using its 7-second poll.
    if (env.SYNC_ROOM) {
      try {
        const room = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(clientId));
        context.waitUntil(room.fetch('https://sync-room/broadcast', { method: 'POST', body: JSON.stringify({ poke: true }) }).catch(() => {}));
      } catch (e) { /* the poll is the fallback */ }
    }
    if (out.held && out.held.length) { try { await secEvent(env, 'permission_held', { route: 'pos-sync', shop: clientId, ip: callerIpOf(request), detail: out.held.map((h) => h.col + ':' + h.reason).slice(0, 3).join('; ').slice(0, 160) + ' by ' + String((permAuth.claims && permAuth.claims.name) || 'no staff session').slice(0, 30) }); } catch (e) { /* log only */ } }
    return jsonResponse({ ok: true, d1: led.skipped ? 0 : 1, ...(led.duplicates ? { duplicates: led.duplicates } : {}), ...ledgerHints(led), updatedAt: out.updatedAt, prev: out.prev, ...(out.held && out.held.length ? { held: out.held } : {}), ...(out.ledger ? { ledger: out.ledger } : {}), ...(out.till ? { till: out.till } : {}) }, 200, cors);
  }

  // Snapshot whatever's currently live (about to be overwritten) into today's
  // backup slot for this client — a no-op if already done today. Must happen
  // BEFORE the write below, or there'd be nothing left to snapshot.
  await maybeSnapshotBackup(env, clientId);

  // Read -> merge -> write, retried if the write is refused because another device's save landed at the same moment (zip 123).
  const pristine = structuredClone(body);           // the merge may annotate what it is given: a retry starts from the untouched push
  let stored, existing, serverNow, record, jsonText, bytes, attempt = 0, contended = false;
  for (;;) {
    const incomingBody = attempt === 0 ? body : structuredClone(pristine);

    // Read what's currently stored so the MERGE_BY_ID_FIELDS above can be
    // merged record-by-record instead of just replaced wholesale — see
    // mergeIncomingState() above. Everything else keeps the previous
    // behavior (incoming replaces existing) via the plain spread inside it.
    // zip 159 — THE D1 WRITE FENCE (see _write-fence.js): KV reads can be stale, which made two devices merge from the same old copy and
    // the later write erase the other's sales. With D1 available, wait until the copy we read is at least as new as the last write, and
    // claim the next slot with one conditional upsert. Without D1 this is null and everything below is exactly the legacy behaviour.
    const fence = await fenceOpen(env, clientId);
    stored = await readStateRaw(env, stateKey(clientId));
    if (fence) {
      try { stored = await fenceWaitVisible(env, fence, () => readStateRaw(env, stateKey(clientId)), stored); }
      catch (e) { if (e && e.code === 'fence_busy') return busyResponse(cors, e); throw e; }
    }
    existing = stored ? JSON.parse(stored.text) : {};
    let incomingG = sanitizeMpesaPush(incomingBody).body;     // zip 340: M-PESA Agent entries that do not balance are dropped whoever sends them
    if (permAuth.enforce) {
      const g = guardPush(incomingG, (col, rec) => { const k = recordKey(rec), arr = existing[col]; return k != null && Array.isArray(arr) ? (arr.find((x) => recordKey(x) === k) || null) : null; }, permAuth);
      incomingG = g.body; heldNow = g.held;
    }

    // Correct for this device's clock drift BEFORE any merge comparison uses
    // its timestamps — see correctClockDrift() above.
    serverNow = Date.now();
    // A device that still holds (and re-sends) history the server already archived must not bring it back — see _state-store.js. Checked on the
    // push as SENT (zip 156): correcting a slow clock first moved an archived record's time past the archive cutoff and it slipped through.
    const fresh = await dropArchivedIncoming(env, clientId, incomingG, Number(existing._archiveCutoff) || 0, {
      serverNow, lastArchiveAt: Number(existing._lastAutoArchive && existing._lastAutoArchive.at) || 0,
    });
    body = correctClockDrift(fresh, serverNow);

    // Always stamp with the server's clock so all devices agree on ordering,
    // regardless of each device's local clock drift.
    // zip 185: never go backwards - two isolates with skewed clocks could stamp a later write EARLIER, and a device holding ?since=<the later stamp> then answered 'unchanged' and never saw it
    record = { ...mergeIncomingState(existing, body), updatedAt: Math.max(serverNow, (Number(existing.updatedAt) || 0) + 1) };

    // SIZE GUARD. A shop is one KV value (25 MiB hard cap) that this function reads, parses, merges and re-serialises
    // on every push. Past the cap `put` throws and the shop silently stops syncing while every till looks "offline".
    // So: measure first, refuse cleanly with a message the app can show, and tell the Owner Console. Nothing is lost —
    // the till keeps its data locally. Limits are environment-tunable (see _state-store.js). The refused push is
    // never written, so the last good server copy stays intact.
    jsonText = JSON.stringify(record);
    bytes = byteLength(jsonText);
    const policy = sizePolicy(env);

    // AUTOMATIC ARCHIVE: at 80% of the limit the shop trims itself — nobody has to notice or do anything. The newest 90 days
    // (or 60/30/14/7, whichever is the most that fits) stay live; the rest goes to a verified archive the owner can restore.
    // If archiving fails for any reason the push carries on unchanged (the size guard below is still the backstop).
    if (bytes >= policy.max * AUTO_ARCHIVE_AT) {
      try {
        const pick = chooseAutoCutoff(record, policy, serverNow);
        if (pick) {
          const done = await writeArchive(env, clientId, { old: pick.old, keepDays: pick.keepDays, cutoff: pick.cutoff, auto: true });
          record = {
            ...pick.keep, updatedAt: serverNow,
            _archiveCutoff: Math.max(Number(existing._archiveCutoff) || 0, pick.cutoff),
            _lastAutoArchive: { at: serverNow, keepDays: pick.keepDays, counts: done.counts, archiveId: done.archiveId },
          };
          jsonText = JSON.stringify(record);
          bytes = byteLength(jsonText);
        }
      } catch (e) { /* fall through: unchanged record, guard below */ }
    }
    if (bytes > policy.max) {
      await noteOversize(env, clientId, bytes, policy);
      return jsonResponse({
        error: `This shop's data is too large to sync (${(bytes / MIB).toFixed(1)} MB, limit ${(policy.max / MIB).toFixed(0)} MB). Your till still works and nothing is lost — please contact support to archive old history.`,
        code: 'shop_too_large', bytes, limit: policy.max,
      }, 413, cors);
    }

    // FORENSICS: keep the last few distinct sources that wrote this shop's data (IP + country), in KV metadata —
    // free, since it rides on the write we already make. Shown in the Owner Console's Storage tab.
    const writer = {
      ip: request.headers.get('CF-Connecting-IP') || '',
      cc: (request.cf && request.cf.country) || request.headers.get('CF-IPCountry') || '',
    };
    // zip 156: has another device's save landed since this one read the shop? Then merge again from what is stored now, instead of writing
    // over it. (Narrows the window to the write itself; only the shop database closes it — see autoMoveToDatabase.)
    let fenced = false;
    if (fence) {
      const claim = await fenceClaim(env, fence, stored);
      if (claim === true) fenced = true;
      else if (claim === false) {                                        // another device took the slot first: merge again on top of its write
        contended = true;
        if (++attempt >= 8) return busyResponse(cors, new Error('shop write slot kept changing'));
        await sleep(15 + Math.floor(Math.random() * 60));
        continue;
      }                                                                  // 'error' (D1 failed at the claim): legacy checks below
    }
    if (!fenced && attempt < 4 && env.SYNC_RECHECK_WRITE !== '0' && carriesRecords(body)) {      // a push with no records (a heartbeat, a setting) has little to lose: no extra read
      const nowStamp = await readStateStamp(env, stateKey(clientId));
      if (nowStamp !== stateStamp(stored && stored.meta)) { contended = true; attempt++; await sleep(20 + Math.floor(Math.random() * 80)); continue; }
    }
    try {
      const put = () => writeStateText(env, stateKey(clientId), jsonText, {
        bytes, keepCompressed: !!(stored && stored.gz), prevMeta: stored && stored.meta, writer, updatedAt: record.updatedAt, ver: fenced ? fence.nextVer : undefined, roomNoted: true,
      });
      if (fenced) {
        try { await withRetry(put, { tries: 4, baseMs: 600, maxMs: 1600, env }); }        // the slot is ours: retry the put itself rather than re-claiming
        catch (e) { await fenceRelease(env, fence); throw e; }
      } else await put();
      // zip 146 — VERIFY THE WRITE. Storage has no "write only if unchanged": two or three tills saving at the same moment each read the
      // shop, added their own sales and wrote it back — the LAST write won and the others' sales were silently gone from the server,
      // while those tills had been told "OK" and never sent them again (reproduced: 3 tills back online, only the last one's sales
      // kept). Read it back: if a sale this push carried is missing, another till's write landed on top — merge again and write again.
      if (!fenced && attempt < 5 && env.SYNC_VERIFY_WRITE !== '0' && carriesLogRecords(body)) {      // a push without sales etc. has nothing to lose
        await sleep(120 + Math.floor(Math.random() * 180));
        const after = await readStateRaw(env, stateKey(clientId));
        const lost = after ? pushLostRecords(body, JSON.parse(after.text)) : 0;   // body: after archived history was dropped
        if (lost > 0) { contended = true; attempt++; continue; }
      }
      break;
    } catch (e) {
      // Storage accepts about one write a second per shop: another device's save just landed. Wait a moment, then RE-READ and
      // re-merge (so that save is kept too) and write again.
      contended = true;
      if (++attempt >= 6) throw e;                     // zip 142: 6 tries (was 4) — three or four tills saving in the same second all get through
      await sleep(700 + Math.floor(Math.random() * 900));
    }
  }

  if (env.SHOP_STORE && (contended || activeDevices(record.deviceRegistry, serverNow) >= 2)) {
    context.waitUntil(autoMoveToDatabase(env, clientId, contended ? 'two saves at once' : 'several devices'));
  }

  // LIVE PUSH: broadcast the fresh record to every device currently
  // connected via WebSocket for this client (see sync-ws.js and SyncRoom in
  // wildcard-router/worker.js), so other devices update in well under a
  // second instead of waiting for their next 7-second poll. context.waitUntil
  // lets this finish after the response is already on its way back to the
  // caller, and the try/catch plus the SYNC_ROOM existence check mean a
  // missing binding, an undeployed Worker, or any other failure here is
  // always silent — the save itself must never be slowed down or fail
  // because of it, and every device's own poll is the fallback regardless.
  if (env.SYNC_ROOM) {
    try {
      const roomId = env.SYNC_ROOM.idFromName(clientId);
      const room = env.SYNC_ROOM.get(roomId);
      // zip 159: a big single-record shop used to push its WHOLE record (up to megabytes) to every connected device on every save, from the
      // Worker to the room and on to each socket. Above BROADCAST_MAX_BYTES a bare poke goes instead — devices that receive it pull the
      // record themselves (exactly what the database-mode path above already does), so nothing is lost and the fan-out stays small.
      const full = JSON.stringify({ ...stripTombstones(record), _ledger: 1 });
      const cap = Number(env.BROADCAST_MAX_BYTES) >= 0 && env.BROADCAST_MAX_BYTES != null && env.BROADCAST_MAX_BYTES !== '' ? Number(env.BROADCAST_MAX_BYTES) : 256 * 1024;
      context.waitUntil(
        room.fetch('https://sync-room/broadcast', {
          method: 'POST',
          body: full.length > cap ? JSON.stringify({ poke: true }) : full,
        }).catch(() => {})
      );
    } catch (e) {
      // Binding misconfigured or the DO call threw synchronously — ignore,
      // same reasoning as above.
    }
  }

  // The one deliberate exception to "schema-less by design" above: Owner
  // Console's Clients tab wants to show each client's real business name
  // (as entered during their own POS setup) instead of a raw slug, without
  // adding a per-client read to that list — see updateIndexBusinessName's
  // own comment in _license.js for the full reasoning. A no-op write (the
  // helper itself skips it) whenever this field is absent or unchanged.
  // Only when the name actually CHANGED. updateIndexBusinessName() reads and
  // parses the global index of EVERY client, so calling it on every push made
  // each sync cost more as the customer count grew — the biggest scaling wall
  // in this file. A rename is rare; an unchanged name now costs nothing.
  if (typeof body.businessName === 'string' && body.businessName !== ''
      && body.businessName !== existing.businessName) {
    await updateIndexBusinessName(env, clientId, body.businessName);
  }

  // The apps only ever read `updatedAt` from this reply, so don't send the whole shop back on every save.
  // (The full record still goes to other devices via the WebSocket broadcast and their next pull.)
  const till = typeof body._till === 'string' && record.tillNumbers ? record.tillNumbers[body._till] || 0 : 0;
  if (heldNow.length) { try { await secEvent(env, 'permission_held', { route: 'pos-sync', shop: clientId, ip: callerIpOf(request), detail: heldNow.map((h) => h.col + ':' + h.reason).slice(0, 3).join('; ').slice(0, 160) + ' by ' + String((permAuth.claims && permAuth.claims.name) || 'no staff session').slice(0, 30) }); } catch (e) { /* log only */ } }
  return jsonResponse({ ok: true, d1: led.skipped ? 0 : 1, ...(led.duplicates ? { duplicates: led.duplicates } : {}), ...ledgerHints(led), updatedAt: record.updatedAt, bytes, prev: existing.updatedAt || 0, ledger: 1, ...(heldNow.length ? { held: heldNow } : {}), ...(till ? { till } : {}) }, 200, cors);
}


// zip 327: "Reset app" on the server. Snapshots a backup first, then replaces the shop's record with { businessName, ownerName } plus a floor for every list
// (so a device that was offline cannot bring the old data back) and marks the D1 ledger's rows REMOVED / REVERSED (never deleted). Both backends.
async function handleWipeApp(context, { clientId, body, permAuth, cors }) {
  const { request, env } = context;
  const w = body._wipeApp;
  if (permAuth.enforce && !(permAuth.claims && permAuth.claims.mgr)) return jsonResponse({ error: 'Only a manager can reset the app.', code: 'manager_only' }, 403, cors);
  const id = String(w.id || ('w' + Date.now().toString(36))).slice(0, 64);
  const ownerName = String(w.ownerName || '').slice(0, 120);
  const pushMode = await shopMode(env, clientId);
  if (pushMode === 'migrating') return migratingResponse(cors);
  const at = Date.now();
  if (pushMode === 'do') {
    const got = await shopDbCall(env, clientId, 'wipe', { req: { id, confirm: w.confirm, ownerName }, serverNow: at });
    if (got.unavailable) return shopDbUnavailable(env, clientId, got.why, cors);
    const out = await got.res.json().catch(() => ({}));
    if (!got.res.ok || !out.ok) return jsonResponse({ error: out.error || 'Could not reset.', code: out.code || 'wipe_failed' }, out.code === 'name_mismatch' ? 403 : (got.res.status >= 400 ? got.res.status : 500), cors);
  } else {
    await maybeSnapshotBackup(env, clientId);
    const fence = await fenceOpen(env, clientId);
    let stored = await readStateRaw(env, stateKey(clientId));
    if (fence) { try { stored = await fenceWaitVisible(env, fence, () => readStateRaw(env, stateKey(clientId)), stored); } catch (e) { if (e && e.code === 'fence_busy') return busyResponse(cors, e); throw e; } }
    const existing = stored ? JSON.parse(stored.text) : {};
    const biz = String(existing.businessName || '').trim();
    if (!biz || String(w.confirm || '').trim() !== biz) return jsonResponse({ error: 'The business name does not match.', code: 'name_mismatch' }, 403, cors);
    const record = wipedState(existing, { id, at, ownerName });
    const jsonText = JSON.stringify(record);
    let fenced = false;
    if (fence) {
      const claim = await fenceClaim(env, fence, stored);
      if (claim === true) fenced = true; else if (claim === false) return busyResponse(cors, new Error('shop write slot kept changing'));
    }
    await writeStateText(env, stateKey(clientId), jsonText, { bytes: byteLength(jsonText), keepCompressed: !!(stored && stored.gz), prevMeta: stored && stored.meta, writer: { ip: request.headers.get('CF-Connecting-IP') || '', cc: '' }, updatedAt: record.updatedAt, ver: fenced ? fence.nextVer : undefined, roomNoted: true });
  }
  const lr = await ledgerReset(env, clientId, { id, at, fields: ['salesLog', 'bills'], voided: false });
  if (env.SYNC_ROOM) { try { const room = env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(clientId)); context.waitUntil(room.fetch('https://sync-room/broadcast', { method: 'POST', body: JSON.stringify({ poke: true }) }).catch(() => {})); } catch (e) { /* the poll is the fallback */ } }
  return jsonResponse({ ok: true, wiped: true, id, at, ledger: lr.ok ? (lr.skipped || 'marked') : 'pending' }, 200, cors);
}
