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
import { mergeIncomingState, correctClockDrift, MERGE_BY_ID_FIELDS, stripTombstones } from './_merge.js';
import {
  readStateRaw, readStateStored, decodeStateText, writeStateText, byteLength, sizePolicy, noteOversize, MIB,
  chooseAutoCutoff, writeArchive, dropArchivedIncoming, AUTO_ARCHIVE_AT, shopMode, shopCall, migratingResponse,
} from './_state-store.js';
import { deviceGuard } from './_device-auth.js';
import { stampSales } from './_staff-auth.js';

// CORS is decided per request (see _cors.js): the apps call this on their own origin, so only the shop's own
// domain family is ever answered — no more `Access-Control-Allow-Origin: *`.
function busyResponse(cors, e) {
  return new Response(JSON.stringify({ error: 'The server is busy — this device keeps its changes and sends them again in a moment.', code: 'busy', retryAfter: 2, detail: String((e && e.message) || e || '').slice(0, 160) }), {
    status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '2', ...cors },
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Devices that synced this shop in the last day (from the device list the server keeps — see noteDevice in _merge.js).
function activeDevices(reg, now) {
  if (!reg || typeof reg !== 'object') return 0;
  return Object.values(reg).filter((d) => d && Number(d.lastSeen) > now - 86400000).length;
}

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
    await env.mydukapos_kv.put(key, JSON.stringify({ at: Date.now(), why }), { expirationTtl: 6 * 3600 });
    const { migrateShopToDatabase } = await import('./_migrate.js');
    const r = await migrateShopToDatabase(env, clientId);
    await env.mydukapos_kv.put(key, JSON.stringify({ at: Date.now(), why, done: true, records: r.records || 0 }), { expirationTtl: 6 * 3600 });
  } catch (e) {
    try { await env.mydukapos_kv.put(key, JSON.stringify({ at: Date.now(), why, error: String(e && e.message || e).slice(0, 200) }), { expirationTtl: 6 * 3600 }); } catch (e2) { /* ignore */ }
  }
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
  const cur = await readStateRaw(env, stateKey(clientId));
  const existing = cur ? JSON.parse(cur.text) : {};
  const merged = { ...existing, ...patch, updatedAt: Date.now() };
  await writeStateText(env, stateKey(clientId), JSON.stringify(merged), { keepCompressed: !!(cur && cur.gz), prevMeta: cur && cur.meta, updatedAt: merged.updatedAt });
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeadersFor(context.request, context.env) });
}

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return busyResponse(corsHeadersFor(context.request, context.env), e);
  }
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
    const res = await shopCall(env, clientId, 'state', {
      since: Number(u.searchParams.get('since')) || 0,
      hotDays: hot === 'all' ? 'all' : (Number(hot) || undefined),
    });
    return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json', ...cors } });
  }

  const stored = await readStateStored(env, stateKey(clientId));

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

  // WHO MADE EACH SALE (zip 141): check each sale's staff signature and stamp what was found (see _staff-auth.js). Never refuses or
  // drops a sale; if the check itself fails the push goes ahead unstamped (shown as "not checked").
  try { await stampSales(env, clientId, body); } catch (e) { /* never block a sale */ }

  // DATABASE MODE: hand the push to the shop's own database. Its cost follows the size of THIS push, not of the shop, so there is
  // no size ceiling to guard (only a cap on one request, so a single push can't exhaust the Durable Object's memory).
  const pushMode = await shopMode(env, clientId);
  if (pushMode === 'migrating') return migratingResponse(cors);
  if (pushMode === 'do') {
    const maxPush = Number(env.SYNC_MAX_PUSH_BYTES) || 24 * 1048576;
    if (Number(request.headers.get('content-length')) > maxPush) {
      return jsonResponse({ error: 'This push is too large to accept in one go.', code: 'push_too_large' }, 413, cors);
    }
    let res = await shopCall(env, clientId, 'push', { body, serverNow: Date.now() });
    if (res.status >= 500) { await sleep(400 + Math.floor(Math.random() * 400)); res = await shopCall(env, clientId, 'push', { body, serverNow: Date.now() }); }   // one quick retry (zip 123)
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
    return jsonResponse({ ok: true, updatedAt: out.updatedAt, prev: out.prev, ...(out.ledger ? { ledger: out.ledger } : {}), ...(out.till ? { till: out.till } : {}) }, 200, cors);
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
    stored = await readStateRaw(env, stateKey(clientId));
    existing = stored ? JSON.parse(stored.text) : {};

    // Correct for this device's clock drift BEFORE any merge comparison uses
    // its timestamps — see correctClockDrift() above.
    serverNow = Date.now();
    body = correctClockDrift(incomingBody, serverNow);
    // A device that still holds (and re-sends) history the server already archived must not bring it back — see _state-store.js.
    body = await dropArchivedIncoming(env, clientId, body, Number(existing._archiveCutoff) || 0);

    // Always stamp with the server's clock so all devices agree on ordering,
    // regardless of each device's local clock drift.
    record = { ...mergeIncomingState(existing, body), updatedAt: serverNow };

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
    try {
      await writeStateText(env, stateKey(clientId), jsonText, {
        bytes, keepCompressed: !!(stored && stored.gz), prevMeta: stored && stored.meta, writer, updatedAt: record.updatedAt,
      });
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
      context.waitUntil(
        room.fetch('https://sync-room/broadcast', {
          method: 'POST',
          body: JSON.stringify({ ...stripTombstones(record), _ledger: 1 }),
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
  return jsonResponse({ ok: true, updatedAt: record.updatedAt, bytes, prev: existing.updatedAt || 0, ledger: 1, ...(till ? { till } : {}) }, 200, cors);
}
